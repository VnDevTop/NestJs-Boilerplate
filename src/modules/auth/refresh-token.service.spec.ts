import { NotFoundException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RefreshTokenRevokedReason } from './enums/index.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import { RefreshTokenService as Svc } from './refresh-token.service.js';

const repository = {
  find: vi.fn(),
  update: vi.fn(),
  createQueryBuilder: () => queryBuilder.builder,
};

/**
 * Stands in for the update query builder `revokeByIdForUser` drives.
 *
 * `Repository.update(criteria, partial)` could not answer the question this now
 * asks, because it returns no rows and the caller needs the `jti` of the row it
 * just revoked.
 */
function fakeQueryBuilder(
  options: { affected?: number; raw?: unknown[] } = {},
) {
  const state = {
    set: {} as Record<string, unknown>,
    where: {} as Record<string, unknown>,
    returning: '',
  };

  const builder = {
    update: vi.fn(() => builder),
    set: vi.fn((values: Record<string, unknown>) => {
      Object.assign(state.set, values);
      return builder;
    }),
    where: vi.fn((criteria: Record<string, unknown>) => {
      Object.assign(state.where, criteria);
      return builder;
    }),
    returning: vi.fn((column: string) => {
      state.returning = column;
      return builder;
    }),
    execute: vi.fn(async () => ({
      affected: options.affected ?? 1,
      raw: options.raw ?? [{ jti: 'jti-1' }],
    })),
  };

  return { builder, state };
}

const dataSource = {};
/**
 * A signer that reports a lifetime, so the revocation entry is measured against
 * something rather than a hardcoded number.
 */
const jwtService = {
  signAsync: vi.fn(async () => 'probe'),
  decode: vi.fn(() => ({ iat: 1_000_000, exp: 1_000_000 + 900 })),
};
const configService = {
  getOrThrow: vi.fn(),
  get: vi.fn((key: string) =>
    key === 'jwtAccessToken'
      ? { signOptions: { expiresIn: '15m' } }
      : undefined,
  ),
};

