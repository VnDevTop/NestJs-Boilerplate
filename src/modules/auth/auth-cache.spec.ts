import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authUserKey } from '../../core/cache/index.js';
import type { JwtPayload } from '../../common/interfaces/index.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../users/entities/index.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

/**
 * The property the whole phase is judged on: **a revoked or changed caller is
 * refused on the very next request, without waiting an entry out.**
 *
 * `users.service.spec.ts` covers the cache in isolation and this one covers the
 * cache actually being consulted, so it wires the real `UsersService` and the real
 * `JwtStrategy` together over a store that behaves like redis — a `Map` behind
 * `get`/`set`/`delete`, so a `delete` really removes the entry rather than being a
 * recorded call.
 *
 * A mock at either end would pass with the invalidation removed, which is the
 * regression this exists to catch.
 */

const SECRET = 'a'.repeat(32);

type Row = {
  id: string;
  email: string;
  password: string;
  role: string;
  isActive: boolean;
  isManager: boolean;
  sessionsVersion: number;
};

/** Mutable, so a test can change the row the way an operator would. */
function harness(seed: Partial<Row> = {}) {
  const row: Row = {
    id: 'u1',
    email: 'a@x.com',
    password: '$2b$10$notarealhash',
    role: 'user',
    isActive: true,
    isManager: false,
    sessionsVersion: 0,
    ...seed,
  };

  const store = new Map<string, unknown>();
  const queries: unknown[][] = [];

  // TypeORM excludes a soft-deleted row from later reads because the entity
  // declares a delete date. Modelling that is the point: the cache is dropped
  // precisely so the next read asks the database again.
  let deletedAt: Date | null = null;

  const cache = {
    wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
      if (store.has(key)) {
        return store.get(key) as T;
      }

      const value = await loader();
      store.set(key, value);

      return value;
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    deleteKeys: async (...keys: string[]) => {
      for (const key of keys) {
        store.delete(key);
      }
    },
  };

  const repository = {
    findOne: vi.fn(async (options?: { select?: Record<string, boolean> }) => {
      if (deletedAt !== null) {
        return null;
      }

      // `findById` asks for the whole row and `findAuthClaims` asks for named
      // columns, so both shapes have to work.
      if (!options?.select) {
        return row;
      }

      queries.push(Object.keys(options.select));

      // The column list decides whether the hash is fetched, and a fake that
      // ignored it would let a regression put a password hash in redis through
      // every test below.
      return Object.keys(options.select).reduce<Record<string, unknown>>(
        (out, column) => {
          out[column] = row[column as keyof Row];
          return out;
        },
        {},
      ) as never;
    }),
    save: vi.fn(async (value: Partial<Row>) => {
      Object.assign(row, value);
      return row;
    }),
    merge: vi.fn((current: Row, dto: Partial<Row>) => ({ ...current, ...dto })),
    softDelete: vi.fn(async () => {
      deletedAt = new Date();
    }),
  };

  const usersService = new UsersService(
    repository as never,
    cache as never,
    { getOrThrow: () => ({ authUserTtl: 60, authRoleTtl: 600 }) } as never,
  );

  /** Device id to its session version, standing in for the cached map. */
  const deviceVersions: Record<string, number> = {};
  let deviceQueries = 0;

  const revokedSessions = new Set<string>();
  let sessionQueries = 0;

  const refreshTokenService = {
    isSessionRevoked: vi.fn(async (sid: string) => {
      sessionQueries += 1;
      return revokedSessions.has(sid);
    }),
    markSessionRevoked: vi.fn(async (sid: string) => {
      revokedSessions.add(sid);
    }),
  };

  const deviceService = {
    findSessionVersions: vi.fn(async () => {
      deviceQueries += 1;
      return { ...deviceVersions };
    }),
    revokeDeviceSessions: vi.fn(async (_userId: string, deviceId: string) => {
      deviceVersions[deviceId] = (deviceVersions[deviceId] ?? 0) + 1;
      await cache.deleteKeys(authUserKey('u1'), 'user:u1:devices');
    }),
  };

  const strategy = new JwtStrategy(
    { get: () => SECRET } as unknown as ConfigService,
    usersService,
    { forRole: vi.fn().mockResolvedValue(['user:read']) } as never,
    deviceService as never,
    refreshTokenService as never,
  );

  return {
    strategy,
    usersService,
    deviceService,
    revokedSessions,
    refreshTokenService,
    get sessionQueries() {
      return sessionQueries;
    },
    deviceVersions,
    get deviceQueries() {
      return deviceQueries;
    },
    row,
    store,
    queries,
    isDeleted: () => deletedAt !== null,
  };
}

