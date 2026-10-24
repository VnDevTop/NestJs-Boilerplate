import { createHash } from 'node:crypto';

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { CacheService } from '../../core/cache/index.js';
import {
  CircuitBreakerPolicy,
  CircuitOpenError,
  ResiliencePolicy,
  RetryPolicy,
  TimeoutPolicy,
} from '@nestjs/resilience';

/**
 * Rejects a password that appears in a corpus of breached credentials.
 *
 * **k-anonymity, so the password never leaves the server.** The password is hashed
 * with SHA-1 and split: the first five characters go out, the server returns every
 * suffix sharing that prefix, and the comparison happens here. The service sees one
 * bucket out of the whole corpus and never learns which password was asked about.
 *
 * That property is the entire reason this API is used rather than a list shipped
 * with the application, and it is also why SHA-1 appears here despite being a weak
 * hash everywhere else in this codebase. The digest is not a security boundary here
 * — it is a lookup key the remote service is defined in terms of, and substituting
 * anything else would produce a value the service cannot answer for.
 *
 * **Fails open.** An unreachable API must not stop anybody signing up. The
 * alternative is a third party being able to lock every user out of this
 * deployment by being slow, which makes this an availability dependency dressed up
 * as a security control. The failure is logged loudly, because a check that quietly
 * stops running is worse than one that is off.
 *
 * **Protected by a circuit breaker.** Outages or slow third-party calls will not
 * exhaust connections or prolong signups indefinitely: once the breaker opens,
 * requests fail open immediately without touching the network until recovery.
 *
 * **Cached, because the answer does not change.** A breached password stays
 * breached forever, so one lookup per distinct password is enough for the lifetime
 * of the deployment. Cached under the hash, which also means the cache holds no
 * plaintext: a redis dump is a list of SHA-1 digests of passwords people chose,
 * which is brute-forceable and therefore worth not adding to casually.
 */
class PasswordBreachBreaker extends CircuitBreakerPolicy {
  get currentState(): CircuitBreakerPolicy['state'] {
    return this.state;
  }
}

@Injectable()
export class PasswordBreachService {
  private readonly logger = new Logger(PasswordBreachService.name);

  /**
   * The public range endpoint. There is no API key and no account, which is what
   * lets the k-anonymity model work at all: the server must be willing to answer
   * anybody.
   */
  private static readonly API_URL = 'https://api.pwnedpasswords.com/range';

  /** How long a verdict is kept. A breach is permanent; the TTL only bounds growth. */
  private static readonly VERDICT_TTL_SECONDS = 60 * 60 * 24 * 30;

  /**
   * How long a "could not check" answer is kept.
   *
   * Short on purpose. The failure is usually a blip, so retrying in a few seconds
   * finds the service back; and it is short enough that a sustained outage does not
   * become an hour of unchecked passwords.
   */
  private static readonly UNKNOWN_TTL_SECONDS = 60;

  /**
   * Circuit breaker protecting the signup path from an outage at the range endpoint.
   * Fails open after consecutive failures, skipping the network call completely.
   */
  readonly breaker: PasswordBreachBreaker = new PasswordBreachBreaker({
    failureRateThreshold: 100,
    minimumCalls: 5,
    slidingWindow: { type: 'time', size: '60s' },
    openDuration: '30s',
  });

  readonly policy: ResiliencePolicy = ResiliencePolicy.wrap(
    new RetryPolicy({
      attempts: 3,
      backoff: { delay: '200ms', maxDelay: '2s' },
    }),
    this.breaker,
    new TimeoutPolicy({ timeout: '5s' }),
  );

