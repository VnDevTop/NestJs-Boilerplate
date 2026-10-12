import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { QueueConfig } from '../../configs/queue.config.js';
import type {
  Job,
  JobQueue,
  JobResult,
  QueueDepth,
  QueueName,
} from './queue.interface.js';
import type { DeadLetterService } from './dead-letter.service.js';
import { backoffDelay } from './retry.policy.js';
import {
  MailProcessor,
  type MailJobPayload,
} from './processors/mail.processor.js';

/** A unit of work plus how many times it has already been tried. */
interface PendingJob {
  queue: QueueName;
  job: Job;
  attempt: number;
}

/**
 * Runs jobs in this process, under a bounded number at a time.
 *
 * This is the default, not a consolation prize. It is what runs when `bullmq` is
 * not installed, when `QUEUE_ENABLED=false`, and when redis is unreachable during
 * an incident — and it is the path nobody exercises in development if the queue is
 * on, which is exactly why the work lives in a processor both paths call rather
 * than being written twice.
 *
 * It also implements the retry budget itself, because there is no queue backend to
 * do it. That duplication is real: `retry.policy.ts` is what both this and the
 * BullMQ adapter call, so the *decisions* are shared even though the *loop* is not.
 */
export class InProcessDispatcher implements JobQueue, OnModuleDestroy {
  readonly driver = 'in-process' as const;

