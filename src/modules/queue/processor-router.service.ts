import { Injectable, Logger } from '@nestjs/common';

import {
  RetentionProcessor,
  type RetentionJobPayload,
} from '../maintenance/processors/retention.processor.js';
import {
  NotificationProcessor,
  type NotificationJobPayload,
} from '../notification/processors/notification.processor.js';
import {
  MailProcessor,
  type MailJobPayload,
} from './processors/mail.processor.js';
import type { Job, JobResult } from './queue.interface.js';

/**
 * Routes a job name to the processor that handles it.
 *
 * An explicit list rather than a reflective scan, so adding a processor is a
 * provider and one line here, and so a job name nobody claims is a visible error
 * rather than a job the queue keeps reporting as successful while nothing ran.
 *
 * Named `ProcessorRouter` because `ProcessorRegistry` is the interface it
 * satisfies, and having a class and an interface with one name differing only by a
 * suffix is a trap.
 */
@Injectable()
export class ProcessorRouter {
  private readonly logger = new Logger(ProcessorRouter.name);

  constructor(
    private readonly mailProcessor: MailProcessor,
    private readonly retentionProcessor: RetentionProcessor,
    private readonly notificationProcessor: NotificationProcessor,
  ) {}

  /** True when some processor claims this name. */
  handles(name: string): boolean {
    return (
      MailProcessor.handles(name) ||
      RetentionProcessor.handles(name) ||
      NotificationProcessor.handles(name)
    );
  }

  async process(job: Job): Promise<JobResult> {
    if (MailProcessor.handles(job.name)) {
      return this.mailProcessor.process(job as Job<MailJobPayload>);
    }

    if (RetentionProcessor.handles(job.name)) {
      return this.retentionProcessor.process(job as Job<RetentionJobPayload>);
    }

    if (NotificationProcessor.handles(job.name)) {
      return this.notificationProcessor.process(
        job as Job<NotificationJobPayload>,
      );
    }

    this.logger.error(`No processor claims the job "${job.name}"`);

    // Not retryable: the same name will still be unclaimed in five seconds, and
    // retrying would fill the dead-letter list with a typo.
    return {
      ok: false,
      error: `no processor for ${job.name}`,
      retryable: false,
    };
  }
}
