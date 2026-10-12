import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { loadOptional } from '../../core/optional/optional.util.js';
import type { QueueConfig } from '../../configs/queue.config.js';
import type {
  Job,
  JobQueue,
  JobResult,
  QueueDepth,
  QueueName,
} from './queue.interface.js';
import type { ProcessorRegistry } from './in-process.dispatcher.js';

/**
 * The bullmq types this adapter uses, declared locally.
 *
 * `bullmq` is installed here as a dev dependency so its real behaviour can be
 * tested, but it is optional at runtime: a deployment that never enables the
 * queue does not have it, and a type-only `typeof import('bullmq')` would still be
 * resolved by `tsc`, which is the build-time failure this project avoids.
 */
interface BullQueueLike {
  add(
    name: string,
    data: unknown,
    options: Record<string, unknown>,
  ): Promise<{ id?: string }>;
  close(): Promise<void>;
  /**
   * Counts per job state, e.g. `{ waiting: 4, active: 1 }`.
   *
   * Declared here rather than imported from bullmq, because a type-only
   * `typeof import('bullmq')` would be resolved when the app is built and a
   * deployment without the package would fail to start rather than run the
   * in-process path. Same reason as the constructor below.
   */
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

interface BullWorkerLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): Promise<void>;
}

interface BullModuleLike {
  Queue: new (name: string, options: Record<string, unknown>) => BullQueueLike;
  Worker: new (
    queue: BullQueueLike,
    handler: (job: { name: string; data: unknown }) => Promise<unknown>,
    options: Record<string, unknown>,
  ) => BullWorkerLike;
}

export const BULLMQ_SPECIFIER = 'bullmq';

const logger = new Logger('BullMqDispatcher');

export interface BullMqDispatcherOptions {
  /** Used by the tests; production resolves it through `loadOptional`. */
  bullmq?: BullModuleLike | null;
}

/**
 * Enqueues to redis through bullmq.
 *
 * The adapter owns nothing but the mapping onto bullmq: the work is in the same
 * `ProcessorRegistry` the in-process dispatcher uses, and the retry decisions come
 * from the same `retry.policy.ts`. The duplication between the two dispatchers is
 * the retry *loop* only, because a queue backend has one and this process does not.
 *
 * It is deliberately constructed with the module rather than importing it. A
 * static `import { Queue } from 'bullmq'` is resolved when the app is built, so a
 * deployment without the package would fail to start rather than run the
 * in-process path that is supposed to be the default.
 */
export class BullMqDispatcher implements JobQueue, OnModuleDestroy {
  readonly driver = 'bullmq' as const;

  private readonly queues = new Map<QueueName, BullQueueLike>();
  private readonly workers: BullWorkerLike[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly processors: ProcessorRegistry,
    private readonly bullmq: BullModuleLike | null = loadOptional<BullModuleLike>(
      BULLMQ_SPECIFIER,
    ),
  ) {}

  private get config(): QueueConfig {
    return this.configService.getOrThrow<QueueConfig>('queue');
  }

  /** False when the package is absent, which is how the factory chooses a driver. */
  isAvailable(): boolean {
    return this.bullmq !== null;
  }

  /** Which queue a job name belongs on, so a worker only sees its own work. */
  private queueOf(job: Job): QueueName {
    return job.name.startsWith('retention') ||
      job.name.startsWith('maintenance')
      ? 'maintenance'
      : job.name.startsWith('notify')
        ? 'notification'
        : job.name.startsWith('digest')
          ? 'digest'
          : 'mail';
  }

