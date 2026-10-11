/**
 * What a route declares about its idempotency window.
 *
 * The defaults are the ones nearly every route wants, which is why the decorator
 * takes an empty argument for most of them. The two knobs exist for the routes
 * where the default is wrong, and naming them is what stops each of those from
 * becoming a special case written inline at the call site.
 */
export interface IdempotencyPolicy {
  /**
   * How long a completed answer is replayed for, in seconds.
   *
   * Twenty-four hours by default, matching the emailed links: it has to outlive a
   * client that was offline, not just one that timed out.
   */
  ttlSeconds?: number;
  /**
   * How long a running request holds its key, in seconds.
   *
   * Sixty by default — long enough to catch a retry of a request that is genuinely
   * still working, short enough that a request wedged for minutes does not answer
   * 409 to everyone for the rest of its natural life.
   */
  inFlightSeconds?: number;
}
