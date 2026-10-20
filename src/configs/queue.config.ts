import { registerAs } from '@nestjs/config';

/**
 * Background queue settings.
 *
 * Not exported from `configs/index.ts` and not in the `load` array of
 * `app.module.ts`: `bullmq` is an optional package, so this namespace is loaded
 * with `ConfigModule.forFeature()` inside `QueueModule`, which only exists when
 * the queue is enabled.
 *
 * The redis url is read from the `redis` namespace rather than declared here,
 * so the queue and the shared throttler cannot end up on two different servers
 * by accident. What this namespace adds is everything about how work is
 * scheduled and retried.
 */

export type QueueName = 'mail' | 'notification' | 'maintenance' | 'digest';

export interface QueueConfig {
  /**
   * Whether jobs leave the request cycle at all. When false the same processors
   * run in process under a bounded limiter, so turning the queue off is a
   * config change and not a code change.
   */
  enabled: boolean;
  /** One connection string for the queue's own keys, including the database. */
  url: string;
  /**
   * Prefix on every queue key. Separate from the cache prefix on purpose: the
   * cache evicts by TTL and the queue must not, or a BullMQ key would expire
   * while its job is still due.
   */
  prefix: string;
  /**
   * How long a job may sit in the queue before it is discarded. Bounds the
   * backlog after an outage, rather than replaying a week of mail on recovery.
   */
  jobTimeout: number;
  retry: QueueRetryOptions;
  concurrency: Record<QueueName, number>;
  /** How long to wait between deleting finished jobs, in milliseconds. */
  removeOnCompleteAfter: number;
  /** How long a failed job is kept before the dead-letter list owns it. */
  removeOnFailAfter: number;
  /**
   * How long a job's progress is kept, in milliseconds.
   *
   * Long enough for an operator to come back to a job that is still running,
   * and long enough for a redelivery to find the record of its first attempt.
   * Short enough that the store does not keep a history of every job the
   * application has ever run: the progress of a job that finished three days
   * ago is not progress, it is clutter.
   */
  progressTtl: number;
  /**
   * Whether jobs run in process when the queue is disabled or redis is
   * unreachable. Off would mean silently dropping mail instead of sending it
   * late, so it is on by default.
   */
  inProcessFallback: boolean;
  /** Cap on simultaneously running in-process jobs. */
  inProcessConcurrency: number;
}

export interface QueueRetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Base delay in milliseconds; attempt N waits `delay * 2^(N-1)`. */
  backoffDelay: number;
  /** Ceiling for a single backoff wait, in milliseconds. */
  backoffMaxDelay: number;
}

/**
 * Per-queue concurrency. Mail is the lowest because it is the slowest and the
 * provider rate-limits; maintenance is highest because it is batch work with
 * no user waiting on it.
 */
const DEFAULT_CONCURRENCY: Record<QueueName, number> = {
  mail: 5,
  notification: 5,
  maintenance: 1,
  digest: 2,
};

const flag = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === 'true';

const perQueue = (value: string | undefined, queue: QueueName): number =>
  Number(value ?? DEFAULT_CONCURRENCY[queue]);

export const queueConfig = registerAs('queue', (): QueueConfig => ({
  enabled: flag(process.env.QUEUE_ENABLED),
  url: process.env.QUEUE_REDIS_URL ?? process.env.REDIS_URL ?? '',
  prefix: process.env.QUEUE_PREFIX ?? 'queue',
  jobTimeout: Number(process.env.QUEUE_JOB_TIMEOUT ?? 300_000),
  retry: {
    attempts: Number(process.env.QUEUE_RETRY_ATTEMPTS ?? 5),
    backoffDelay: Number(process.env.QUEUE_RETRY_DELAY ?? 1_000),
    backoffMaxDelay: Number(process.env.QUEUE_RETRY_MAX_DELAY ?? 60_000),
  },
  concurrency: {
    mail: perQueue(process.env.QUEUE_CONCURRENCY_MAIL, 'mail'),
    notification: perQueue(
      process.env.QUEUE_CONCURRENCY_NOTIFICATION,
      'notification',
    ),
    maintenance: perQueue(
      process.env.QUEUE_CONCURRENCY_MAINTENANCE,
      'maintenance',
    ),
    digest: perQueue(process.env.QUEUE_CONCURRENCY_DIGEST, 'digest'),
  },
  removeOnCompleteAfter: Number(
    process.env.QUEUE_REMOVE_COMPLETE_AFTER ?? 3_600_000,
  ),
  removeOnFailAfter: Number(process.env.QUEUE_REMOVE_FAIL_AFTER ?? 86_400_000),
  progressTtl: Number(process.env.QUEUE_PROGRESS_TTL ?? 86_400_000),
  inProcessFallback: flag(process.env.QUEUE_IN_PROCESS_FALLBACK, true),
  inProcessConcurrency: Number(process.env.QUEUE_IN_PROCESS_CONCURRENCY ?? 5),
}));