  /**
   * Current counts for one queue, or `null` when Redis cannot be asked.
   *
   * `null` rather than zeroes: an unreachable store means the backlog is
   * unknown, and a dashboard that reported zero waiting jobs during a Redis
   * outage would look healthier than an application with no jobs at all.
   */
  async depth(queue: QueueName): Promise<QueueDepth | null> {
    try {
      const counts = await this.queue(queue).getJobCounts(
        'waiting',
        'active',
        'failed',
        'delayed',
      );

      return {
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        failed: counts['failed'] ?? 0,
        delayed: counts['delayed'] ?? 0,
      };
    } catch (error) {
      // Opening the queue is what fails when the package is absent, so this covers
      // both "redis is down" and "bullmq is not installed" — the same answer, and
      // the right one for both.
      logger.warn(
        `Could not read the backlog for ${queue}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }

  /**
   * Opens a queue and its worker, once per queue.
   *
   * Deferred to first use rather than the constructor: opening a connection in
   * the constructor would make a redis outage at boot a crash, and the whole point
   * is that the app starts and falls back.
   */
  private queue(queue: QueueName): BullQueueLike {
    const existing = this.queues.get(queue);

    if (existing !== undefined) {
      return existing;
    }

    if (this.bullmq === null) {
      throw new Error(
        `bullmq is not installed, so the ${queue} queue cannot be used. ` +
          `Run: npm install ${BULLMQ_SPECIFIER}`,
      );
    }

    const options: Record<string, unknown> = {
      connection: { url: this.config.url },
      prefix: this.config.prefix,
    };

    const created = new this.bullmq.Queue(queue, options);
    this.queues.set(queue, created);

    const worker = new this.bullmq.Worker(
      created,
      async (job) => this.run(job.name, job.data),
      {
        connection: { url: this.config.url },
        concurrency: this.limitFor(queue),
      },
    );

    worker.on('error', (error) =>
      logger.error(`Queue worker error on ${queue}: ${String(error)}`),
    );
    worker.on('failed', (job, error) =>
      logger.error(
        `Job ${String((job as { name?: string })?.name)} exhausted its attempts: ` +
          `${String(error)}`,
      ),
    );

    this.workers.push(worker);

    return created;
  }

  private limitFor(queue: QueueName): number {
    const perQueue: Partial<Record<QueueName, number>> =
      this.config.concurrency;

    return Math.max(1, perQueue[queue] ?? this.config.inProcessConcurrency);
  }

  /**
   * Adds a job, and resolves once bullmq has accepted it.
   *
   * The retry options mirror what the in-process dispatcher does by hand, and both
   * read the numbers from `queue.config.ts`, so turning the queue on does not
   * change how many attempts a job gets.
   */
  async enqueue(queue: QueueName, job: Job): Promise<void> {
    const options: Record<string, unknown> = {
      attempts: this.config.retry.attempts,
      backoff: {
        type: 'exponential',
        delay: this.config.retry.backoffDelay,
      },
      removeOnComplete: { age: this.config.removeOnCompleteAfter / 1000 },
      removeOnFail: { age: this.config.removeOnFailAfter / 1000 },
      // A permanent 4xx is not retried by the processor: bullmq cannot see that,
      // so the handler has to signal it by throwing UnrecoverableError.
    };

    await this.queue(queue).add(job.name, job, options);
  }

  /**
   * The worker side: run the job, then decide what to tell bullmq.
   *
   * bullmq retries on a thrown error, so a permanent failure has to stop it
   * explicitly. Wrapping it in `UnrecoverableError` is the documented way, and it
   * is why the classification has to survive the trip through `MailService`.
   */
  private async run(name: string, payload: unknown): Promise<unknown> {
    const result: JobResult = await this.processors.process({ name, payload });

    if (result.ok) {
      return result;
    }

    if (result.retryable === false) {
      throw this.unrecoverable(result);
    }

    throw new Error(result.error ?? 'job failed');
  }

  /**
   * Builds the error bullmq treats as final.
   *
   * Duck-typed on the name because `UnrecoverableError` only exists when the
   * package is installed, and reaching for the class would make this file fail to
   * load in a deployment that does not have it.
   */
  private unrecoverable(result: JobResult): Error {
    const error = new Error(result.error ?? 'job failed') as Error & {
      name: string;
    };

    error.name = 'UnrecoverableError';

    return error;
  }

  async onModuleDestroy(): Promise<void> {
    // Workers first: closing a queue while its worker is still draining drops
    // the jobs in flight.
    for (const worker of this.workers.splice(0)) {
      await worker.close().catch(() => undefined);
    }

    for (const queue of this.queues.values()) {
      await queue.close().catch(() => undefined);
    }

    this.queues.clear();
  }
}