  private readonly logger = new Logger(InProcessDispatcher.name);
  private readonly waiting: PendingJob[] = [];
  private readonly active = new Map<QueueName, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private shuttingDown = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly processors: ProcessorRegistry,
    private readonly deadLetter?: DeadLetterService,
  ) {}

  private get config(): QueueConfig {
    return this.configService.getOrThrow<QueueConfig>('queue');
  }

  /**
   * Accepts a job and returns before it runs.
   *
   * The work is started from a detached promise with its own catch, so nothing
   * here can reject into a caller that is already returning an http response.
   */
  async enqueue(queue: QueueName, job: Job): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn(`Dropping ${job.name}, the dispatcher is shutting down`);

      return;
    }

    if (this.waiting.length >= this.maxBacklog) {
      // Refusing is better than growing: this backlog is heap. A traffic spike
      // that outruns the provider would otherwise take the process down, which
      // costs far more than the jobs it was going to send anyway.
      this.logger.error(
        `In-process backlog is full (${this.maxBacklog}), dropping ${job.name}. ` +
          'Raise QUEUE_IN_PROCESS_CONCURRENCY or enable the queue.',
      );

      return;
    }

    this.waiting.push({ queue, job, attempt: 1 });

    void this.drain(queue);
  }

  /**
   * Upper bound on queued work. Not in the config yet because there is no
   * defensible default from the plan, and an unbounded list is the failure this
   * guards against.
   */
  private get maxBacklog(): number {
    return this.config.inProcessConcurrency * 50;
  }

  /**
   * Starts as much queued work for a queue as its concurrency allows.
   *
   * Keyed per queue, because the config gives each one its own limit: mail is the
   * slowest and the provider rate-limits it, while maintenance is batch work with
   * nobody waiting. One shared counter would let a backlog of maintenance block
   * mail, which is the opposite of what the per-queue limits are for.
   */
  private async drain(queue: QueueName): Promise<void> {
    // The parentheses matter: `??` binds looser than `<`, so without them this
    // compares 0 to the limit and then falls back, and the limiter stops limiting.
    while ((this.active.get(queue) ?? 0) < this.limitFor(queue)) {
      const next = this.take(queue);

      if (next === null) {
        return;
      }

      this.active.set(queue, (this.active.get(queue) ?? 0) + 1);
      void this.run(next);
    }
  }

  private take(queue: QueueName): PendingJob | null {
    const index = this.waiting.findIndex((entry) => entry.queue === queue);

    if (index < 0) {
      return null;
    }

    return this.waiting.splice(index, 1)[0];
  }

  private limitFor(queue: QueueName): number {
    const perQueue: Partial<Record<QueueName, number>> =
      this.config.concurrency;

    return Math.max(1, perQueue[queue] ?? this.config.inProcessConcurrency);
  }

  /**
   * Runs one job, then either re-queues it or gives up.
   *
   * Every exit is caught. A rejection here would be an unhandled rejection, and
   * Node ends the process on one, so the catch is load-bearing rather than
   * defensive tidiness.
   */
  private async run(entry: PendingJob): Promise<void> {
    let result: JobResult;

    try {
      result = await this.processors.process(entry.job);
    } catch (error) {
      // The mail processor catches its own failures, so reaching this is a bug in
      // a processor rather than a provider problem. Retried, because discarding
      // real work over an unclassified fault is the worse mistake.
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Job ${entry.job.name} threw unexpectedly: ${message}`);
      result = { ok: false, error: message, retryable: true };
    } finally {
      this.active.set(
        entry.queue,
        Math.max(0, (this.active.get(entry.queue) ?? 1) - 1),
      );
    }

    try {
      await this.afterAttempt(entry, result);
    } catch (error) {
      this.logger.error(
        `Post-attempt handling for ${entry.job.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Whether it succeeded, failed or was re-queued, this slot is free again.
    await this.drain(entry.queue);
  }

  private async afterAttempt(
    entry: PendingJob,
    result: JobResult,
  ): Promise<void> {
    if (result.ok) {
      return;
    }

    if (result.retryable === false) {
      this.logger.error(
        `Job ${entry.job.name} failed permanently after ${entry.attempt} attempt(s): ` +
          `${result.error ?? 'no reason given'}`,
      );
      await this.deadLetter?.record(entry.job, result, entry.attempt);

      return;
    }

    if (entry.attempt >= this.config.retry.attempts) {
      this.logger.error(
        `Job ${entry.job.name} exhausted its ${this.config.retry.attempts} attempts: ` +
          `${result.error ?? 'no reason given'}`,
      );
      await this.deadLetter?.record(entry.job, result, entry.attempt);

      return;
    }

    const delay = backoffDelay(entry.attempt, {
      delay: this.config.retry.backoffDelay,
      maxDelay: this.config.retry.backoffMaxDelay,
    });

    const next: PendingJob = { ...entry, attempt: entry.attempt + 1 };

    this.logger.warn(
      `Job ${next.job.name} failed, retrying in ${delay}ms ` +
        `(attempt ${next.attempt}/${this.config.retry.attempts}): ${result.error ?? 'no reason'}`,
    );

    await this.wait(delay, () => {
      if (this.shuttingDown) {
        return;
      }

      this.waiting.push(next);
      void this.drain(next.queue);
    });
  }

  /**
   * A tracked timer, so shutdown can clear it.
   *
   * An untracked `setTimeout` keeps the event loop alive, which is the difference
   * between a test suite that finishes and one that hangs until the process is
   * killed.
   */
  private wait(ms: number, then: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        then();
        resolve();
      }, ms);

      this.timers.add(timer);
    });
  }

  /**
   * This dispatcher's own backlog, which it knows exactly.
   *
   * Per queue rather than in total, because the config gives each one its own
   * concurrency limit and an operator asking about mail does not want to hear that
   * maintenance is busy.
   *
   * `failed` is always zero and that is honest rather than convenient: the
   * in-process path has no store to keep a failure in, so a dead-letter entry is
   * the only record that a job ever failed. A job that failed did not leave
   * anything behind to count.
   */
  async depth(queue: QueueName): Promise<QueueDepth> {
    return {
      waiting: this.waiting.filter((entry) => entry.queue === queue).length,
      active: this.active.get(queue) ?? 0,
      failed: 0,
      delayed: 0,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;

    for (const timer of this.timers) {
      clearTimeout(timer);
    }

    this.timers.clear();
  }
}

/**
 * Resolves a job name to the processor that handles it.
 *
 * An interface rather than a direct `MailProcessor` call so adding a notification
 * processor is a provider in the module and not an edit to the dispatcher.
 */
export interface ProcessorRegistry {
  process(job: Job): Promise<JobResult>;
}

/** Payload type re-exported so callers do not import the processor's file. */
export type { MailJobPayload };
export { MailProcessor };
