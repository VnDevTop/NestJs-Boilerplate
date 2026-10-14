import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { getRequestId } from '../../common/utils/index.js';
import { dedupeKey } from '../queue/dedupe-key.js';
import { QUEUE_NAMES } from '../queue/queue.interface.js';
import type { JobQueue } from '../queue/queue.interface.js';
import { JOB_QUEUE } from '../queue/queue.tokens.js';
import type {
  NotificationEventData,
  NotificationEventKey,
} from './notification.events.js';
import {
  NOTIFICATION_JOB,
  type NotificationJobPayload,
} from './processors/notification.processor.js';

/** What `notify()` accepted, so a caller can correlate a log line with a call. */
export interface NotifyResult {
  notificationId: string;
  /** False when nothing reached the queue, which is never an error. */
  queued: boolean;
}

/**
 * The emit side of notifications: the part a business service calls.
 *
 * **It exists as a separate service because of the module graph.** `NotificationService`
 * sits below the queue, since the queue's router injects `NotificationProcessor`
 * which injects it. A service that enqueues cannot live there — it would close the
 * cycle — so it lives here, in a module that imports both. This is the same split
 * Phase 16 made for retention, and for the same reason: one direction of import, and
 * the two halves meet in a module above.
 *
 * **Nothing here awaits a channel.** The enqueue is fire-and-forget and its failure
 * is swallowed, because a notification is never worth failing the request that
 * noticed something. A registration that queues a welcome mail and an operator alert
 * must return its token whether or not redis is reachable; the worst case is one
 * notification nobody received, which the dead-letter list and the health check are
 * there to reveal.
 */
@Injectable()
export class NotificationEventsService {
  private readonly logger = new Logger(NotificationEventsService.name);

  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  /**
   * Queues one event.
   *
   * Awaits the enqueue but never rejects, so a call site can `void` it without a
   * `catch` at every use. Where that matters most — a registration returning a token
   * — the alternative is a `.catch(() => undefined)` on each of them, which is one
   * more place for a future edit to forget.
   */
  notify<TKey extends NotificationEventKey>(
    event: TKey,
    data: NotificationEventData[TKey],
    options: { userId?: string; subjectId?: string } = {},
  ): Promise<NotifyResult> {
    const notificationId = randomUUID();
    const payload: NotificationJobPayload = {
      event,
      data,
      userId: options.userId,
      // Read from the async context rather than passed in. The emit side is a
      // service method that knows nothing about requests, and a call site that had
      // to thread an id through would eventually forget to — which is the same gap
      // `requestId` already closes for log lines.
      requestId: getRequestId(),
    };

    return this.queue
      .enqueue(QUEUE_NAMES.notification, {
        name: NOTIFICATION_JOB,
        payload,
        // Keyed on a fresh uuid unless the caller supplies a subject id, because the
        // deduplication guard's job is to stop a queue *redelivery* producing two
        // copies — not to collapse two genuine events. A key derived from the event
        // name alone would suppress the second failed sign-in, which is the one an
        // operator most wants to hear about.
        dedupeKey: this.dedupeKeyFor(event, options, notificationId),
      })
      .then(() => ({ notificationId, queued: true }))
      .catch((error: unknown) => {
        this.logger.error(
          `Could not enqueue ${event}: ${
            error instanceof Error ? error.message : String(error)
          }. The notification was dropped and nothing else was affected.`,
        );

        return { notificationId, queued: false };
      });
  }

  /**
   * The identity the deduplication guard compares.
   *
   * Both halves have to come from the caller or the key is useless, and that is worth
   * spelling out because each half fails differently:
   *
   * - **With a `subjectId`**, the key is stable across a redelivery, which is the
   *   case the guard exists for. Two enqueues of the same event with the same subject
   *   collide, so the second is skipped.
   * - **Without one**, the key carries a fresh uuid and therefore never collides. That
   *   is deliberate: a key derived from the event name alone would suppress the second
   *   failed sign-in of an ongoing attack, which is the alert an operator most wants.
   *   The cost is that a redelivery of a subject-less event is not deduplicated, so
   *   the at-least-once queue can deliver one twice. That is the trade the plan's
   *   "dedupe is around the processor, not at enqueue" note points at, and it is
   *   visible rather than silent.
   *
   * The recipient half falls back to the subject id before the notification id. That
   * ordering is load-bearing: a `subjectId` without a `userId` — the retention anomaly,
   * or a failed sign-in against an address that resolved to nobody — still gets a
   * stable key, where using the notification id for the recipient half would have
   * made the key unstable and silently disabled deduplication for exactly those
   * events.
   */
  private dedupeKeyFor(
    event: NotificationEventKey,
    options: { userId?: string; subjectId?: string },
    notificationId: string,
  ): string {
    const identity = options.subjectId ?? notificationId;

    return dedupeKey({
      template: event,
      to: options.userId ?? identity,
      subjectId: identity,
    });
  }

  /** Convenience for the common case, so a call site is one line. */
  notifyUser<TKey extends NotificationEventKey>(
    event: TKey,
    data: NotificationEventData[TKey],
    userId: string,
    options: { subjectId?: string } = {},
  ): Promise<NotifyResult> {
    return this.notify(event, data, { userId, ...options });
  }
}
