import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';

import type { RedisConfig } from '../../configs/redis.config.js';

const logger = new Logger('RedisClientService');

/** Redis' digest for `EVALSHA` is the script's SHA1, lowercase hex. */
const sha1 = (script: string): string =>
  createHash('sha1').update(script).digest('hex');

/**
 * True for redis' `NOSCRIPT`, which means it does not know the digest yet.
 *
 * Only that error falls back to sending the body. Every other error, a timeout or
 * a refused connection included, propagates so `run` can log it and return null,
 * which is what makes the throttle fail open rather than fail closed.
 */
const isNoScriptError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes('NOSCRIPT');
};

/**
 * The client factory, injectable so a test can supply a fake without a server.
 *
 * Taken as a constructor argument rather than called inline because the alternative
 * is a module-level `createClient` that no test can intercept.
 */
export type RedisClientFactory = (config: RedisConfig) => RedisClientType;

/**
 * The redis connection for queue bookkeeping.
 *
 * Distinct from `CacheService` on purpose. The cache is disposable and evicted by
 * TTL; these keys are a deduplication marker and a dead-letter list, and a cache
 * sweep must never reach either of them. `CacheService` also has its own client
 * inside `cache.module.ts`, and this one is for everything that is not a cache
 * entry.
 *
 * Two properties matter more than the commands it exposes:
 *
 * - **Boot does not wait for it.** A deployment whose redis is unreachable has to
 *   start, serve the routes that do not need redis, and let the queue fall back
 *   to running in process. So the connection is made on first use, and a failure
 *   is logged rather than thrown.
 * - **A dead client is a miss, not a crash.** Every command here is wrapped, and
 *   the caller's fallback is to treat the bookkeeping as absent. Deciding that is
 *   the caller's job, so the methods here report the failure instead of guessing.
 */
export class RedisClientService implements OnModuleDestroy {
  private client: RedisClientType | null = null;
  private connecting: Promise<RedisClientType> | null = null;
  private closed = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly factory: RedisClientFactory = (config) =>
      createClient({
        url: config.url,
        socket: { connectTimeout: config.connectTimeout },
        // Without this a command issued while the socket is reconnecting waits
        // for the outage to end, so one dead redis turns into every request in
        // flight piling up behind a socket that is not coming back.
        disableOfflineQueue: config.disableOfflineQueue,
      }),
  ) {}

  private get config(): RedisConfig {
    return this.configService.getOrThrow<RedisConfig>('redis');
  }

  /**
   * Every key this service writes, inside the configured namespace.
   *
   * The prefix is applied here rather than in each caller because the raw client
   * does not: `cache.module.ts` gets its namespacing from keyv, so without this
   * the queue keys would land next to the cache keys on a shared server, which is
   * the collision the separate `redis` namespace exists to prevent.
   */
  private key(name: string): string {
    return `${this.config.keyPrefix}:${name}`;
  }

  /**
   * True when a client is connected. For the health check, which reports this as
   * degraded rather than down: the app is still serving.
   */
  isReady(): boolean {
    return this.client?.isReady === true;
  }

  /**
   * The connected client, connecting on first use.
   *
   * The promise is memoised so a burst of concurrent callers during an outage
   * makes one connection attempt rather than one each.
   */
  async getClient(): Promise<RedisClientType> {
    if (this.closed) {
      throw new Error('The redis client has been shut down');
    }

    if (this.client?.isReady) {
      return this.client;
    }

    if (this.connecting === null) {
      this.connecting = this.connect();
    }

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<RedisClientType> {
    const client = this.factory(this.config);

    // Without a listener, a socket error is an unhandled 'error' event and takes
    // the process down. Every failure from here on is a command rejection, which
    // the callers handle.
    client.on('error', (error: Error) =>
      logger.warn(`Redis unavailable: ${error.message}`),
    );

    try {
      await client.connect();
    } catch (error) {
      client.destroy();

      throw new Error(
        `Could not connect to redis: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.client = client;

    return client;
  }

  /**
   * `SET key value NX EX ttl`, the deduplication primitive.
   *
   * Returns `true` when the key was set, meaning this caller is the first and
   * should do the work. `false` means it already exists. `null` means redis could
   * not be asked, which the caller has to treat as permission to proceed: a
   * bookkeeping failure must not silently swallow a real email.
   */
  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean | null> {
    return this.run(async (client) => {
      const result = await client.set(this.key(key), value, {
        NX: true,
        EX: Math.max(1, Math.ceil(ttlSeconds)),
      });

      return result === 'OK';
    });
  }

  /** Releases a key, for a job that failed permanently and should not be retried. */
  async release(key: string): Promise<boolean> {
    const released = await this.run(async (client) => {
      const removed = await client.del(this.key(key));

      return removed > 0;
    });

    return released ?? false;
  }

  /** Pushes onto the head of a list, which is the order a dead-letter wants. */
  async pushToList(
    key: string,
    value: string,
    maxLength = 500,
  ): Promise<boolean> {
    const pushed = await this.run(async (client) => {
      await client.lPush(this.key(key), value);
      await client.lTrim(this.key(key), 0, Math.max(0, maxLength - 1));

      return true;
    });

    return pushed ?? false;
  }

  async listLength(key: string): Promise<number> {
    const length = await this.run((client) => client.lLen(this.key(key)));

    return length ?? 0;
  }

  /**
   * Runs a command, turning every failure into `null`.
   *
   * `null` rather than a throw on purpose: redis being down is an operational
   * condition, and a caller that has to catch it will eventually forget to.
   */
  /**
   * Runs a Lua script atomically, returning null when redis is unreachable.
   *
   * Added for the throttler storage, which has to count and decide in one step:
   * reading the counter and then writing it back is a race, and in a rate limiter
   * the race is exactly the burst an attacker sends. `EVALSHA` first because this
   * runs on every throttled request, and a script body of a few hundred bytes per
   * request is real traffic; the body is only sent when redis has forgotten the
   * digest, which is a restart.
   */
  async eval<TArgs extends readonly (string | number)[], TResult>(
    script: string,
    keys: readonly string[],
    args: TArgs,
  ): Promise<TResult | null> {
    return this.run(async (client) => {
      const digest = sha1(script);

      try {
        return (await client.evalSha(digest, {
          keys: [...keys],
          arguments: args.map(String),
        })) as TResult;
      } catch (error) {
        if (!isNoScriptError(error)) {
          throw error;
        }

        return (await client.eval(script, {
          keys: [...keys],
          arguments: args.map(String),
        })) as TResult;
      }
    });
  }

  private async run<T>(
    command: (client: RedisClientType) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await command(await this.getClient());
    } catch (error) {
      logger.warn(
        `Redis command failed, treating as absent: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;

    if (this.client?.isOpen) {
      await this.client.quit().catch(() => this.client?.destroy());
    }
  }
}
