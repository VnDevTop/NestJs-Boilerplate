import { Logger } from '@nestjs/common';

import type { Job, JobContext, JobResult } from './queue.interface.js';
import type { RedisClientService } from './redis-client.service.js';
import type { ProcessorRegistry } from './in-process.dispatcher.js';
import { retryWindowMs, type BackoffOptions } from './retry.policy.js';

const logger = new Logger('DedupeGuard');

export interface DedupeOptions {
  /** Backoff settings, so the key lives as long as the retries can take. */
  backoff?: BackoffOptions;
  /** Overrides the computed window. Only for a test. */
  ttlSeconds?: number;
}

/**
 * Stops the same work being done twice.
 *
 * ## Why this sits around the processor and not at `enqueue`
 *
 * A queue is at-least-once: a job can be delivered more than once, and that
 * happens at *execution*, not at enqueue. A check in `enqueue` would never see the
 * second delivery, so the duplicate it was meant to prevent would still be sent.
 * The guard has to run where the work runs.
 *
 * ## Why the key is released on a retryable failure
 *
 * The obvious implementation, claim the key and hold it, silently breaks retries:
 *
 * ```text
 * attempt 1  SET NX succeeds, mail fails with a timeout
 * attempt 2  SET NX fails because the key is still there -> skipped
 *            bullmq sees a clean return -> job marked done
 *            the mail is never sent
 * ```
 *
 * The user gets no email, no error, and no entry anywhere. So a retryable failure
 * releases the key, and only a success or a permanent failure keeps it.
 *
 * ## Why a redis outage fails open
 *
 * `setIfAbsent` answers `null` when redis could not be asked. That is treated as
 * permission to proceed. The alternative loses a real email because redis blinked;
 * the cost here is a possible duplicate, which a mail client collapses anyway.
 *
 * ## Where the duplicate actually comes from
 *
 * A redelivery racing a first attempt is the case this exists for: two workers,
 * one job, two emails. The key is claimed before the work and held until the TTL,
 * so the loser of the race skips.
 */
export class DedupeGuard implements ProcessorRegistry {
  private readonly ttlSeconds: number;

  constructor(
    private readonly inner: ProcessorRegistry,
    private readonly redis: RedisClientService,
    options: DedupeOptions = {},
  ) {
    this.ttlSeconds =
      options.ttlSeconds ?? Math.ceil(retryWindowMs(options.backoff) / 1000);
  }

  /** The window a key is held for, exposed so a test can assert the arithmetic. */
  get ttl(): number {
    return this.ttlSeconds;
  }

  async process(job: Job, context?: JobContext): Promise<JobResult> {
    const key = job.dedupeKey;

    if (key === undefined || key === '') {
      return this.inner.process(job, context);
    }

    const claimed = await this.redis.setIfAbsent(
      key,
      'claimed',
      this.ttlSeconds,
    );

    if (claimed === false) {
      // Someone else is already doing this work. Reporting success is deliberate:
      // from bullmq's side the job did its job, and reporting a failure would
      // burn the retry budget on a job that is not broken.
      logger.log(
        `Skipping ${job.name}: dedupe key already held, this delivery is a repeat`,
      );

      return { ok: true };
    }

    if (claimed === null) {
      logger.warn(
        `Deduplication unavailable for ${job.name}, running it anyway. ` +
          'A duplicate is possible; a lost email is not.',
      );

      return this.inner.process(job, context);
    }

    return this.claimed(key, job, context);
  }

  private async claimed(
    key: string,
    job: Job,
    context?: JobContext,
  ): Promise<JobResult> {
    try {
      const result = await this.inner.process(job, context);

      if (result.cancelled === true) {
        // The work was not done, so the key must not be held. The operator may
        // well run it again, and a held key would skip the second attempt —
        // which is the opposite of what cancelling a job should mean.
        await this.redis.release(key);

        return result;
      }

      if (result.ok || result.retryable === false) {
        // Success keeps the key, which is the entire mechanism. A permanent
        // failure keeps it too: the job is finished, and releasing it would let a
        // stale redelivery try again.
        return result;
      }

      await this.redis.release(key);

      return result;
    } catch (error) {
      // The processor catches its own failures, so this is a bug rather than a
      // provider problem. The key is released because the job did not complete.
      await this.redis.release(key);

      throw error;
    }
  }
}