/** Records what was written, and answers as a miss until something is. */
function fakeCache() {
  const store = new Map<string, unknown>();
  const writes: {
    key: string;
    value: unknown;
    ttl?: number;
    exactTtl?: boolean;
  }[] = [];

  return {
    store,
    writes,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown, options = {}) => {
      writes.push({ key, value, ...options });
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const cache = fakeCache();
let queryBuilder = fakeQueryBuilder();

function harness(): RefreshTokenService {
  return new Svc(
    repository as never,
    dataSource as never,
    jwtService as never,
    configService as never,
    cache as never,
  );
}

describe('RefreshTokenService sessions', () => {
  let service: RefreshTokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-established here because `clearAllMocks` drops queued one-shot
    // behaviours, and a rejected `signAsync` left over from an earlier test would
    // make the lifetime fall back in a test that is not about the fallback.
    jwtService.signAsync.mockResolvedValue('probe');
    jwtService.decode.mockReturnValue({ iat: 1_000_000, exp: 1_000_900 });
    cache.store.clear();
    cache.writes.length = 0;
    repository.find.mockResolvedValue([]);
    repository.update.mockResolvedValue({ affected: 1 });
    queryBuilder = fakeQueryBuilder();
    service = harness();
  });

  describe('listLiveByUserId', () => {
    it('returns only rows that are neither revoked nor expired', async () => {
      await service.listLiveByUserId('u1');

      const where = repository.find.mock.calls[0][0].where;

      // A revoked or expired row is not a session. Listing it invites a revoke
      // call that reports success and does nothing.
      expect(where.userId).toBe('u1');
      expect(where).toHaveProperty('revokedAt');
      expect(where).toHaveProperty('expiresAt');
    });

    it('newest first, so the current sign-in is at the top', async () => {
      await service.listLiveByUserId('u1');

      expect(repository.find.mock.calls[0][0].order).toEqual({
        createdAt: 'DESC',
      });
    });

    it('is scoped to one user', async () => {
      await service.listLiveByUserId('u1');

      expect(repository.find.mock.calls[0][0].where.userId).toBe('u1');
    });
  });

  describe('revokeByIdForUser', () => {
    it('revokes the row and records why', async () => {
      await service.revokeByIdForUser(
        'u1',
        's1',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      expect(queryBuilder.state.where.id).toBe('s1');
      expect(queryBuilder.state.set.revokedReason).toBe(
        RefreshTokenRevokedReason.SessionRevoked,
      );
      expect(queryBuilder.state.set.revokedAt).toBeInstanceOf(Date);
    });

    it('scopes the lookup to the owner, so an id from another account cannot be revoked', async () => {
      // The threat is a caller who learned somebody else's session id. Scoping by
      // owner is the only thing standing between a guess and someone's logout.
      await service.revokeByIdForUser(
        'u1',
        'someone-elses',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      expect(queryBuilder.state.where).toMatchObject({
        id: 'someone-elses',
        userId: 'u1',
      });
    });

    it('only touches a row that is still live, so a race cannot double-report', async () => {
      await service.revokeByIdForUser(
        'u1',
        's1',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      // `revokedAt: IsNull()` in the criteria is what makes the update
      // conditional. Without it two requests both "succeed" and the second
      // overwrites the first's reason.
      expect(queryBuilder.state.where).toHaveProperty('revokedAt');
    });

    it('throws a 404 when nothing matched', async () => {
      queryBuilder = fakeQueryBuilder({ affected: 0, raw: [] });

      await expect(
        service.revokeByIdForUser(
          'u1',
          'gone',
          RefreshTokenRevokedReason.SessionRevoked,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not distinguish "not yours" from "does not exist"', async () => {
      queryBuilder = fakeQueryBuilder({ affected: 0, raw: [] });

      // Answering "that is not your session" would confirm the id is real, which
      // is the only thing an attacker guessing ids wants to learn.
      //
      // Compared against an exception instance rather than a string, because
      // `toThrow('Session not found')` is a substring match: appending
      // ", or not yours" would have passed it and leaked exactly what this test
      // is here to prevent.
      await expect(
        service.revokeByIdForUser(
          'u1',
          'guess',
          RefreshTokenRevokedReason.SessionRevoked,
        ),
      ).rejects.toThrow(new NotFoundException('Session not found'));
    });
  });

  describe('revokeByIdForUser returns the jti', () => {
    it('hands back the session the access token will name', async () => {
      const jti = await service.revokeByIdForUser(
        'u1',
        's1',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      expect(jti).toBe('jti-1');
    });

    it('asks for the jti back rather than guessing it', async () => {
      await service.revokeByIdForUser(
        'u1',
        's1',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      expect(queryBuilder.state.returning).toBe('jti');
    });

    it('reports rather than defaulting when the row came back without one', async () => {
      // The session is revoked in the database but its access token is not
      // stopped. Returning the row id as a stand-in would silently produce a
      // revocation that never matches anything.
      queryBuilder = fakeQueryBuilder({ affected: 1, raw: [{}] });

      await expect(
        service.revokeByIdForUser(
          'u1',
          's1',
          RefreshTokenRevokedReason.SessionRevoked,
        ),
      ).rejects.toThrow(/access token/);
    });
  });

  describe('a revoked session', () => {
    beforeEach(() => {
      jwtService.decode.mockReturnValue({ iat: 1_000_000, exp: 1_000_900 });
    });

    it('is refused once recorded, and accepted before', async () => {
      await expect(service.isSessionRevoked('jti-1')).resolves.toBe(false);

      await service.markSessionRevoked('jti-1');

      await expect(service.isSessionRevoked('jti-1')).resolves.toBe(true);
    });

    it('is written under its own key, not under the user', async () => {
      await service.markSessionRevoked('jti-1');

      expect(cache.writes[0]?.key).toBe('token:revoked:jti-1');
    });

    it('is held for the access token lifetime, exactly', async () => {
      // Not for the refresh token lifetime: a seven day entry would keep
      // accumulating. And exactly, because an entry that expires before the tokens
      // it revokes lets those tokens start working again. The jitter every other
      // entry gets exists to spread expirations, which buys nothing here and takes
      // up to a tenth of the window off the bottom.
      await service.markSessionRevoked('jti-1');

      expect(cache.writes[0]).toMatchObject({
        ttl: 900,
        exactTtl: true,
      });
    });

    it('takes the lifetime from the signer rather than parsing the config', async () => {
      // `Number('15m')` is NaN, so a parsed lifetime would silently fall back for
      // every string format the JWT library accepts. A probe token cannot drift.
      jwtService.decode.mockReturnValue({ iat: 1_000_000, exp: 1_003_600 });

      await service.markSessionRevoked('jti-1');

      expect(cache.writes[0]?.ttl).toBe(3600);
    });

    it('falls back to a sane lifetime when the signer cannot answer', async () => {
      jwtService.signAsync.mockRejectedValueOnce(new Error('no secret'));

      await service.markSessionRevoked('jti-1');

      // Long rather than short on purpose: an entry that expires early lets the
      // tokens it revoked start working again.
      expect(cache.writes[0]?.ttl).toBe(900);
    });

    it('still records the revocation when the lifetime cannot be read', async () => {
      jwtService.signAsync.mockRejectedValueOnce(new Error('no secret'));

      await service.markSessionRevoked('jti-1');

      expect(cache.writes).toHaveLength(1);
      expect(await service.isSessionRevoked('jti-1')).toBe(true);
    });

    it('does not conflate two sessions', async () => {
      await service.markSessionRevoked('jti-1');

      await expect(service.isSessionRevoked('jti-2')).resolves.toBe(false);
    });

    it('is not stored as a cache of the database', async () => {
      // Every other cached answer about a user can be dropped and refilled. This
      // one cannot: there is no column to re-read it from, because a revoked
      // session is a `revokedAt` on a row nothing looks up by jti. Dropping it
      // would hand the session back on the next request.
      await service.markSessionRevoked('jti-1');

      expect(cache.set).toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });
  });
});
