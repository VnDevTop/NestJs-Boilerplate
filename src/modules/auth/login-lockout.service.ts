import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { RedisClientService } from '../queue/redis-client.service.js';

/**
 * A temporary lockout after repeated failures, the way a desktop operating
 * system does it: count the failures, block for a while, then let the person
 * try again.
 *
 * Deliberately not a permanent lockout. A permanent one is a denial of service
 * anyone can inflict on a victim's account by guessing their password wrong five
 * times, and the person who needs to get back in is the person who can least
 * afford to be locked out. The block length grows with the number of failures and
 * then stops growing, so a persistent attacker is slowed by a lot while somebody
 * who mistyped twice is slowed by nothing.
 *
 * **Redis, not the database.** The count has to hold across replicas for the same
 * reason the rate limit does: one limit per process means a caller behind three
 * replicas gets three attempts before any of them notices.
 *
 * **Fails open.** An unreachable redis means the attempt is allowed through and
 * the failure is not counted. Failing closed would let a cache outage lock
 * everybody out of login, which is the worst possible response to an outage that
 * is probably already costing somebody revenue.
 */

/** Failures before the first block. */
export const LOCKOUT_THRESHOLD = 5;

/** The first block, and the step added for each failure past the threshold. */
export const LOCKOUT_BASE_MINUTES = 1;
export const LOCKOUT_STEP_MINUTES = 1;
export const LOCKOUT_MAX_MINUTES = 15;

/** How long a failure count survives with no further attempts. */
const FAILURE_TTL_SECONDS = 60 * 60;

/** Namespace, kept clear of the cache and throttle keys. */
const PREFIX = 'lockout:login';

export interface LockoutState {
  /** True while the account is blocked. */
  readonly blocked: boolean;
  /** Whole seconds until the block lifts. Zero when not blocked. */
  readonly retryAfterSeconds: number;
  /**
   * True only for the attempt that starts a block, so the caller sends one
   * notification per lockout rather than one per rejected request.
   */
  readonly firstBlock: boolean;
}

const ALLOWED: LockoutState = {
  blocked: false,
  retryAfterSeconds: 0,
  firstBlock: false,
};

@Injectable()
export class LoginLockoutService {
  private readonly logger = new Logger(LoginLockoutService.name);

  constructor(private readonly redis: RedisClientService) {}

  /** Whether this address may attempt a login right now. */
  async inspect(email: string): Promise<LockoutState> {
    const key = this.key(email);
    const client = await this.client();

    if (client === null) {
      return ALLOWED;
    }

    try {
      const blockedUntil = await client.get(key);

      if (blockedUntil === null) {
        return ALLOWED;
      }

      const remaining = Number(blockedUntil) - Date.now();

      if (remaining <= 0) {
        // The key has a ttl and should have gone on its own. Clearing it here
        // makes the expiry correct even if a clock moved or a write was lost.
        await client.del(key);

        return ALLOWED;
      }

      return {
        blocked: true,
        retryAfterSeconds: Math.ceil(remaining / 1000),
        firstBlock: false,
      };
    } catch (error) {
      return this.failOpen(error, 'inspect');
    }
  }

  /**
   * Counts one failure and blocks if it is the one that crossed the threshold.
   *
   * Returns `firstBlock` for the attempt that starts a block, so the caller
   * notifies the owner once. Every later attempt during the same block reports
   * blocked without notifying, because a caller who keeps guessing would otherwise
   * generate a notification per request.
   */
  async recordFailure(email: string): Promise<LockoutState> {
    const key = this.key(email);
    const client = await this.client();

    if (client === null) {
      return ALLOWED;
    }

    try {
      const failures = await client.incr(this.failureKey(email));

      if (failures === 1) {
        await client.expire(this.failureKey(email), FAILURE_TTL_SECONDS);
      }

      if (failures < LOCKOUT_THRESHOLD) {
        return ALLOWED;
      }

      const blockSeconds = this.blockSeconds(failures);
      const alreadyBlocked = await client.get(key);

      await client.set(key, String(Date.now() + blockSeconds * 1000), {
        EX: blockSeconds,
      });

      if (alreadyBlocked !== null) {
        // Still blocking. The attempt extends the block, which is the intent:
        // somebody hammering a locked account should not have the lock lapse
        // while they are still hammering it.
        return {
          blocked: true,
          retryAfterSeconds: blockSeconds,
          firstBlock: false,
        };
      }

      return {
        blocked: true,
        retryAfterSeconds: blockSeconds,
        firstBlock: true,
      };
    } catch (error) {
      return this.failOpen(error, 'recordFailure');
    }
  }

  /** Clears the count and the block after a successful sign-in. */
  async reset(email: string): Promise<void> {
    const client = await this.client();

    if (client === null) {
      return;
    }

    try {
      await client.del([this.key(email), this.failureKey(email)]);
    } catch (error) {
      this.failOpen(error, 'reset');
    }
  }

  /**
   * How long the block lasts for a given failure count.
   *
   * One minute at the threshold, one more minute per further failure, and a hard
   * ceiling. The ceiling is the important part: an unbounded multiplier lets one
   * sustained attack park an account for hours, which is a denial of service
   * dressed up as a defence.
   */
  blockSeconds(failures: number): number {
    const minutes = Math.min(
      LOCKOUT_MAX_MINUTES,
      LOCKOUT_BASE_MINUTES +
        (failures - LOCKOUT_THRESHOLD) * LOCKOUT_STEP_MINUTES,
    );

    return Math.max(1, minutes) * 60;
  }

  /**
   * The redis key for an address.
   *
   * Hashed, because these keys live in redis where they are visible to anybody
   * with access, and a key that reads a user's address turns the redis instance
   * into a mailing list. The same reason `user:email` is hashed in the cache.
   */
  private key(email: string): string {
    return `${PREFIX}:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  }

  private failureKey(email: string): string {
    return `${PREFIX}:fail:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  }

  private async client() {
    try {
      return await this.redis.getClient();
    } catch (error) {
      this.failOpen(error, 'connect');

      return null;
    }
  }

  private failOpen(error: unknown, where: string): LockoutState {
    this.logger.warn(
      `Login lockout unavailable during ${where}, allowing the attempt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return ALLOWED;
  }
}
