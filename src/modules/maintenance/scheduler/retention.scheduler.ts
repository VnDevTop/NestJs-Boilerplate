import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { retentionConfig } from '../../../configs/retention.config.js';
import { JOB_QUEUE } from '../../queue/queue.tokens.js';
import type { JobQueue } from '../../queue/queue.interface.js';
import { QUEUE_NAMES } from '../../queue/queue.interface.js';
import {
  RETENTION_JOB,
  type RetentionJobPayload,
} from '../processors/retention.processor.js';
import { RetentionTrigger } from '../entities/retention-trigger.enum.js';

/** Registry name for the job, so it can be found or removed later. */
export const RETENTION_CRON_NAME = 'retention';

/**
 * Enqueues the retention run once a night.
 *
 * Scheduled with `SchedulerRegistry` and a `CronJob` built at bootstrap rather
 * than with the `@Cron` decorator, because the decorator needs its expression as
 * a literal at the moment the class is defined. `RETENTION_SCHEDULE` is therefore
 * a value this reads, not something baked into the compiled output, and changing
 * it does not need a rebuild of the decorator's arguments.
 *
 * It enqueues rather than calling the service, which is the point of the whole
 * queue abstraction: `JOB_QUEUE` is BullMQ when redis is configured and an
 * in-process promise when it is not, so this fires either way. A retention job
 * gated on redis being up is a retention job that skips exactly the outage where
 * the database needs it.
 */
@Injectable()
export class RetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionScheduler.name);

  constructor(
    @Inject(retentionConfig.KEY)
    private readonly config: ConfigType<typeof retentionConfig>,
    @Inject(JOB_QUEUE)
    private readonly queue: JobQueue,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log(
        'Retention is disabled (RETENTION_ENABLED=false). The admin route stays available.',
      );
      return;
    }

    this.schedule();
  }

  private schedule(): void {
    // A malformed expression throws from the cron library. Falling back to a
    // known-good default beats refusing to boot: the alternative is an outage
    // caused by a typo in an environment variable, over a housekeeping job that
    // nobody is waiting on.
    let job: CronJob;

    try {
      job = new CronJob(this.config.schedule, () => {
        void this.enqueue();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `RETENTION_SCHEDULE ("${this.config.schedule}") is not a valid cron ` +
          `expression, so retention will not run automatically: ${message}. ` +
          'The admin route still works.',
      );

      return;
    }

    this.registry.addCronJob(RETENTION_CRON_NAME, job);
    job.start();

    this.logger.log(
      `Retention scheduled at "${this.config.schedule}" via the ${this.queue.driver} queue`,
    );
  }

  /**
   * Hands the job to the queue.
   *
   * Failures are logged and swallowed. A scheduler callback that rejects is an
   * unhandled rejection, and one that throws would be invisible to the queue,
   * which is where the retry budget and the dead-letter list live. The job is
   * idempotent, so the next night picks up whatever this run would have done.
   */
  private async enqueue(): Promise<void> {
    const payload: RetentionJobPayload = { trigger: RetentionTrigger.Cron };

    try {
      await this.queue.enqueue(QUEUE_NAMES.maintenance, {
        name: RETENTION_JOB,
        payload,
      });

      this.logger.log(
        `Enqueued ${RETENTION_JOB} at ${new Date().toISOString()}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Could not enqueue ${RETENTION_JOB}: ${message}`);
    }
  }
}
