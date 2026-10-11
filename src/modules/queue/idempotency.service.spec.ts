import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdempotencyService } from './idempotency.service.js';

/**
 * The store under an honest set of conditions, and then under an honest failure.
 *
 * The failure cases are the ones worth reading twice. Idempotency is a cache of
 * *whether work already happened*, so the natural instinct — take the same "the
 * cache is unavailable, treat it as a miss" path everything else in this codebase
 * takes — inverts the meaning of a miss into "this has never happened". That is
 * why this uses `RedisClientService` directly rather than `CacheService`, and why
 * the outage case is asserted rather than assumed.
 */

/** A redis double that answers the two shapes this service uses. */
function redisDouble(
  state: {
    reachable?: boolean;
    entries?: Map<string, { value: string; expiresAt: number }>;
  } = {},
) {
  const entries = state.entries ?? new Map();
  const reachable = state.reachable ?? true;
  const now = () => Date.now();

  const client = {
    get: vi.fn(async (key: string) => {
      const entry = entries.get(key);

      if (!entry) {
        return null;
      }

      if (entry.expiresAt <= now()) {
        entries.delete(key);

        return null;
      }

      return entry.value;
    }),
    set: vi.fn(
      async (key: string, value: string, options?: { EX?: number }) => {
        entries.set(key, {
          value,
          expiresAt: now() + (options?.EX ?? 0) * 1000,
        });

        return 'OK';
      },
    ),
    del: vi.fn(async (key: string) => (entries.delete(key) ? 1 : 0)),
  };

  // Mirrors `RedisClientService`: every primitive goes through it, and every one of
  // them applies the same key prefix. The prefix is elided here — one prefix rule,
  // in the class that owns it — but the *sharing* is what this double asserts: a
  // store that wrote through one primitive and read through another is the bug the
  // prefixed pair was written to prevent.
  const redis = {
    getClient: vi.fn(async () => {
      if (!reachable) {
        throw new Error('redis is unreachable');
      }

      return client;
    }),
    get: vi.fn(async (key: string) => {
      if (!reachable) {
        throw new Error('redis is unreachable');
      }

      return client.get(key);
    }),
    set: vi.fn(async (key: string, value: string, ttlSeconds: number) => {
      if (!reachable) {
        throw new Error('redis is unreachable');
      }

      return client.set(key, value, { EX: ttlSeconds });
    }),
    delete: vi.fn(async (key: string) => {
      if (!reachable) {
        throw new Error('redis is unreachable');
      }

      return client.del(key);
    }),
    setIfAbsent: vi.fn(
      async (key: string, value: string, ttlSeconds: number) => {
        if (!reachable) {
          throw new Error('redis is unreachable');
        }

        const existing = entries.get(key);

        if (existing && existing.expiresAt > now()) {
          return false;
        }

        entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });

        return true;
      },
    ),
  };

  return {
    service: new IdempotencyService(redis as never),
    client,
    redis,
    entries,
  };
}

describe('the first request', () => {
  it('claims the key and is told to do the work', async () => {
    const h = redisDouble();

    await expect(h.service.begin('k')).resolves.toBe('claimed');
  });

  it('leaves the key claimed while the work runs', async () => {
    // The second copy arriving mid-flight is the case this exists for, and it can
    // only be caught if the claim is written *before* the handler runs rather than
    // after it finishes.
    const h = redisDouble();

    await h.service.begin('k');

    await expect(h.service.begin('k')).resolves.toBe('pending');
  });
});

describe('a retry after the work finished', () => {
  it('is handed the recorded answer rather than doing the work again', async () => {
    const h = redisDouble();

    await h.service.begin('k');
    await h.service.complete('k', { status: 201, body: '{"id":"u1"}' });

    const claim = await h.service.begin('k');

    expect(claim).toMatchObject({
      state: 'complete',
      status: 201,
      body: '{"id":"u1"}',
    });
  });

  it('survives a completed entry outliving the in-flight one', async () => {
    // The two have deliberately different lifetimes: a minute to catch a duplicate,
    // a day to serve a client that was offline. If `complete` did not extend the
    // ttl, every retry more than a minute after the first request would run the
    // work again — which is the failure this feature exists to prevent, appearing
    // only in production.
    const h = redisDouble();

    await h.service.begin('k', 60);
    await h.service.complete('k', { status: 200, body: '{}' }, 86_400);

    expect(h.client.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { EX: 86_400 },
    );
  });

  it('stores no body for a 204, so the replay is an empty 204', async () => {
    const h = redisDouble();

    await h.service.begin('k');
    await h.service.complete('k', { status: 204 });

    await expect(h.service.begin('k')).resolves.toMatchObject({
      status: 204,
    });
    expect(
      (await h.service.begin('k')) as { body?: string },
    ).not.toHaveProperty('body');
  });
});

describe('an expired in-flight claim', () => {
  it('lets the work happen rather than answering "still running" forever', async () => {
    // A request wedged for minutes must not hold its key for the whole completed
    // window. After the in-flight ttl the key is gone, and refusing would mean the
    // route is permanently 409 to a client that had one bad request.
    const h = redisDouble();

    await h.service.begin('k', 1);
    // The entry has expired; the fake evicts it on read, as redis would.
    h.entries.forEach((entry) => {
      entry.expiresAt = Date.now() - 1;
    });

    await expect(h.service.begin('k', 1)).resolves.toBe('claimed');
  });
});

