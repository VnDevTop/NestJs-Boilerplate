import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { notificationConfig } from '../../configs/notification.config.js';
import type { NotificationChannel } from './channels/index.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import {
  renderNotification,
  type NotificationEventData,
  type NotificationEventKey,
} from './notification.events.js';
import type {
  ChannelDelivery,
  DeliveryOutcome,
  LogEntry,
} from './types/index.js';

/** Injection token for the enabled-channel list. */
export const NOTIFICATION_CHANNELS = 'NOTIFICATION_CHANNELS';

/** Injection token for the log writer, kept narrow so tests need no database. */
export const NOTIFICATION_LOG_WRITER = 'NOTIFICATION_LOG_WRITER';

/**
 * The log writer, as an interface.
 *
 * Narrow on purpose: the service needs to append a row and nothing else, so a test
 * supplies an array and production supplies the repository. It is also why this
 * file does not import TypeORM, which keeps the whole delivery path testable
 * without a database connection.
 */
export interface NotificationLogWriter {
  record(entry: LogEntry): Promise<void>;
}

/**
 * Delivers one notification to every channel that should receive it.
 *
 * **The only implementation of delivery.** The queue processor calls it and nothing
 * else does, so a channel added later is reached by the queue path without anyone
 * editing a second caller. That is the same reason `MailProcessor` is a plain class
 * rather than a pair of methods.
 *
 * **Failure-isolated per channel**, and that is the property everything here exists
 * to protect. A Telegram webhook that times out must not stop the message reaching
 * Slack, must not stop the log row being written for either, and above all must
 * never reach the request that triggered the notification. So each channel is
 * attempted independently, every outcome is recorded, and the summary describes what
 * happened rather than throwing.
 *
 * The one exception is `throwOnFailure`, and it exists for a test rather than for
 * production: with it on, a failure rejects, which is how a spec asserts that a
 * broken channel was *tried* rather than skipped. It is off by default and the
 * production validation rule that forbids `memory` mail is the same shape of
 * decision: a setting that turns a soft failure into a hard one is for local
 * debugging, not for a deployment.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: NotificationChannel[],
    @Inject(NOTIFICATION_LOG_WRITER)
    private readonly logs: NotificationLogWriter,
    private readonly preferences: NotificationPreferencesService,
    // By token, because `NotificationConfig` is an interface and Nest has no class
    // to resolve it from. The same reason `RetentionScheduler` takes
    // `@Inject(retentionConfig.KEY)`.
    @Inject(notificationConfig.KEY)
    private readonly config: ConfigType<typeof notificationConfig>,
  ) {}

  /** The channels that would receive something right now, for the health check. */
  activeChannels(): string[] {
    return this.channels.map((channel) => channel.name);
  }

  /**
   * Sends one event to every enabled channel.
   *
   * Returns what happened per channel rather than a boolean, because the caller
   * that cares is the queue, and a boolean would lose the difference between "every
   * channel refused it permanently" and "one channel is down", which are the two
   * cases that deserve different retry decisions.
   */
  async notify<TKey extends NotificationEventKey>(
    event: TKey,
    data: NotificationEventData[TKey],
    // `requestId` is threaded from the job payload rather than read from the async
    // context here, because `notify` is called by the processor in the worker where
    // the request that enqueued it is no longer in scope.
    options: { userId?: string; requestId?: string } = {},
  ): Promise<DeliveryOutcome> {
    const notificationId = randomUUID();

    if (!this.config.enabled || this.channels.length === 0) {
      // Nothing to send and nothing to retry, so this is a success. Reporting it as
      // skipped rather than failing keeps a disabled deployment from filling the
      // dead-letter list with work it was told not to do.
      return { notificationId, event, deliveries: [], skipped: true };
    }

    const { headline, body } = renderNotification(event, data);
    const deliveries: ChannelDelivery[] = [];

    for (const channel of this.channels) {
      deliveries.push(
        await this.deliverTo(notificationId, event, channel, {
          headline,
          body,
          userId: options.userId,
          requestId: options.requestId,
        }),
      );
    }

    return { notificationId, event, deliveries };
  }

  /**
   * One channel, with its own retry budget.
   *
   * The loop lives here rather than being left to the queue, because a notification
   * is fanned out: a queue retry would re-attempt *every* channel for the sake of
   * the one that failed, and a Slack alert would arrive three times because Telegram
   * was down. Per-channel means the retries are spent where the failure is.
   *
   * `retries` counts *additional* attempts, so `retries: 2` is three tries. The
   * backoff is the same exponential shape `queue/retry.policy.ts` uses, which is why
   * the wait is computed rather than described.
   */
  private async deliverTo(
    notificationId: string,
    event: NotificationEventKey,
    channel: NotificationChannel,
    payload: {
      headline: string;
      body: string;
      userId?: string;
      /** Carried from the job payload; this runs in the worker, out of request scope. */
      requestId?: string;
    },
  ): Promise<ChannelDelivery> {
    const muted =
      payload.userId === undefined
        ? false
        : await this.isMuted(payload.userId, event, channel);

    if (muted) {
      // Recorded rather than silently skipped. "The user muted this" and "the
      // channel was never tried" look identical in a delivery count, and only the
      // first is something the user needs to be able to confirm.
      await this.logs.record({
        notificationId,
        // Carried from the job payload, not read here: this runs in the worker,
        // where the request that enqueued it is no longer in scope.
        requestId: payload.requestId,
        event,
        channel: channel.name,
        userId: payload.userId,
        delivered: false,
        attempts: 0,
        body: payload.body,
        error: 'muted by the recipient',
      });

      return {
        channel: channel.name,
        delivered: false,
        skipped: true,
        attempts: 0,
        error: 'muted by the recipient',
      };
    }

    const maxAttempts = this.config.delivery.retries + 1;
    let result: ChannelDelivery = {
      channel: channel.name,
      delivered: false,
      attempts: 0,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = await this.attempt(channel, event, payload, attempt);

      if (
        result.delivered ||
        result.permanent === true ||
        attempt === maxAttempts
      ) {
        break;
      }

      await this.wait(this.config.delivery.retryDelay * 2 ** (attempt - 1));
    }

    if (!result.delivered) {
      this.logger.error(
        `Notification ${event} failed on ${channel.name} after ` +
          `${result.attempts} attempt(s): ${result.error ?? 'no reason given'}`,
      );
    }

    await this.logs.record({
      notificationId,
      requestId: payload.requestId,
      event,
      channel: channel.name,
      userId: payload.userId,
      delivered: result.delivered,
      statusCode: result.status,
      attempts: result.attempts,
      recipient: result.recipient,
      body: payload.body,
      error: result.error,
    });

    if (this.config.delivery.throwOnFailure && !result.delivered) {
      throw new Error(
        `Notification ${event} could not be delivered on ${channel.name}: ` +
          `${result.error ?? 'no reason given'}`,
      );
    }

    return result;
  }

  /**
   * Whether this user has muted this event on this channel.
   *
   * **A failed lookup answers "not muted".** The preference service already answers
   * that way internally, and this repeats it because the contract matters more than
   * the implementation: a preferences table that is briefly unreachable must not
   * silence the deployment's operator alerts. The cost is a user who receives one
   * notification they muted, which is a smaller problem than nobody receiving
   * anything — and it is bounded, because the next run reads the table again.
   */
  private async isMuted(
    userId: string,
    event: NotificationEventKey,
    channel: NotificationChannel,
  ): Promise<boolean> {
    try {
      return !(await this.preferences.isEnabled(userId, event, channel.name));
    } catch (error) {
      this.logger.warn(
        `Could not read ${userId}'s preferences for ${event} on ` +
          `${channel.name}, delivering anyway: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );

      return false;
    }
  }

  /**
   * One send, with everything absorbed into a result.
   *
   * A channel that reports neither delivery nor an error counts as delivered. The
   * alternative is retrying a channel that already sent the message and duplicating
   * an operator alert, which is worse than trusting a channel that opted out of
   * explaining itself.
   */
  private async attempt(
    channel: NotificationChannel,
    event: NotificationEventKey,
    payload: {
      headline: string;
      body: string;
      userId?: string;
      /** Carried from the job payload; this runs in the worker, out of request scope. */
      requestId?: string;
    },
    attempt: number,
  ): Promise<ChannelDelivery> {
    const base = { channel: channel.name, attempts: attempt };

    try {
      const result = await channel.send({
        event,
        headline: payload.headline,
        body: payload.body,
        userId: payload.userId,
      });

      return {
        ...base,
        delivered: result.delivered,
        status: result.status,
        recipient: result.recipient,
        permanent: result.permanent,
        error: result.delivered
          ? undefined
          : (result.error ?? 'delivery failed'),
      };
    } catch (error) {
      return {
        ...base,
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
