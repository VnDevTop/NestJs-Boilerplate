import { registerAs } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

import { rateLimitApplies } from '../common/decorators/rate-limit.decorator.js';
import {
  AUTH_THROTTLE,
  LOGIN_EMAIL_BUCKET,
  LOGIN_IP_BUCKET,
  MAIL_EMAIL_BUCKET,
  MAIL_THROTTLE,
  REFRESH_BUCKET,
} from '../common/constants/token.constants.js';
import { THROTTLER_STORAGE } from '../modules/queue/throttler/redis-throttler.storage.js';

export const throttlerConfig = registerAs(
  'throttler',
  (): ThrottlerModuleOptions => ({
    // Lets a client see how much budget it has left and back off, instead of
    // only discovering the limit by being rejected.
    setHeaders: true,

    /**
     * Every bucket the guard may enforce, not the ones in use.
     *
     * `ThrottlerGuard` builds its list here and nothing else, then loops over the
     * whole list on every request. A bucket declared only in `@Throttle()`
     * metadata is never reached, which is why the per-address mail limit declared
     * in Phase 14 had never actually run. Declaring them all here and skipping the
     * ones a route did not opt into is the only shape that works.
     *
     * Each carries a `skipIf` keyed on the route's group, so an endpoint without
     * `@RateLimit` is limited by `default` alone.
     */
    throttlers: [
      {
        ttl: Number(process.env.THROTTLE_TTL ?? 60000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 100),
        blockDuration:
          Number(process.env.THROTTLE_BLOCK_DURATION ?? 0) || undefined,
      },
      {
        name: LOGIN_IP_BUCKET,
        limit: AUTH_THROTTLE.perIp,
        ttl: AUTH_THROTTLE.windowMs,
        blockDuration: AUTH_THROTTLE.windowMs,
        skipIf: (context) => !rateLimitApplies(context, ['login']),
      },
      {
        name: LOGIN_EMAIL_BUCKET,
        limit: AUTH_THROTTLE.perEmail,
        ttl: AUTH_THROTTLE.windowMs,
        blockDuration: AUTH_THROTTLE.windowMs,
        skipIf: (context) => !rateLimitApplies(context, ['login']),
      },
      {
        name: REFRESH_BUCKET,
        limit: AUTH_THROTTLE.refreshPerIp,
        ttl: AUTH_THROTTLE.refreshWindowMs,
        blockDuration: AUTH_THROTTLE.refreshWindowMs,
        skipIf: (context) => !rateLimitApplies(context, ['refresh']),
      },
      {
        // Declared here so it runs at all. It was only ever named in route
        // metadata before, where the guard never looks.
        name: MAIL_EMAIL_BUCKET,
        limit: MAIL_THROTTLE.perEmailPerHour,
        ttl: MAIL_THROTTLE.windowMs,
        blockDuration: MAIL_THROTTLE.windowMs,
        skipIf: (context) => !rateLimitApplies(context, ['mail']),
      },
    ],
  }),
);

/**
 * Builds the throttler options with the shared redis storage attached.
 *
 * Kept beside the config rather than in `app.module` so the wiring that decides
 * whether limits are per-process or global lives in one file with the numbers it
 * applies to.
 */
/**
 * The object form of the options.
 *
 * `ThrottlerModuleOptions` is a union of the array form and the object form, and
 * only the object form has `storage`. `Extract` picks the right half rather than
 * indexing a property the array half does not have.
 */
type ThrottlerObjectOptions = Extract<
  ThrottlerModuleOptions,
  { throttlers: unknown }
>;

export const throttlerModuleConfig = (
  storage: ThrottlerObjectOptions['storage'],
): ThrottlerModuleOptions => ({
  ...throttlerConfig(),
  // The in-memory default counts inside one process, so a caller gets one limit
  // per replica. This is the line that makes the limit mean the same thing
  // everywhere behind the load balancer.
  storage,
});

/** Token name re-exported so a caller does not import the module to inject it. */
export { THROTTLER_STORAGE };
