import { Injectable, Logger } from '@nestjs/common';

import type { Job, JobResult } from '../../queue/queue.interface.js';
import { NotificationService } from '../notification.service.js';
import {
  isNotificationEventKey,
  type NotificationEventData,
  type NotificationEventKey,
} from '../notification.events.js';
import type { ChannelDelivery } from '../types/index.js';

/**
 * The one job name this processor answers to.
 *
 * `notify.` rather than `notification.` is a naming convention, not a routing
 * rule: the queue a job lands on is chosen by the caller at enqueue time
 * (`QUEUE_NAMES.notification`), and the processor is found by an exact name
 * match in `ProcessorRouter`. The prefix still matters, because a job name is
 * what an operator reads in a dead-letter entry and in the logs, and `mail.send`
 * and `notify.send` saying what they are is worth more than the symmetry with the
 * queue name.
 */
export const NOTIFICATION_JOB = 'notify.send';

/**
 * What a notification job carries.
 *
 * An event name and its data, never a rendered message. Rendering inside the job
 * means a template changed between the enqueue and the run is picked up rather than
 * frozen, and a template bug fails the job rather than the request that triggered
 * it.
 *
 * The payload crosses a queue boundary, so it has to survive JSON. Every event's
 * data is plain strings and numbers for that reason.
 */
export interface NotificationJobPayload {
  event: NotificationEventKey;
  data: NotificationEventData[NotificationEventKey];
  userId?: string;
  /**
   * The request that raised this event.
   *
   * Carried in the payload for the same reason as `MailJobPayload.requestId`: the
   * delivery happens later, when the async context that held it is gone, and a
   * `notification_logs` row that cannot be joined to its request is a row nobody
   * can follow back to a person.
   */
  requestId?: string;
}

/**
 * Runs a notification as a queue job.
 *
 * Both dispatchers call this, which is what makes the in-process path a real
 * fallback rather than a second implementation.
 */
@Injectable()
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notifications: NotificationService) {}

  /** True for the job name this processor handles, so routing stays in one place. */
  static handles(name: string): boolean {
    return name === NOTIFICATION_JOB;
  }

  /**
   * Delivers one notification.
   *
   * **Never throws**, and never reports a partial delivery as a failure. A
   * notification that reached Slack but not Telegram is not work that failed: it is
   * work that is done as far as it can be, and retrying it would deliver the Slack
   * copy again. So the job succeeds whenever at least one channel took it, and the
   * dead-letter list stays a list of things nobody received at all.
   */
  async process(job: Job<NotificationJobPayload>): Promise<JobResult> {
    const payload = this.validate(job.payload);

    if (payload === null) {
      // Retrying a malformed payload can only produce the same malformed payload.
      return {
        ok: false,
        error: `Malformed ${NOTIFICATION_JOB} payload`,
        retryable: false,
      };
    }

    try {
      const outcome = await this.notifications.notify(
        payload.event,
        payload.data as never,
        // The request id travels with the job rather than being looked up, because
        // this runs in the worker and the request that enqueued it is out of scope.
        { userId: payload.userId, requestId: payload.requestId },
      );

      return this.toJobResult(outcome.deliveries);
    } catch (error) {
      // The service absorbs channel failures, so a throw here is either the
      // `throwOnFailure` escape hatch or a bug in the service. Left retryable,
      // because discarding a real notification over a fault nobody has classified
      // yet is the worse mistake, and a rejected promise here would be an unhandled
      // rejection in the in-process dispatcher.
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Notification job ${job.name} threw: ${message}`);

      return { ok: false, error: message, retryable: true };
    }
  }

  /**
   * The classification, and it is the opposite of the mail processor's.
   *
   * Mail is one recipient and one provider, so a failure is the job's failure.
   * A notification is several channels, and the question worth asking is whether
   * anybody received it. Success on a partial delivery is what stops a broken
   * Telegram webhook from queueing five duplicates of every Slack alert.
   *
   * A total failure is retryable only while something was worth retrying: a channel
   * that refused with a 4xx will refuse identically, so retrying spends the budget
   * and delays the dead-letter entry that says a credential is wrong.
   */
  private toJobResult(deliveries: ChannelDelivery[]): JobResult {
    if (deliveries.length === 0) {
      // Notifications are off, or no channel is enabled. A success: the deployment
      // was told not to send, and a failure here would fill the dead-letter list
      // with work nobody asked for.
      return { ok: true };
    }

    const attempted = deliveries.filter((entry) => entry.skipped !== true);

    if (attempted.length === 0) {
      // Every channel was muted for this user. Also a success, and deliberately so:
      // a user who muted everything must not have their event retried five times by
      // a queue that thinks nothing was delivered.
      return { ok: true };
    }

    if (attempted.some((entry) => entry.delivered)) {
      return { ok: true };
    }

    const reasons = attempted
      .map((entry) => `${entry.channel}: ${entry.error ?? 'failed'}`)
      .join('; ');

    const allPermanent = attempted.every((entry) => entry.permanent === true);

    return {
      ok: false,
      error: `no channel delivered it (${reasons})`,
      retryable: !allPermanent,
    };
  }

  private validate(payload: unknown): NotificationJobPayload | null {
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }

    const { event, data, userId } = payload as Partial<NotificationJobPayload>;

    if (!isNotificationEventKey(event)) {
      return null;
    }

    if (typeof data !== 'object' || data === null) {
      return null;
    }

    if (userId !== undefined && typeof userId !== 'string') {
      return null;
    }

    return { event, data: data as NotificationJobPayload['data'], userId };
  }
}