const token = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u1',
  email: 'a@x.com',
  ...overrides,
});

describe('an authenticated request served from cache', () => {
  it('is accepted, and the second one costs no query', async () => {
    const h = harness();

    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toMatchObject({
      id: 'u1',
    });
    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toMatchObject({
      id: 'u1',
    });

    expect(h.queries).toHaveLength(1);
  });

  it('never fetched the password hash', async () => {
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));

    expect(h.queries[0]).not.toContain('password');
  });

  it('keys the entry on the user, not on the token', async () => {
    // Two tokens for one user share an entry, which is what makes a role change
    // observable to a session signed before it.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));
    await h.strategy.validate(token({ sv: 0, email: 'stale@x.com' }));

    expect([...h.store.keys()]).toEqual([authUserKey('u1')]);
  });
});

describe('a change made after the entry was written', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('deactivating a user is refused on the next request', async () => {
    await h.strategy.validate(token({ sv: 0 }));

    h.row.isActive = false;
    await h.usersService.invalidateAuthCache('u1');

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('a role change is seen by a session signed before it', async () => {
    // Through `update`, which is the path an admin screen takes, rather than a
    // direct invalidation, so the wiring between the two is covered. A demotion
    // that never reaches the cache is an escalation lasting the rest of the TTL.
    h = harness({ role: 'admin' });
    expect((await h.strategy.validate(token({ sv: 0 }))).role).toBe('admin');

    await h.usersService.update('u1', { role: 'user' } as never);

    expect((await h.strategy.validate(token({ sv: 0 }))).role).toBe('user');
  });

  it('a soft delete is refused on the next request', async () => {
    await h.strategy.validate(token({ sv: 0 }));

    await h.usersService.softDelete('u1');

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('logout everywhere', () => {
  it('kills an access token minted before it, on the next request', async () => {
    // The full loop: the token was minted at version 0, the account is bumped,
    // and the token that the cache would happily keep authorising is refused
    // because the cached claims moved with it.
    const h = harness();

    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toBeTruthy();

    h.row.sessionsVersion = 1;

    await h.usersService.runThenInvalidateAuthCache('u1', async () => {
      h.row.sessionsVersion += 1;
    });

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      'Invalid access token',
    );
  });

  it('reloads the version rather than serving the one it had', async () => {
    // The failure this guards is a cache entry that outlives the revocation, so
    // the assertion is on the query count as much as the outcome.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));
    h.row.sessionsVersion = 1;
    await h.usersService.invalidateAuthCache('u1');
    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow();

    expect(h.queries).toHaveLength(2);
  });

  it('does not survive a bump that ran inside the transaction', async () => {
    // Reproduces the race the ordering exists to prevent: an entry refilled from
    // the pre-commit row would carry the version being revoked.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));

    await h.usersService.runThenInvalidateAuthCache('u1', async () => {
      // Standing in for a request landing mid-transaction: it reads the old row
      // and caches it, and the delete has not happened yet.
      await h.strategy.validate(token({ sv: 0 }));
      h.row.sessionsVersion = 1;
    });

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      'Invalid access token',
    );
  });
});

describe('a device that signs out', () => {
  let h: ReturnType<typeof harness>;

  /** A second machine on the same account, which must survive. */
  const phone = { did: 'phone', dv: 0 };

  beforeEach(() => {
    h = harness();
    Object.assign(h.deviceVersions, { laptop: 0, phone: 0 });
  });

  it('kills the access token it was holding', async () => {
    // The whole reason the counter is per device. Before this, signing out
    // revoked only the refresh token and the access token in the caller's hand
    // worked for the rest of its fifteen minutes.
    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 0 })),
    ).resolves.toMatchObject({ id: 'u1' });

    await h.deviceService.revokeDeviceSessions('u1', 'laptop');

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 0 })),
    ).rejects.toThrow('Invalid access token');
  });

  it('leaves the other devices signed in', async () => {
    // The failure this avoids is the opposite mistake: bumping the account
    // version would revoke the phone as well.
    await h.deviceService.revokeDeviceSessions('u1', 'laptop');

    await expect(
      h.strategy.validate(token({ sv: 0, ...phone })),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('accepts a token minted after the sign-out, because it carries the new version', async () => {
    // Signing in again on the same browser reuses the device row, so the new token
    // is minted against the version the bump left behind. Refusing that would
    // make a device unable to sign back in.
    await h.deviceService.revokeDeviceSessions('u1', 'laptop');

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 1 })),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('refuses a token whose device has been deleted', async () => {
    // Absence is not "nothing to check". Retention removes devices with no live
    // refresh token, and treating that as a pass would let a token minted before
    // the deletion keep working for the rest of its lifetime.
    delete h.deviceVersions.laptop;

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 0 })),
    ).rejects.toThrow('Invalid access token');
  });

  it('refuses a revoked device even at a matching version', async () => {
    h.deviceVersions.laptop = 5;

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 5 })),
    ).resolves.toMatchObject({ id: 'u1' });

    await h.deviceService.revokeDeviceSessions('u1', 'laptop');

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 5 })),
    ).rejects.toThrow('Invalid access token');
  });

  it('ignores a token that names no device', async () => {
    // Every token minted before this claim existed, and therefore every signed-in
    // user at the moment of a deploy. Refusing them would sign everybody out over
    // a feature release.
    delete h.deviceVersions.laptop;

    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('compares a device-less version against zero', async () => {
    // A token carrying `did` but no `dv` came from a database without the column.
    // The rule matches the account claim: accepted while nothing has been revoked
    // from the device.
    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop' })),
    ).resolves.toMatchObject({ id: 'u1' });

    h.deviceVersions.laptop = 1;

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop' })),
    ).rejects.toThrow('Invalid access token');
  });

  it('does not spend a query on a token that names no device', async () => {
    await h.strategy.validate(token({ sv: 0 }));

    expect(h.deviceQueries).toBe(0);
  });
});