  constructor(
    private readonly http: HttpService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Whether this password appears in the corpus.
   *
   * Returns false when the service could not be reached, and says so. A caller
   * cannot distinguish "not breached" from "we could not check", which is the right
   * ambiguity for a check that must not be able to deny service.
   */
  async isBreached(password: string): Promise<boolean> {
    const digest = passwordDigest(password);
    const prefix = digest.slice(0, PREFIX_LENGTH);
    const suffix = digest.slice(PREFIX_LENGTH);

    // `nullishTtl` on purpose. The loader answers `null` when it could not reach the
    // service, and cache-manager keeps a nullish value for the short TTL instead of
    // the full one. Caching "we could not check" for thirty days would leave every
    // user on a bad network unprotected until the entry expired, which is a longer
    // outage than the one that caused it.
    return (
      (await this.cache.wrap<boolean | null>(
        `breach:${digest}`,
        async () => this.ask(prefix, suffix),
        {
          ttl: PasswordBreachService.VERDICT_TTL_SECONDS,
          emptyTtl: PasswordBreachService.UNKNOWN_TTL_SECONDS,
        },
      )) === true
    );
  }

  /**
   * The lookup, answering `null` when the service could not be reached.
   *
   * `null` rather than `false` is the whole design: the caller cannot tell the two
   * apart, which is correct for a check that must not deny service, and the cache
   * can, which is what keeps a twenty-four hour verdict out of the failure path.
   */
  private async ask(prefix: string, suffix: string): Promise<boolean | null> {
    try {
      const result = await this.policy.execute(async () => {
        const response = await firstValueFrom(
          this.http.get(`${PasswordBreachService.API_URL}/${prefix}`, {
            responseType: 'text',
            // The response is `SUFFIX:COUNT` per line. Without this the transform
            // tries to parse it as JSON, because the content type is text/plain and
            // axios believes it.
            transformResponse: [(data: unknown) => data],
            // Every status is returned rather than thrown, so a 429 from the service
            // is a fact to log rather than an exception to unwind a signup with.
            validateStatus: () => true,
          }),
        );

        const status = response.status as number;

        if (status < 200 || status >= 300) {
          // Fails open, and says which status, because "the check stopped running"
          // and "no passwords were breached" look identical from the outside.
          this.logger.warn(
            `Breach check answered ${status} for one prefix, treating the password ` +
              'as not breached. Signups are not being blocked by this.',
          );

          return null;
        }

        const body = typeof response.data === 'string' ? response.data : '';
        const found = countMatches(body, suffix);

        if (found > 0) {
          this.logger.warn(
            `A password was refused because it appears ${found} time(s) in the ` +
              'breach corpus. The password itself is not logged and never left the ' +
              'process in anything but a hash prefix.',
          );
        }

        return found > 0;
      });

      return result;
    } catch (error) {
      const detail =
        error instanceof CircuitOpenError
          ? `Circuit breaker is open. ${
              error instanceof Error ? error.message : String(error)
            }`
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(
        `Breach check could not be reached, treating the password as not ` +
          `breached: ${detail}. Signups are not being blocked by this.`,
      );

      return null;
    }
  }
}

/**
 * How many characters go out.
 *
 * Five is the number the API is specified around and the one that keeps a bucket
 * small: the corpus is over a hundred million passwords, so five characters is
 * roughly a thousand entries per request.
 */
export const PREFIX_LENGTH = 5;

/**
 * The SHA-1 digest, uppercased, as the API defines it.
 *
 * Exported because the digest is the cache key and therefore worth asserting
 * directly rather than only through the service.
 */
export function passwordDigest(password: string): string {
  return createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/**
 * Counts how many times a suffix appears in a range response.
 *
 * Written as a scan rather than a `Set` split, for two reasons. The response is
 * several hundred kilobytes and splitting it allocates an array that size on every
 * signup; and the comparison has to be exact, because a prefix match would report
 * every password sharing five hex characters as breached.
 */
export function countMatches(body: string, suffix: string): number {
  for (const line of body.split('\n')) {
    // `SUFFIX:COUNT`, with the count after the first colon and possibly thousands
    // of repetitions. Only the suffix matters here: how many times it appears is
    // the log line's business.
    const separator = line.indexOf(':');

    if (separator < 0) {
      continue;
    }

    if (line.slice(0, separator).trim() === suffix) {
      return Number.parseInt(line.slice(separator + 1), 10) || 1;
    }
  }

  return 0;
}
