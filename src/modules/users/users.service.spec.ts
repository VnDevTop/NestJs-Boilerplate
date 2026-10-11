import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authUserKey } from '../../core/cache/index.js';
import { UsersService, type AuthClaims } from './users.service.js';
import type { User } from './entities/index.js';

/**
 * The cache is only worth having if the write that revokes still reaches the next
 * request. So the tests below are mostly about ordering: what gets dropped, and
 * whether it is dropped before or after the transaction that changed it.
 */

const CONFIG = { authUserTtl: 60 };

/**
 * A stand-in for `CacheService` that behaves like the real one on the point that
 * matters here: a miss runs the loader, a hit does not, and a `null` from the
 * loader is a value rather than a miss.
 */
function fakeCache() {
  const store = new Map<string, unknown>();
  const deleted: string[] = [];
  let calls = 0;

  return {
    store,
    deleted,
    get calls() {
      return calls;
    },
    wrap: vi.fn(
      async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
        calls += 1;

        if (store.has(key)) {
          return store.get(key) as T;
        }

        const value = await loader();
        store.set(key, value);

        return value;
      },
    ),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
      store.delete(key);
    }),
    deleteKeys: vi.fn(async (...keys: string[]) => {
      deleted.push(...keys);
      for (const key of keys) {
        store.delete(key);
      }
    }),
  };
}

const ROW = {
  id: 'u1',
  email: 'a@x.com',
  role: 'admin',
  isManager: true,
  isActive: true,
  sessionsVersion: 3,
  isEmailVerified: true,
  lockedAt: null,
  // Present on purpose: the projection must not carry it, and a fake that
  // omitted it would let a regression pass unnoticed.
  password: '$2b$10$notarealhashnotarealhashnotareal',
} as unknown as User;

function harness(options: { rows?: (User | null)[] } = {}) {
  const rows = options.rows ?? [ROW];
  const findOne = vi.fn(
    async (_options?: { select?: Record<string, boolean> }) =>
      rows.shift() ?? null,
  );
  const save = vi.fn(async (value: Partial<User>) => value as User);
  const softDelete = vi.fn().mockResolvedValue({ affected: 1 });
  const merge = vi.fn((user: User, dto: Partial<User>) => ({
    ...user,
    ...dto,
  }));
  const cache = fakeCache();

  const notify = vi.fn(async () => ({ notificationId: 'n1', queued: true }));

  const service = new UsersService(
    { findOne, save, softDelete, merge } as never,
    cache as never,
    { getOrThrow: () => CONFIG } as never,
    { notify } as never,
  );

  return { service, cache, findOne, save, softDelete, merge, notify };
}

/** A row with the lock fields set, for the cases that need one. */
function user(overrides: Partial<User> = {}): User {
  return { ...ROW, ...overrides } as User;
}

const CACHE_KEY = authUserKey('u1');

