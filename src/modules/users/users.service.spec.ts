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
  };
}

const ROW = {
  id: 'u1',
  email: 'a@x.com',
  role: 'admin',
  isManager: true,
  isActive: true,
  sessionsVersion: 3,
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

  const service = new UsersService(
    { findOne, save, softDelete, merge } as never,
    cache as never,
    { getOrThrow: () => CONFIG } as never,
  );

  return { service, cache, findOne, save, softDelete, merge };
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
  it('drops exactly one key', async () => {
    const h = harness();

    await h.service.invalidateAuthCache('u1');

    expect(h.cache.delete).toHaveBeenCalledWith('user:u1');
  });

  it('forces the next request back to the database', async () => {
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
    h.cache.delete.mockImplementation(async () => {
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

    expect(h.cache.deleted).toEqual(['user:u1']);
  });

  it('does not drop the entry when the work never ran', async () => {
    const h = harness();
    h.cache.delete.mockClear();

    await h.service.runThenInvalidateAuthCache('u1', async () => 'fine');

    expect(h.cache.deleted).toEqual(['user:u1']);
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

    expect(h.cache.deleted).toEqual(['user:u1']);
  });

  it('drops the entry even when the update changed nothing a claim holds', async () => {
    // Deliberate. Checking the diff would put the check in the one place where
    // forgetting it silently keeps a revoked role in force.
    await h.service.update('u1', { firstName: 'Ada' } as never);

    expect(h.cache.deleted).toEqual(['user:u1']);
  });
});
