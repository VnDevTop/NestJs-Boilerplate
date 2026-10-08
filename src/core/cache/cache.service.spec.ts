import type { ConfigService } from '@nestjs/config';
import { createCache, type Cache } from 'cache-manager';
import { Keyv, type KeyvStoreAdapter } from 'keyv';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheKey, CACHE_NAMESPACE, CacheService } from './index.js';
import type { CacheConfig } from '../../configs/index.js';

const config: CacheConfig = {
  backend: 'memory',
  url: 'redis://localhost:6379/0',
  keyPrefix: 'app',
  defaultTtl: 60,
  authUserTtl: 60,
  authRoleTtl: 600,
  emptyTtl: 10,
  connectTimeout: 1000,
};

/** Stands in for ConfigService, which the service reads through a getter. */
const configService = {
  getOrThrow: <T>(key: string): T => {
    if (key !== 'cache') {
      throw new Error(`unexpected config key ${key}`);
    }

    return config as T;
  },
} as unknown as ConfigService;

async function memoryService(): Promise<CacheService> {
  const cache = await createCache({ stores: [new Keyv()], ttl: 60_000 });

  return new CacheService(cache, configService);
}

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(async () => {
    service = await memoryService();
  });

  it('stores and returns a value', async () => {
    await service.set('user:1', { id: '1', role: 'user' });

    await expect(service.get('user:1')).resolves.toEqual({
      id: '1',
      role: 'user',
    });
  });

  it('returns undefined for a miss', async () => {
    await expect(service.get('nope')).resolves.toBeUndefined();
  });

  it('deletes a single key', async () => {
    await service.set('k', 1);
    await service.delete('k');

    await expect(service.get('k')).resolves.toBeUndefined();
  });

  it('deletes several keys by name', async () => {
    await service.set('user:1', 1);
    await service.set('user:2', 2);
    await service.set('user:3', 3);

    await service.deleteKeys('user:1', 'user:2');

    await expect(service.get('user:1')).resolves.toBeUndefined();
    await expect(service.get('user:2')).resolves.toBeUndefined();
    await expect(service.get('user:3')).resolves.toBe(3);
  });

  it('ignores an empty key list instead of calling the store', async () => {
    const mdel = vi.spyOn(service['cache'], 'mdel');

    await service.deleteKeys();

    expect(mdel).not.toHaveBeenCalled();
  });

  it('has no wildcard or pattern delete', () => {
    // Evicting a namespace means scanning a shared keyspace, which is unbounded
    // and silently destructive if the pattern is too broad. Keys only.
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
    ).not.toContain('deleteByPattern');
  });

  it('reports the configured backend', () => {
    expect(service.backend).toBe('memory');
  });
});

