import { createKeyv } from '@keyv/redis';
import { Keyv } from 'keyv';

import type { CacheConfig } from '../../configs/index.js';

/**
 * The redis store, built the one way.
 *
 * Shared rather than written twice because the physical key layout lives here.
 * Keyv prefixes every key with `config.keyPrefix`, so anything that has to reach
 * into the cache from outside the Nest container — the permission seeder, which
 * runs as a plain node script — has to produce the same layout to delete a real
 * key. A second construction site would be a second answer to that question, and
 * the failure mode is an eviction that silently does nothing.
 *
 * `createKeyv` takes the connection options itself and derives the key layout from
 * the same `namespace` and separator, so nothing here reaches for `createClient`:
 * the earlier version built a client by hand on the belief that `createKeyv` only
 * accepted a URL, which the installed version does not.
 */
export function createRedisStore(config: CacheConfig): Keyv {
  return createKeyv(
    {
      url: config.url,
      socket: { connectTimeout: config.connectTimeout },
      // node-redis keeps commands in an offline queue while the socket is
      // reconnecting, so a command issued in that window would wait for the outage
      // to end instead of reporting a miss straight away.
      disableOfflineQueue: true,
    },
    {
      namespace: config.keyPrefix,
      keyPrefixSeparator: ':',
      connectionTimeout: config.connectTimeout,
      throwOnErrors: true,
    },
  );
}

/**
 * The in-memory store, for `CACHE_BACKEND=memory`.
 *
 * Not a namespace and not shared between processes, which is the property that
 * makes an in-process cache impossible to evict from the outside: the seeder's
 * eviction is a no-op there, and its entries are simply left to expire.
 */
export function createMemoryStore(config: CacheConfig): Keyv {
  return new Keyv({ ttl: config.defaultTtl * 1000 });
}