describe('when redis cannot be reached', () => {
  it('says so, rather than reporting the key as free', async () => {
    // The dangerous answer here would be `'claimed'`. It means "nobody has used
    // this key, do the work" — and on a broken store that is a guess that is wrong
    // exactly when it matters most.
    const h = redisDouble({ reachable: false });

    await expect(h.service.begin('k')).resolves.toBeNull();
  });

  it('records nothing on completion', async () => {
    const h = redisDouble({ reachable: false });

    await expect(
      h.service.complete('k', { status: 200, body: '{}' }),
    ).resolves.toBeUndefined();
  });

  it('releases nothing on failure', async () => {
    const h = redisDouble({ reachable: false });

    await expect(h.service.release('k')).resolves.toBeUndefined();
  });

  it('does not throw, because the caller work still has to happen', async () => {
    // An exception here would turn a redis outage into a 500 on every mutating
    // request — trading a partial loss of a convenience guarantee for a total loss
    // of the product.
    const h = redisDouble({ reachable: false });

    await expect(h.service.begin('k')).resolves.not.toThrow();
  });
});

describe('a failed write after the work is done', () => {
  it('does not turn a successful request into a 500', async () => {
    // The work happened and the answer could not be recorded. A retry repeating the
    // work is the pre-existing behaviour; a 500 for a request that already
    // succeeded is not.
    const h = redisDouble();
    h.client.set.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      h.service.complete('k', { status: 200, body: '{}' }),
    ).resolves.toBeUndefined();
  });
});

describe('a value this service did not write', () => {
  it('is treated as a claim rather than parsed', async () => {
    // The store is shared with the queue and the throttle counters. An unreadable
    // value is corruption or another deployment's key, and either way the safe
    // answer is the one that lets the request proceed — refusing would let anybody
    // who can write a redis key take a route down.
    const h = redisDouble();
    // A real key, as the guard builds one — the fake stores under the name it is
    // given, so a hand-written key would sit somewhere the lookup never looks and
    // this would pass for the wrong reason.
    const key = IdempotencyService.buildKey('u1', 'POST', '/users', 'k1');

    h.entries.set(key, { value: 'not json', expiresAt: Date.now() + 1000 });

    await expect(h.service.begin(key)).resolves.toBe('pending');
  });

  it('is not mistaken for a completed answer', async () => {
    const h = redisDouble();
    const key = IdempotencyService.buildKey('u1', 'POST', '/users', 'k1');

    h.entries.set(key, {
      value: JSON.stringify({ state: 'complete' }),
      expiresAt: Date.now() + 1000,
    });

    const claim = await h.service.begin(key);

    expect(claim).not.toHaveProperty('status');
  });
});

describe('the key itself', () => {
  it('is scoped to the caller, the method and the route', async () => {
    // Without the caller, two users who generate the same key collide and one gets
    // the other's answer. Without the method, a retry of a delete replays a create.
    const build = IdempotencyService.buildKey;

    expect(build('u1', 'POST', '/users', 'k1')).not.toBe(
      build('u2', 'POST', '/users', 'k1'),
    );
    expect(build('u1', 'POST', '/users', 'k1')).not.toBe(
      build('u1', 'DELETE', '/users', 'k1'),
    );
    expect(build('u1', 'POST', '/users', 'k1')).not.toBe(
      build('u1', 'POST', '/roles', 'k1'),
    );
  });

  it('is stable, so a retry finds the entry the first one wrote', () => {
    const build = IdempotencyService.buildKey;

    expect(build('u1', 'POST', '/users', 'k1')).toBe(
      build('u1', 'POST', '/users', 'k1'),
    );
  });

  it('hashes the key supplied by the client rather than storing it', () => {
    // The client's key is attacker-controlled and unbounded. A 64KB redis key
    // written by a caller is a denial of service against an instance shared with
    // the queue.
    const key = IdempotencyService.buildKey(
      'u1',
      'POST',
      '/users',
      'x'.repeat(5000),
    );

    expect(key).not.toContain('xxxx');
    expect(key).toMatch(/^idem:u1:[0-9a-f]{64}$/);
    expect(key).toHaveLength('idem:u1:'.length + 64);
  });

  it('does not collide for two different client keys', () => {
    const build = IdempotencyService.buildKey;

    expect(build('u1', 'POST', '/users', 'k1')).not.toBe(
      build('u1', 'POST', '/users', 'k2'),
    );
  });

  it('hashes the same triple the same way a pinned digest does', () => {
    // Pinned so a refactor of the digest input cannot silently change every key in
    // flight, which would make every live retry look like a first request.
    const expected = createHash('sha256')
      .update('POST:/users:k1')
      .digest('hex');

    expect(IdempotencyService.buildKey('u1', 'POST', '/users', 'k1')).toBe(
      `idem:u1:${expected}`,
    );
  });
});

describe('releasing a claim', () => {
  let h: ReturnType<typeof redisDouble>;

  beforeEach(() => {
    h = redisDouble();
  });

  it('lets the next attempt start clean', async () => {
    // A request that threw must not hold its key for the in-flight window, or a
    // transient failure becomes a minute of 409 for a client that would have
    // succeeded on the second try.
    await h.service.begin('k');
    await h.service.release('k');

    await expect(h.service.begin('k')).resolves.toBe('claimed');
  });

  it('is harmless when the key was never claimed', async () => {
    await expect(h.service.release('never-used')).resolves.toBeUndefined();
  });
});
