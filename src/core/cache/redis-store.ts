import { createKeyv } from '@keyv/redis';
import { Keyv } from 'keyv';
import { createClient } from 'redis';

import type { CacheConfig } from '../../configs/index.js';

/**
 * A store plus the connection behind it.
 *
 * The connection is handed back rather than kept private so that whoever opened it
 * can close it. A caller that forgets is a script that never exits.
 */
export interface CacheStore {
  store: Keyv;
  close(): Promise<void>;
}

/**
 * The redis-backed store, built the one way.
 *
 * Shared rather than written twice because the physical key layout lives here:
 * Keyv prefixes every key with `config.keyPrefix`, and anything that has to reach
 * into the cache from outside the Nest container — the seeder, which runs as a
 * plain node script — has to produce the same layout to delete a real key. A second
 * construction site would be a second answer to that question, and the failure mode
 * is an eviction that silently does nothing.
 *
 * `probe` is what turns an unreachable cache into a failed **boot**. A Keyv store
 * connects lazily, so without it the application would start and then fail on its
 * first request, which is harder to diagnose than not starting at all. Only the
 * probe wants errors thrown; afterwards a store reports them as misses, which is
 * the fail-open behaviour the rest of this cache depends on.
 */
export async function createRedisStore(
  config: CacheConfig,
  onError: (error: Error) => void,
  options: { probe?: boolean } = {},
): Promise<CacheStore> {
  const client = createClient({
    url: config.url,
    socket: { connectTimeout: config.connectTimeout },
    // node-redis keeps commands in an offline queue while the socket is
    // reconnecting, so a command issued in that window would wait for the outage
    // to end instead of reporting a miss straight away.
    disableOfflineQueue: true,
  });

  // A dead cache must not become an unhandled error event, and the store turns
  // these into misses, so they are logged rather than thrown.
  client.on('error', onError);

  // The cast is only for the store's Redis client generic, which does not carry
  // the json module the client type defaults to. Nothing about the commands used
  // here is affected.
  const store = createKeyv(
    client as unknown as Parameters<typeof createKeyv>[0],
    {
      namespace: config.keyPrefix,
      keyPrefixSeparator: ':',
      connectionTimeout: config.connectTimeout,
      throwOnErrors: true,
    },
  );

  if (options.probe === true) {
    await store.get('__startup__');

    (store as { throwOnErrors: boolean }).throwOnErrors = false;
  }

  return {
    store,
    /**
     * Closes the connection.
     *
     * The application never calls this: its store lives for the life of the
     * process, which Nest shuts down. A short-lived script does, because an open
     * socket keeps the event loop alive and the process would sit there after
     * printing its last line instead of exiting.
     */
    close: async () => {
      await client.close();
    },
  };
}

/** The in-memory store, for `CACHE_BACKEND=memory`. */
export function createMemoryStore(config: CacheConfig): Keyv {
  return new Keyv({ ttl: config.defaultTtl * 1000 });
}
