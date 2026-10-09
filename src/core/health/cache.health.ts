import { Injectable, Logger } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { randomUUID } from 'node:crypto';

import { CacheService } from '../cache/index.js';

/**
 * Proves the cache works by writing a value and reading it back.
 *
 * A plain read would report healthy on a dead cache: cache-manager turns a
 * failing store into a miss, so "unreachable" and "empty" look identical. Writing
 * a value only this check knows and comparing it on the way back is what makes
 * the two distinguishable.
 *
 * **A broken cache is `degraded`, never `down`.** Everything else in this
 * application fails open on a cache outage: rate limiting lets requests through,
 * the login lockout stops counting, and the auth cache falls back to a database
 * query. The application serves traffic throughout, more slowly. Reporting `down`
 * here would have Terminus throw 503, an orchestrator would pull every instance
 * out of rotation over a redis problem, and the cache outage would become a full
 * outage of a system that was still answering requests. That is the failure mode
 * this status exists to avoid.
 *
 * `degraded` is a status terminus knows: it lands in `info` rather than `error`,
 * the aggregate response says `degraded`, and the request still returns 200. An
 * operator sees it in the body and in alerting; nothing is restarted.
 */
@Injectable()
export class CacheHealthIndicator {
  private readonly logger = new Logger(CacheHealthIndicator.name);
  private readonly key = '__health__';

  constructor(private readonly cacheService: CacheService) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const token = randomUUID();

    try {
      await this.cacheService.set(this.key, token, { ttl: 60 });
      const value = await this.cacheService.get<string>(this.key);

      if (value !== token) {
        this.logger.warn('Cache health check read back a different value');

        return {
          cache: { status: 'degraded', reason: 'read back did not match' },
        };
      }

      return { cache: { status: 'up' } };
    } catch (error) {
      // Reached only when the failure is thrown rather than reported as a miss.
      // Either way it is a degraded cache and not a dead application, so it is
      // logged loudly and returned without taking the readiness probe with it.
      this.logger.warn(`Cache health check failed: ${String(error)}`);

      return { cache: { status: 'degraded', reason: 'cache is unreachable' } };
    }
  }
}
