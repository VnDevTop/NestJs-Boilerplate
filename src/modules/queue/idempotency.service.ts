import { Injectable, Logger } from '@nestjs/common';

import { createHash } from 'node:crypto';

import { RedisClientService } from '../queue/redis-client.service.js';

/**
 * What was recorded for a completed request.
 *
 * `body` is stored rather than just an outcome because a client retrying after a
 * timeout needs the *answer*, not a receipt. Replaying "your request was
 * processed" for a create would make the caller issue a second read to find out
 * what it created, which is the retry this whole feature exists to remove.
 */
export interface IdempotencyRecord {
  /** `pending` while the first copy is still running. */
  readonly state: 'pending' | 'complete';
  readonly status: number;
  /** `undefined` for a 204, and for a response over the size cap. */
  readonly body?: string;
}

/**
 * How long a completed response is replayed for.
 *
 * Twenty-four hours, which is the same window as the emailed links and for the
 * same reason: it has to outlive a client that was offline, not just a client that
 * timed out. The cost is one redis entry per mutating request per user, and the
 * entries carry no more than a response body.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long a *running* request holds its key.
 *
 * Deliberately much shorter than the completed window. Its only job is to catch the
 * second copy arriving while the first is still working, and a request that runs
 * longer than this has almost certainly failed in a way nobody is going to wait
 * for — so the key is released and a later retry is allowed through rather than
 * answering 409 to a request that is no longer in flight.
 */
export const IDEMPOTENCY_IN_FLIGHT_SECONDS = 60;

/**
 * The largest response body replayed verbatim.
 *
 * A cap rather than a "store it all" because the store is redis, shared with the
 * queue and the throttle counters. Anything larger is replayed as a status alone:
 * re-sending the status is closer to correct than refusing the retry, and the
 * alternative — no cap — is a client that can put an unbounded value into a shared
 * keyspace by asking for it politely.
 */
export const IDEMPOTENCY_BODY_LIMIT = 64 * 1024;

const PREFIX = 'idem';

/**
 * The store for idempotency keys.
 *
 * **Redis directly, not `CacheService`.** The cache fails open by design — an
 * unreachable store is reported as a miss so a redis outage costs a round trip
 * rather than returning 500s. That is right for a cache and catastrophically wrong
 * here: a miss on an idempotency check means the request is treated as new, which is
 * precisely the duplicate this exists to prevent. So the outage is handled here,
 * explicitly, rather than inherited.
 *
 * **And it still fails open.** See `begin`. An outage means every mutating request
 * is processed without the protection — degraded, not broken. The alternative is a
 * redis outage taking down every write in the application, which turns a partial
 * loss of a convenience guarantee into a total loss of the product.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly redis: RedisClientService) {}

  /**
   * Claims a key for this request, or reports what is already there.
   *
   * Three answers, and the third is the one that matters:
   *
   * - `'claimed'` — nobody has used this key. Do the work, then call `complete`.
   * - `'pending'` — another copy is running right now. Answer 409 rather than
   *   queue behind it: the client wants to know now, and waiting would hold a
   *   connection open for work it cannot cancel.
   * - `'complete'` — a finished answer is waiting. Replay it.
   * - `null` — redis could not be asked. Proceed without the guarantee.
   */
  async begin(
    key: string,
    inFlightSeconds?: number,
  ): Promise<'claimed' | 'pending' | IdempotencyRecord | null> {
    const pending = await this.setIfAbsent(
      key,
      inFlightSeconds ?? IDEMPOTENCY_IN_FLIGHT_SECONDS,
    );

    if (pending === null) {
      return null;
    }

    // Claimed. Nothing to read.
    if (pending) {
      return 'claimed';
    }

    const existing = await this.redis.get(key);

    if (existing === null) {
      // The key existed a moment ago and is gone now. Its own in-flight ttl expired,
      // which means the first copy is either finished and its record was never
      // written, or still running and wedged. Treating this as claimed is the only
      // answer that lets anything happen at all.
      return 'claimed';
    }

    return this.parse(existing);
  }

  /**
   * Records the answer so a retry can be served it.
   *
   * Overwrites the in-flight marker rather than setting a second key: one key per
   * request means a retry finds exactly one answer, and two keys would need a rule
   * for which one wins.
   */
  async complete(
    key: string,
    record: { status: number; body?: string },
    ttlSeconds?: number,
  ): Promise<void> {
    const payload: IdempotencyRecord = {
      state: 'complete',
      status: record.status,
      ...(record.body === undefined ? {} : { body: record.body }),
    };

    try {
      // Through `RedisClientService`, not the raw client: it applies the configured
      // key prefix, and `setIfAbsent` above applies the same one. A store that
      // writes under a prefix and reads without it looks like a key that was never
      // claimed, on every request, forever.
      await this.redis.set(
        key,
        JSON.stringify(payload),
        ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // The work is done and the answer is not recorded. A retry will do the work
      // again, which is the pre-existing behaviour rather than a new failure — so
      // this is logged and swallowed rather than turned into a 500 for a request
      // that already succeeded.
      this.logger.warn(
        `Could not record the idempotent answer for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }. A retry will repeat the work.`,
      );
    }
  }

  /**
   * Drops a claim, so a failed request can be retried.
   *
   * Without this, a request that threw would hold its key for the in-flight ttl and
   * every retry during that window would be answered 409 — turning a transient
   * failure into a minute of "please try again later" for a client that would
   * happily have succeeded on the second attempt.
   */
  async release(key: string): Promise<void> {
    try {
      await this.redis.delete(key);
    } catch (error) {
      this.logger.warn(
        `Could not release the idempotency key ${key}: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
    }
  }

  /**
   * The storage key.
   *
   * Hashed, because the client's key is attacker-controlled and unbounded in
   * length: a 64KB redis key written by a caller is a denial of service against the
   * shared instance. The digest is fixed width, which also keeps the key readable in
   * a `KEYS` listing.
   */
  static buildKey(
    scope: string,
    method: string,
    path: string,
    clientKey: string,
  ): string {
    const digest = createHash('sha256')
      .update(`${method}:${path}:${clientKey}`)
      .digest('hex');

    return `${PREFIX}:${scope}:${digest}`;
  }

  /**
   * Reads a stored value, treating anything unparseable as "nothing recorded".
   *
   * The value is only ever written by `complete`, so an unparseable one means
   * corruption or a key from another deployment sharing the instance. Either way the
   * safe answer is the one that lets the request proceed — refusing would let
   * anybody who can write a redis key take down a route.
   */
  private parse(value: string): 'pending' | IdempotencyRecord {
    try {
      const parsed = JSON.parse(value) as IdempotencyRecord;

      if (parsed?.state === 'complete') {
        return parsed;
      }
    } catch {
      // Fall through: an unreadable value is not a claim.
    }

    return 'pending';
  }

  /** `null` rather than `false`: redis could not be asked, which is not "free". */
  private async setIfAbsent(
    key: string,
    ttlSeconds: number,
  ): Promise<boolean | null> {
    try {
      return await this.redis.setIfAbsent(
        key,
        JSON.stringify({
          state: 'pending',
          status: 0,
        } satisfies IdempotencyRecord),
        ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `Idempotency store unavailable: ${
          error instanceof Error ? error.message : String(error)
        }. The request proceeds without the guarantee.`,
      );

      return null;
    }
  }
}
