import { registerAs } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

import { THROTTLER_STORAGE } from '../modules/queue/throttler/redis-throttler.storage.js';

export const throttlerConfig = registerAs(
  'throttler',
  (): ThrottlerModuleOptions => ({
    // Lets a client see how much budget it has left and back off, instead of
    // only discovering the limit by being rejected.
    setHeaders: true,
    throttlers: [
      {
        ttl: Number(process.env.THROTTLE_TTL ?? 60000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 100),
        blockDuration:
          Number(process.env.THROTTLE_BLOCK_DURATION ?? 0) || undefined,
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