describe('CacheService.wrap', () => {
  let service: CacheService;

  beforeEach(async () => {
    service = await memoryService();
  });

  it('loads once and serves the rest from cache', async () => {
    const loader = vi.fn().mockResolvedValue('value');

    await service.wrap('k', loader);
    await service.wrap('k', loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent misses into a single loader run', async () => {
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));

      return 'value';
    });

    // The classic stampede: a hot key is invalidated while traffic is in flight.
    const results = await Promise.all(
      Array.from({ length: 200 }, () => service.wrap('hot', loader)),
    );

    expect(calls).toBe(1);
    expect(new Set(results)).toEqual(new Set(['value']));
  });

  it('releases the coalescing slot so a later miss can load again', async () => {
    const loader = vi.fn().mockResolvedValue('value');

    await service.wrap('k', loader);
    await service.delete('k');
    await service.wrap('k', loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('counts loader runs', async () => {
    await service.wrap('a', async () => 'A');
    await service.wrap('a', async () => 'A');

    expect(service.getStats()).toEqual({ loads: 1 });
  });

  it('keeps a found result cached', async () => {
    const loader = vi.fn().mockResolvedValue('value');

    await service.wrap('present', loader, { emptyTtl: 0.05 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await service.wrap('present', loader, { emptyTtl: 0.05 });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not keep a nullish result for long', async () => {
    const loader = vi.fn().mockResolvedValue(null);

    await service.wrap('missing', loader, { emptyTtl: 0.05 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await service.wrap('missing', loader, { emptyTtl: 0.05 });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('always reloads through refresh', async () => {
    const loader = vi.fn().mockResolvedValue('fresh');

    await service.set('k', 'stale');
    await expect(service.refresh('k', loader)).resolves.toBe('fresh');
    await expect(service.get('k')).resolves.toBe('fresh');
  });

  it('converts the configured seconds into the milliseconds Keyv expects', async () => {
    await service.set('short', 'value', { ttl: 0.05 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await service.get('short')).toBe('value');

    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(service.get('short')).resolves.toBeUndefined();
  });

  it('jitters expirations so bulk writes do not expire together', async () => {
    const seen = new Set<number>([await service.set('k', 1, { ttl: 100 })]);

    for (let i = 0; i < 20; i += 1) {
      seen.add(await service.set('k', 1, { ttl: 100 }));
    }

    // Without jitter every entry would land on the exact same deadline.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('serves a stale value and refreshes in the background', async () => {
    let version = 0;
    const loader = vi.fn(async () => {
      version += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));

      return `v${version}`;
    });

    await service.wrap('swr', loader, { ttl: 0.4, refreshThreshold: 0.2 });
    expect(loader).toHaveBeenCalledTimes(1);

    // Past the refresh threshold, the read must not wait for the loader.
    await new Promise((resolve) => setTimeout(resolve, 260));
    const served = await service.wrap('swr', loader, {
      ttl: 0.4,
      refreshThreshold: 0.2,
    });
    expect(served).toBe('v1');

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await service.get('swr')).toBe('v2');
  });

  it('falls back to the loader for every call when the store is broken', async () => {
    const broken = await createCache({
      stores: [
        new Keyv({
          opts: {},
          on: () => undefined,
          off: () => undefined,
          async get() {
            throw new Error('store down');
          },
          async set() {
            throw new Error('store down');
          },
          async delete() {
            throw new Error('store down');
          },
          async clear() {
            throw new Error('store down');
          },
        } as unknown as KeyvStoreAdapter),
      ],
    });
    const degraded = new CacheService(
      broken as unknown as Cache,
      configService,
    );
    const database = vi
      .fn()
      .mockResolvedValueOnce({ id: '1' })
      .mockResolvedValueOnce({ id: '1' });

    await expect(degraded.wrap('user:1', database)).resolves.toEqual({
      id: '1',
    });
    await expect(degraded.wrap('user:1', database)).resolves.toEqual({
      id: '1',
    });
    expect(database).toHaveBeenCalledTimes(2);
  });

  it('cannot report cache health, because a broken store reads as a miss', async () => {
    // cache-manager reports a failing store as a miss rather than an error, so
    // no read through it can tell "empty" from "unreachable". A health check
    // has to ping the server directly, which is why there is no isHealthy here
    // and the health endpoint belongs to the production hardening phase.
    const broken = await createCache({
      stores: [
        new Keyv({
          opts: {},
          on: () => undefined,
          off: () => undefined,
          async get() {
            throw new Error('store down');
          },
          async set() {
            throw new Error('store down');
          },
          async delete() {
            throw new Error('store down');
          },
          async clear() {
            throw new Error('store down');
          },
        } as unknown as KeyvStoreAdapter),
      ],
    });
    const degraded = new CacheService(
      broken as unknown as Cache,
      configService,
    );

    await expect(degraded.get('k')).resolves.toBeUndefined();
    expect(degraded).not.toHaveProperty('isHealthy');
  });
});

describe('cacheKey', () => {
  it('joins the namespace with its parts', () => {
    expect(cacheKey(CACHE_NAMESPACE.User, '8d7d34d4')).toBe('user:8d7d34d4');
  });

  it('drops empty segments', () => {
    expect(cacheKey(CACHE_NAMESPACE.User, '', '8d7d34d4')).toBe(
      'user:8d7d34d4',
    );
  });

  it('keeps two namespaces distinct', () => {
    expect(cacheKey(CACHE_NAMESPACE.User, '1')).not.toBe(
      cacheKey(CACHE_NAMESPACE.Device, '1'),
    );
  });
});