describe('findAuthClaims', () => {
  it('reads through the cache under the user key', async () => {
    const h = harness();

    await h.service.findAuthClaims('u1');

    expect(h.cache.wrap).toHaveBeenCalledWith('user:u1', expect.any(Function), {
      ttl: 60,
    });
  });

  it('serves a hit without touching the database', async () => {
    // The whole point of the phase: the second request in a window costs no query.
    const h = harness();

    await h.service.findAuthClaims('u1');
    await h.service.findAuthClaims('u1');

    expect(h.findOne).toHaveBeenCalledTimes(1);
  });

  it('never carries the password hash', async () => {
    // The row in the fake has one. A cache holding bcrypt hashes turns a redis
    // compromise into offline cracking material for every account.
    const h = harness();

    const claims = await h.service.findAuthClaims('u1');

    expect(claims).not.toBeNull();
    expect(claims).not.toHaveProperty('password');
    expect(JSON.stringify(claims)).not.toContain('notarealhash');
  });

  it('selects only the claim columns, so the hash is never read at all', async () => {
    const h = harness();

    await h.service.findAuthClaims('u1');

    const options = h.findOne.mock.calls[0]?.[0] ?? {};
    expect(options.select).toEqual({
      id: true,
      email: true,
      role: true,
      isManager: true,
      isActive: true,
      sessionsVersion: true,
      isEmailVerified: true,
      lockedAt: true,
    });
    expect(options.select).not.toHaveProperty('password');
  });

  it('caches the projection rather than the entity', async () => {
    const h = harness();

    await h.service.findAuthClaims('u1');

    expect(h.cache.store.get(CACHE_KEY)).toEqual<AuthClaims>({
      id: 'u1',
      email: 'a@x.com',
      role: 'admin',
      isManager: true,
      isActive: true,
      sessionsVersion: 3,
      isEmailVerified: true,
      lockedAt: null,
    });
  });

  it('carries the verification flag, because the gate reads it from here', async () => {
    // Not a claim: confirming an address must take effect on the next request
    // rather than when a fifteen minute token expires.
    const h = harness();

    await expect(h.service.findAuthClaims('u1')).resolves.toMatchObject({
      isEmailVerified: true,
    });
  });

  it('carries an unverified flag rather than omitting it', async () => {
    // `undefined` would be falsy, so a gate would refuse the user either way — but
    // the projection is a stated contract and an absent field is not `false`.
    const h = harness({
      rows: [{ ...ROW, isEmailVerified: false } as unknown as User],
    });

    await expect(h.service.findAuthClaims('u1')).resolves.toMatchObject({
      isEmailVerified: false,
    });
  });

  it('reads a row predating the sessions column as version zero', async () => {
    // Otherwise every token from a database the migration has not touched is
    // refused, because `undefined` compares unequal to zero.
    const h = harness({
      rows: [{ ...ROW, sessionsVersion: undefined } as unknown as User],
    });

    const claims = await h.service.findAuthClaims('u1');

    expect(claims?.sessionsVersion).toBe(0);
  });

  it('answers null for a user that does not exist', async () => {
    const h = harness({ rows: [null] });

    await expect(h.service.findAuthClaims('u1')).resolves.toBeNull();
  });

  it('caches a missing user, so the stream of misses stops querying', async () => {
    const h = harness({ rows: [null] });

    await h.service.findAuthClaims('u1');
    await h.service.findAuthClaims('u1');

    expect(h.findOne).toHaveBeenCalledTimes(1);
  });

  it('adds no catch of its own, so fail-open stays where it belongs', async () => {
    // cache-manager turns a failing store into a miss, which is the whole
    // failover story. A try/catch here would also swallow a genuine failure from
    // the loader, so the outage would look like a working request that silently
    // authenticated nobody.
    const h = harness();
    h.cache.wrap.mockRejectedValueOnce(new Error('redis unreachable'));

    await expect(h.service.findAuthClaims('u1')).rejects.toThrow(
      'redis unreachable',
    );
  });

  it('still answers when the cache reports a miss', async () => {
    // The other half of the same contract: a miss is a miss, and the loader runs.
    const h = harness();

    await expect(h.service.findAuthClaims('u1')).resolves.toMatchObject({
      id: 'u1',
    });
    expect(h.findOne).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateAuthCache', () => {
  it('drops the claims and the device versions together', async () => {
    // A token that presents a device reads both keys. Dropping the claims alone
    // would leave a revoked device looking valid to the very next request.
    const h = harness();

    await h.service.invalidateAuthCache('u1');

    expect(h.cache.deleteKeys).toHaveBeenCalledWith(
      'user:u1',
      'user:u1:devices',
    );
  });

  it('forces the next claim read back to the database', async () => {
    const h = harness();

    await h.service.findAuthClaims('u1');
    await h.service.invalidateAuthCache('u1');
    await h.service.findAuthClaims('u1');

    expect(h.findOne).toHaveBeenCalledTimes(2);
  });
});

describe('runThenInvalidateAuthCache', () => {
  it('runs the work before dropping the entry', async () => {
    // The ordering is the property. Deleting inside the transaction lets a request
    // in between repopulate the entry from the old, uncommitted snapshot.
    const h = harness();
    const order: string[] = [];
    h.cache.deleteKeys.mockImplementation(async () => {
      order.push('invalidate');
    });

    await h.service.runThenInvalidateAuthCache('u1', async () => {
      order.push('commit');
    });

    expect(order).toEqual(['commit', 'invalidate']);
  });

  it('returns what the work returned', async () => {
    const h = harness();

    await expect(
      h.service.runThenInvalidateAuthCache('u1', async () => 'saved'),
    ).resolves.toBe('saved');
  });

  it('still drops the entry when the work throws', async () => {
    // A rolled back transaction leaves a stale entry behind with nobody left to
    // delete it, and that entry outlives the token it wrongly admitted.
    const h = harness();

    await expect(
      h.service.runThenInvalidateAuthCache('u1', async () => {
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(h.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });

  it('does not drop the entry when the work never ran', async () => {
    const h = harness();
    h.cache.delete.mockClear();

    await h.service.runThenInvalidateAuthCache('u1', async () => 'fine');

    expect(h.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });
});

describe('the writes that move an authentication answer', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('drops the entry when a user is updated', async () => {
    // A demotion that never reaches the cache is an escalation that lasts a
    // minute, which is longer than the token it would let through.
    await h.service.update('u1', { role: 'user' } as never);

    expect(h.cache.deleted).toContain('user:u1');
  });

  it('drops the entry when a user is soft deleted', async () => {
    // A soft delete leaves `isActive` alone, so nothing downstream would notice
    // unless the cache is dropped.
    await h.service.softDelete('u1');

    expect(h.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });

  it('drops the entry even when the update changed nothing a claim holds', async () => {
    // Deliberate. Checking the diff would put the check in the one place where
    // forgetting it silently keeps a revoked role in force.
    await h.service.update('u1', { firstName: 'Ada' } as never);

    expect(h.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });

  it('drops the entry when an account is locked', async () => {
    // The cached claims carry `lockedAt`, so a lock that never reached the cache
    // would leave the strategy accepting the account for a full TTL.
    await h.service.lockAccount('u1', '20 failed sign-in attempts');

    expect(h.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });

  it('drops the entry when an account is unlocked', async () => {
    // Locked in the row, because an account that is not locked returns early and
    // this would pass on a no-op — asserting nothing about the cache drop it was
    // written to catch.
    const locked = harness({
      rows: [user({ lockedAt: new Date('2026-02-01T00:00:00Z') })],
    });

    await locked.service.unlockAccount('u1', 'admin@x.com');

    expect(locked.cache.deleted).toEqual(['user:u1', 'user:u1:devices']);
  });
});

describe('locking an account', () => {
  it('records the time and the reason', async () => {
    // An operator opening the row has to see *why* without reading the log, and a
    // reason rendered on demand would change under a deploy and make an old lock
    // unreadable.
    const h = harness();

    await h.service.lockAccount(
      'u1',
      '20 failed sign-in attempts within 24 hours',
    );

    expect(h.merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lockReason: '20 failed sign-in attempts within 24 hours',
        lockedAt: expect.any(Date),
      }),
    );
  });

  it('bumps the sessions version, which is what actually ends the sessions', async () => {
    // Every access token already issued carries the version it was minted under,
    // so a bump refuses all of them at once. Without it the account keeps working
    // until its longest-lived refresh chain runs out, which is the whole attack the
    // lockout exists to stop.
    const h = harness();

    await h.service.lockAccount('u1', 'because');

    expect(h.merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionsVersion: ROW.sessionsVersion + 1 }),
    );
  });

  it('tells the operators', async () => {
    // A lock nobody was told about is the kind of thing that gets discovered by the
    // user rather than by the person who could have stopped it.
    const h = harness();

    await h.service.lockAccount('u1', 'because');

    expect(h.notify).toHaveBeenCalledWith(
      'auth.account.locked',
      expect.objectContaining({ email: 'a@x.com', reason: 'because' }),
      { userId: 'u1' },
    );
  });

  it('does not notify before the row is written', async () => {
    // The notification says the account is locked, and a webhook slow enough for
    // the request to be answered first must not describe a state the database has
    // not reached.
    const h = harness();
    const order: string[] = [];

    h.save.mockImplementation(async (value: Partial<User>) => {
      order.push('save');

      return value as User;
    });
    h.notify.mockImplementation(async () => {
      order.push('notify');

      return { notificationId: 'n1', queued: true };
    });

    await h.service.lockAccount('u1', 'because');

    expect(order).toEqual(['save', 'notify']);
  });

  it('writes once when two attempts cross the threshold together', async () => {
    // Two requests can read the same failure count and both believe they are the
    // one that crossed it. The second must not overwrite the timestamp and reason
    // the owner is reading right now, and must not send a second mail.
    const h = harness({
      rows: [user({ lockedAt: new Date('2026-02-01T00:00:00Z') })],
    });

    await h.service.lockAccount('u1', 'a second reason');

    expect(h.save).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('returns the account it found rather than erroring, for the same reason', async () => {
    const h = harness({
      rows: [user({ lockedAt: new Date('2026-02-01T00:00:00Z') })],
    });

    await expect(h.service.lockAccount('u1', 'x')).resolves.toMatchObject({
      lockedAt: new Date('2026-02-01T00:00:00Z'),
    });
  });

  it('refuses an id with no row', async () => {
    const h = harness({ rows: [null] });

    await expect(h.service.lockAccount('u1', 'because')).rejects.toThrow(
      'User not found',
    );
  });
});

describe('unlocking an account', () => {
  it('clears the time and the reason', async () => {
    const h = harness({
      rows: [
        user({
          lockedAt: new Date('2026-02-01T00:00:00Z'),
          lockReason: 'because',
        }),
      ],
    });

    await h.service.unlockAccount('u1', 'admin@x.com');

    expect(h.merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockedAt: null, lockReason: null }),
    );
  });

  it('does not bump the sessions version again', async () => {
    // The lock already killed every session. A second bump here would sign the
    // person out of the very session they had just recovered.
    const h = harness({
      rows: [
        user({
          lockedAt: new Date('2026-02-01T00:00:00Z'),
          sessionsVersion: 4,
        }),
      ],
    });

    await h.service.unlockAccount('u1', 'admin@x.com');

    expect(h.merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ sessionsVersion: expect.anything() }),
    );
  });

  it('is a no-op on an account that is not locked', async () => {
    // An unlock link can be clicked twice by an anxious user.
    const h = harness();

    await h.service.unlockAccount('u1', 'admin@x.com');

    expect(h.save).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('names who did it, because the two callers are not the same person', async () => {
    // An operator watching the channel and the owner watching their inbox need
    // different sentences out of the same event.
    const h = harness({
      rows: [user({ lockedAt: new Date('2026-02-01T00:00:00Z') })],
    });

    await h.service.unlockAccount('u1', 'admin@x.com');

    expect(h.notify).toHaveBeenCalledWith(
      'auth.account.unlocked',
      { email: 'a@x.com', actor: 'admin@x.com' },
      { userId: 'u1' },
    );
  });
});
