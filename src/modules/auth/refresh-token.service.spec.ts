import { NotFoundException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RefreshTokenRevokedReason } from './enums/index.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import { RefreshTokenService as Svc } from './refresh-token.service.js';

const repository = {
  find: vi.fn(),
  update: vi.fn(),
};

const dataSource = {};
const jwtService = {};
const configService = { getOrThrow: vi.fn() };

function harness(): RefreshTokenService {
  return new Svc(
    repository as never,
    dataSource as never,
    jwtService as never,
    configService as never,
  );
}

describe('RefreshTokenService sessions', () => {
  let service: RefreshTokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    repository.find.mockResolvedValue([]);
    repository.update.mockResolvedValue({ affected: 1 });
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

      // `Repository.update(criteria, partial)`: the filter is the first argument.
      const [criteria, partial] = repository.update.mock.calls[0];

      expect(criteria.id).toBe('s1');
      expect(partial.revokedReason).toBe(
        RefreshTokenRevokedReason.SessionRevoked,
      );
      expect(partial.revokedAt).toBeInstanceOf(Date);
    });

    it('scopes the lookup to the owner, so an id from another account cannot be revoked', async () => {
      // The threat is a caller who learned somebody else's session id. Scoping by
      // owner is the only thing standing between a guess and someone's logout.
      await service.revokeByIdForUser(
        'u1',
        'someone-elses',
        RefreshTokenRevokedReason.SessionRevoked,
      );

      expect(repository.update.mock.calls[0][0]).toMatchObject({
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
      expect(repository.update.mock.calls[0][0]).toHaveProperty('revokedAt');
    });

    it('throws a 404 when nothing matched', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.revokeByIdForUser(
          'u1',
          'gone',
          RefreshTokenRevokedReason.SessionRevoked,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not distinguish "not yours" from "does not exist"', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

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
});
