import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Derived rather than imported.
 *
 * `@nestjs/throttler` exports `ThrottlerStorage` but not `ThrottlerStorageRecord`,
 * which lives behind a deep path into `dist`. Reaching into `dist` couples the
 * build to the package layout; taking the return type of the interface the
 * storage has to satisfy keeps it compiling when the package moves a file.
 */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

import { RedisClientService } from '../redis-client.service.js';
import { THROTTLE_SCRIPT, type ThrottleTuple } from './throttler-script.js';

/** The token both drivers are provided under, so a consumer never branches. */
export const THROTTLER_STORAGE = 'THROTTLER_STORAGE';

/**
 * The key prefix every throttle lives under.
 *
 * Namespaced separately from the cache and the queue keys. The throttle keys are
 * written on every request, so an overlap with a cache namespace would mean a
 * `DEL` on a cache entry deleting somebody's rate limit.
 */
const THROTTLE_PREFIX = 'throttle';

/**
 * Rate limiting that holds across replicas.
 *
 * The in-memory storage that ships with the throttler counts inside one process,
 * which means three replicas behind a load balancer give a caller three times the
 * intended limit. The number is written down and means nothing, which is the
 * particular failure that only shows up once the application is popular enough
 * to be attacked.
 *
 * **Fails open.** When redis is unreachable the request is allowed, and the
 * failure is logged. Failing closed would make redis an availability dependency
 * of every endpoint, so a cache outage would lock every user out of login. The
 * cost is that an outage removes rate limiting exactly when someone is most
 * likely to be hammering the endpoint. That trade is deliberate and it is not
 * free: the deployment that cares should put a limit in front of the application
 * too, and this is the inner layer rather than the only one.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisClientService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = await this.redis.eval<
      readonly (string | number)[],
      ThrottleTuple
    >(
      THROTTLE_SCRIPT,
      [`${THROTTLE_PREFIX}:${throttlerName}:${key}`],
      [ttl, limit, blockDuration, Date.now()],
    );

    if (result === null) {
      return this.allowEverything();
    }

    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result;

    return {
      totalHits,
      // Clamped at zero because the script can return a negative value in the
      // moment between the window ending and the key being reaped, and a negative
      // Retry-After header is worse than a useless one.
      timeToExpire: Math.max(0, timeToExpire),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.max(0, timeToBlockExpire),
    };
  }

  /**
   * The answer used when redis did not answer.
   *
   * One hit, a full window and no block, so the caller sees a caller that has
   * used a single request out of a generous limit and carries on. Fails open.
   */
  private allowEverything(): ThrottlerStorageRecord {
    this.logger.warn(
      'Redis unavailable, so the rate limit was not applied for one request',
    );

    return {
      totalHits: 1,
      timeToExpire: 60_000,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

/** Injection token, so a consumer never imports the class to get it. */
export const THROTTLER_STORAGE_TOKEN = THROTTLER_STORAGE;