describe('a session that is revoked', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
    Object.assign(h.deviceVersions, { laptop: 0, phone: 0 });
  });

  it('kills the access token already minted from it', async () => {
    // The hole this closes: `DELETE /auth/sessions/:id` revoked the refresh token,
    // so the session came back on the next refresh, and the access token in the
    // caller's hand kept working until it expired on its own.
    const live = token({ sv: 0, did: 'laptop', dv: 0, sid: 'sess-1' });

    await expect(h.strategy.validate(live)).resolves.toMatchObject({
      id: 'u1',
    });

    h.revokedSessions.add('sess-1');

    await expect(h.strategy.validate(live)).rejects.toThrow(
      'Invalid access token',
    );
  });

  it('leaves the other sessions on the same device alone', async () => {
    // The distinction from `devices/:id`, which takes the whole machine. Two
    // browsers on one laptop are two sessions and revoking one must not touch
    // the other.
    Object.assign(h.deviceVersions, { laptop: 0 });

    h.revokedSessions.add('sess-1');

    await expect(
      h.strategy.validate(
        token({ sv: 0, did: 'laptop', dv: 0, sid: 'sess-2' }),
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('leaves the other devices alone', async () => {
    Object.assign(h.deviceVersions, { laptop: 0, phone: 0 });
    h.revokedSessions.add('sess-1');

    await expect(
      h.strategy.validate(token({ sv: 0, did: 'phone', dv: 0, sid: 'sess-2' })),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('ignores a token that names no session', async () => {
    // Every token minted before this claim existed. Reading an absent claim as
    // "revoked" would sign out every signed-in user on deploy.
    await expect(
      h.strategy.validate(token({ sv: 0, did: 'laptop', dv: 0 })),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('costs one cached read, not a query', async () => {
    await h.strategy.validate(
      token({ sv: 0, did: 'laptop', dv: 0, sid: 'sess-1' }),
    );

    expect(h.sessionQueries).toBe(1);
    expect(h.queries).toHaveLength(1);
  });

  it('is checked after the device, so a revoked device is refused either way', async () => {
    // Both are refused, so the order is invisible in the response. What it does
    // decide is which cache is consulted, and the device map is the one that
    // answers for a token that never named a session.
    Object.assign(h.deviceVersions, { laptop: 2 });
    h.revokedSessions.add('sess-1');

    await expect(
      h.strategy.validate(
        token({ sv: 0, did: 'laptop', dv: 0, sid: 'sess-1' }),
      ),
    ).rejects.toThrow('Invalid access token');

    expect(h.sessionQueries).toBe(0);
  });
});
