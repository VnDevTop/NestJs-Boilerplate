import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER, type Cache } from '@nestjs/cache-manager';

import type { CacheConfig } from '../../configs/index.js';

export interface CacheOptions {
  /** Entry lifetime in seconds. Defaults to the configured value. */
  ttl?: number;
  /**
   * Start refreshing once the entry is this many seconds from expiring, in
   * seconds. Reads still return the cached value and the refresh runs in the
   * background, so latency stays flat. Must be well below `ttl`.
   */
  refreshThreshold?: number;
  /**
   * How long a "nothing found" answer is kept, in seconds. Defaults to a short
   * value, since a lookup that keeps missing must not query the loader on every
   * request, but a record created afterwards should appear promptly.
   */
  emptyTtl?: number;
  /**
   * Skip the random reduction applied to every entry lifetime.
   *
   * Only for entries whose lifetime is a correctness bound rather than a
   * housekeeping one. The jitter exists so a bulk write does not expire in one
   * burst, which is worth giving up where an entry that expires early *grants*
   * something: a revoked session held for less than the lifetime of the tokens it
   * revokes would let those tokens start working again.
   */
  exactTtl?: boolean;
}

export interface CacheStats {
  /** Loader invocations, after request coalescing has removed duplicates. */
  loads: number;
}

/** Spreads expirations so a bulk write does not expire in one burst. */
const TTL_JITTER_RATIO = 0.1;

/**
 * The cache API business code should use.
 *
 * Values go through cache-manager, which already fails open: a store that
 * rejects is reported as a miss rather than an error, so a cache outage costs
 * one extra database round trip instead of returning 500s.
 *
 * Invalidation is by explicit key only. There is deliberately no wildcard or
 * pattern delete: scanning a keyspace to evict a namespace is an unbounded
 * operation on a shared server, and an accidentally broad pattern is silent and
 * expensive. Callers that know what they changed pass those keys.
 *
 * `CacheKey`, `CacheTTL` and `CacheInterceptor` are re-exported from
 * `core/cache` for caching controller responses.
 */
@Injectable()
export class CacheService {
  private readonly stats: CacheStats = { loads: 0 };

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly configService: ConfigService,
  ) {}

  private get options(): CacheConfig {
    return this.configService.getOrThrow<CacheConfig>('cache');
  }

  get backend(): CacheConfig['backend'] {
    return this.options.backend;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  /** Resolves to the entry lifetime in milliseconds, for tests and assertions. */
  async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {},
  ): Promise<number> {
    const ttl = this.resolveTtl(options.ttl, options.exactTtl);

    await this.cache.set(key, value, ttl);

    return ttl;
  }

  async delete(key: string): Promise<void> {
    await this.cache.del(key);
  }

  /** Drops several keys at once, for a mutation that touched known entities. */
  async deleteKeys(...keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }

    await this.cache.mdel(keys);
  }

  /**
   * Read through cache: serves the cached value, otherwise calls `loader` and
   * caches what it returns. This is the miss handler, and the failover back to
   * the database is simply the loader running.
   *
   * Delegates to cache-manager, which brings the two behaviours that decide
   * whether a hot endpoint survives real traffic:
   *
   * - **Request coalescing.** Concurrent callers of the same key share a single
   *   loader run. Without it, a hot key expiring under load makes every waiting
   *   request call the loader at once, which is a cache stampede.
   * - **Stale while revalidate.** With `refreshThreshold`, a read that lands
   *   close to expiry returns immediately and refreshes in the background, so a
   *   request never waits on the loader for an entry that was about to be
   *   replaced anyway.
   *
   * A nullish result is kept for a much shorter time rather than the full TTL,
   * so repeated lookups of something that does not exist stop hammering the
   * loader, while a record created just now still shows up quickly.
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    return this.cache.wrap<T>(key, () => this.load(loader), {
      ttl: (value: T) =>
        value === undefined || value === null
          ? this.resolveTtl(options.emptyTtl)
          : this.resolveTtl(options.ttl),
      ...(options.refreshThreshold === undefined
        ? {}
        : { refreshThreshold: this.resolveTtl(options.refreshThreshold) }),
    });
  }

  /**
   * Loads without reading the cache first, so the result is always fresh. Use
   * after a mutation whose response must not come from cache.
   */
  async refresh<T>(
    key: string,
    loader: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const value = await this.load(loader);

    if (value !== undefined && value !== null) {
      await this.set(key, value, options);
    }

    return value;
  }

  private async load<T>(loader: () => Promise<T>): Promise<T> {
    this.stats.loads += 1;

    return loader();
  }

  /** Removes every entry this application owns. */
  async clear(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * cache-manager and Keyv work in milliseconds while configuration is in
   * seconds, so the conversion happens here and nowhere else.
   *
   * A small random reduction spreads expirations: entries written in bulk would
   * otherwise share a deadline, turn into one burst of simultaneous misses, and
   * then stampede the loader all over again.
   */
  private resolveTtl(seconds?: number, exact?: boolean): number {
    const base = seconds && seconds > 0 ? seconds : this.options.defaultTtl;
    const jitter = exact ? 0 : TTL_JITTER_RATIO * Math.random();

    return Math.round(base * 1000 * (1 - jitter));
  }
}
