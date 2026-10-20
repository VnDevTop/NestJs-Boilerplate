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
import { TracingService } from '../../core/tracing/index.js';
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
    // Default-constructed so a test that builds the router with three fakes keeps
    // working, and so a deployment without `@opentelemetry/api` gets the no-op
    // service rather than a missing dependency.
    private readonly tracing: TracingService = new TracingService(),
  ) {}

  /** True when some processor claims this name. */
  handles(name: string): boolean {
    return (
      MailProcessor.handles(name) ||
      RetentionProcessor.handles(name) ||
      NotificationProcessor.handles(name)
    );
  }

  /**
   * Wraps the run in a `queue.process` span.
   *
   * A job is not inside a request — the thing that enqueued it answered minutes
   * ago — so without a span here a job's work has no trace of its own and cannot
   * be followed from the enqueue to the provider call. The trace id on the job's
   * log lines and the spans below it then come from this one.
   */
  async process(job: Job): Promise<JobResult> {
    return this.tracing.withSpan(
      'queue.process',
      {
        'messaging.system': 'in-house-queue',
        'messaging.operation': 'process',
        'messaging.message.name': job.name,
        // The id of this run, which is what identifies the message. The dedupe
        // key is carried separately because it identifies the *work* across the
        // retries of a run, and a span that can be found by either is worth more
        // than one that can be found by only one.
        'messaging.message.id': job.id,
        'messaging.dedupe_key': job.dedupeKey ?? '',
      },
      () => this.route(job),
    );
  }

  private async route(job: Job): Promise<JobResult> {
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
