import { Test } from '@nestjs/testing';
import { HealthCheckService, TerminusModule } from '@nestjs/terminus';

import { describe, expect, it } from 'vitest';

import { CacheHealthIndicator } from './cache.health.js';

/**
 * The property worth defending is the status string, because everything else
 * follows from it: `degraded` keeps the readiness probe green, `down` turns a
 * cache outage into an outage of the whole application.
 */

/** Runs the real indicator over a cache whose behaviour we choose. */
function overCache(behaviour: {
  writable?: boolean;
  readable?: unknown;
  throws?: Error;
}) {
  let stored: unknown;

  const cacheService = {
    set: async (_key: string, value: unknown) => {
      if (behaviour.throws) {
        throw behaviour.throws;
      }

      if (behaviour.writable === false) {
        return;
      }

      stored = value;
    },
    get: async () => {
      if (behaviour.throws) {
        throw behaviour.throws;
      }

      return behaviour.readable ?? stored;
    },
  };

  return new CacheHealthIndicator(cacheService as never);
}

describe('CacheHealthIndicator', () => {
  it('reports up when the value survives the round trip', async () => {
    await expect(overCache({}).isHealthy()).resolves.toEqual({
      cache: { status: 'up' },
    });
  });

  it('reports degraded, not down, when the value comes back different', async () => {
    // The trap this check exists for: cache-manager turns a failing store into a
    // miss, so a read alone cannot tell a dead cache from an empty one.
    const result = await overCache({ readable: 'something-else' }).isHealthy();

    expect(result).toEqual({
      cache: { status: 'degraded', reason: 'read back did not match' },
    });
  });

  it('reports degraded, not down, when the cache is unreachable', async () => {
    const result = await overCache({
      throws: new Error('ECONNREFUSED'),
    }).isHealthy();

    expect(result).toEqual({
      cache: { status: 'degraded', reason: 'cache is unreachable' },
    });
  });

  it('reports degraded when a write is silently dropped', async () => {
    // A store that accepts the command and stores nothing is the failure a
    // version check would catch and an acknowledgement would not.
    const result = await overCache({
      writable: false,
      readable: undefined,
    }).isHealthy();

    expect(result).toEqual({
      cache: { status: 'degraded', reason: 'read back did not match' },
    });
  });

  it('never returns down, because down removes the instance from rotation', async () => {
    // The assertion rather than a status string: a future edit to either branch
    // that reintroduces `down` fails here.
    const failures = [
      overCache({ throws: new Error('boom') }),
      overCache({ readable: 'wrong' }),
      overCache({ writable: false, readable: undefined }),
    ];

    for (const indicator of failures) {
      const result = await indicator.isHealthy();
      const status = Object.values(result)[0]?.status;

      expect(status).not.toBe('down');
    }
  });

  it('checks with a fresh value each time', async () => {
    // Reusing one value would let a stale entry satisfy the read, and a cache
    // holding the last check's value would pass forever.
    const seen: unknown[] = [];
    const cacheService = {
      set: async (_key: string, value: unknown) => {
        seen.push(value);
      },
      get: async () => seen.at(-1),
    };

    const indicator = new CacheHealthIndicator(cacheService as never);
    await indicator.isHealthy();
    await indicator.isHealthy();

    expect(seen[0]).not.toBe(seen[1]);
    expect(seen).toHaveLength(2);
  });

  it('writes a value under the health key, short lived', async () => {
    // The key and the lifetime are both load bearing: a value that outlives the
    // check would be a claim that the cache works, sitting in a cache that has
    // since stopped working.
    const writes: unknown[][] = [];
    let stored: unknown;

    const cacheService = {
      set: async (...args: unknown[]) => {
        writes.push(args);
        stored = args[1];
      },
      get: async () => stored,
    };

    await new CacheHealthIndicator(cacheService as never).isHealthy();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('__health__');
    expect(writes[0]?.[2]).toEqual({ ttl: 60 });
  });
});

/**
 * The behaviour this file depends on, checked against the installed terminus
 * rather than against its source.
 *
 * `degraded` resolving instead of throwing is the whole reason the indicator can
 * use it, and it is an implementation detail of a dependency: an upgrade that
 * reclassified it as a failure would turn every redis blip into an instance
 * pulled out of rotation, with no failure in this repository to point at.
 */
describe('the terminus status this relies on', () => {
  async function health(): Promise<HealthCheckService> {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
    }).compile();

    return moduleRef.get(HealthCheckService);
  }

  it('resolves a degraded indicator instead of failing the check', async () => {
    const service = await health();

    const result = await service.check([
      async () => ({ database: { status: 'up' as const } }),
      async () => ({ cache: { status: 'degraded' as const } }),
    ]);

    expect(result.status).toBe('degraded');
    expect(result.info?.cache?.status).toBe('degraded');
    // Nothing in `error`, which is what keeps the response a 200.
    expect(result.error).toEqual({});
  });

  it('still fails the check on down, so the contrast is real', async () => {
    const service = await health();

    await expect(
      service.check([async () => ({ cache: { status: 'down' as const } })]),
    ).rejects.toThrow();
  });
});
