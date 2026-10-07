import { SetMetadata, type ExecutionContext } from '@nestjs/common';

/**
 * Metadata key holding the rate-limit group a route opted into.
 *
 * A group rather than a bucket name because login needs two buckets that must
 * both pass, and writing `@RateLimit('login-ip')` on one route and
 * `@RateLimit('login-email')` on another would let somebody add one and silently
 * drop the other. The group is the unit of intent.
 */
export const RATE_LIMIT_METADATA = 'app:rate-limit-group';

/**
 * Opts a route into a named group of rate limits.
 *
 * The polarity is deliberately opt-in rather than the usual opt-out. A bucket is
 * only evaluated if it is declared in the throttler module's option list, and the
 * guard then loops over *that whole list* for every request. Declaring the auth
 * buckets globally without this marker would put the three-per-hour mail limit on
 * every endpoint in the application.
 *
 * So each bucket carries a `skipIf` that consults this marker, and a route with no
 * marker is limited by `default` alone.
 */
export const RateLimit = (group: string) =>
  SetMetadata(RATE_LIMIT_METADATA, group);

/**
 * True when the request's handler opted into any of these groups.
 *
 * Read straight off the metadata rather than through `Reflector`, because
 * `skipIf` is a plain function in a config file with no injection of its own.
 * `Reflect.getMetadata` is what `Reflector` wraps, so this is the same answer.
 */
export function rateLimitApplies(
  context: ExecutionContext,
  groups: readonly string[],
): boolean {
  const group = Reflect.getMetadata(
    RATE_LIMIT_METADATA,
    context.getHandler() as object,
  ) as string | undefined;

  return group !== undefined && groups.includes(group);
}
