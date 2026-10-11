import { Logger } from '@nestjs/common';

import type { NotificationConfig } from '../../../configs/notification.config.js';
import {
  channelFlag,
  type ChannelResult,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';

/**
 * The transport the email channel sends through.
 *
 * An interface rather than a direct `MailService` call, so this file has no
 * dependency on the mail module and the channel is testable with a plain object.
 * `MailService` satisfies it as it stands.
 */
export interface NotificationMailer {
  sendNotification(
    to: string,
    subject: string,
    body: string,
  ): Promise<{
    delivered: boolean;
    permanent?: boolean;
    status?: number;
    error?: string;
  }>;
}

/**
 * Operator alerts by email, delegating to `MailService`.
 *
 * **Off by default even though the console channel is on.** Mail is the one channel
 * that costs money and can be rate-limited by a provider, and a developer running
 * locally with a real `SMTP` credential in their environment should not have every
 * test registration send an operator alert to a mailbox.
 *
 * It delegates rather than speaking SMTP itself, which means it inherits the mail
 * module's transport selection, its logging and its failure handling for free. The
 * cost is that this channel is queued twice over: this one, and the mail job the
 * delegation enqueues. That is acceptable because the notification job is already
 * off the request path, so the second hop costs a few milliseconds of a background
 * worker rather than anybody's latency, and re-implementing transport selection here
 * would be the alternative that is genuinely worth avoiding.
 *
 * Several recipients in one send rather than one send each. A BCC list is one
 * message, and an operator with a shared mailbox and a personal one does not want
 * two copies of every security alert.
 */
export class EmailNotificationChannel implements NotificationChannel {
  readonly name = 'email' as const;

  private readonly logger = new Logger('NotificationEmail');

  constructor(
    private readonly mailer: NotificationMailer,
    private readonly config: NotificationConfig,
  ) {}

  isEnabled(): boolean {
    if (this.config.email.to.length === 0) {
      if (this.config.channels.email) {
        this.logger.error(
          'NOTIFICATION_EMAIL_ENABLED is true but NOTIFICATION_EMAIL_TO is empty, ' +
            'so nothing will be delivered.',
        );
      }

      return false;
    }

    return channelFlag(this.config, 'email');
  }

  async send(payload: NotificationPayload): Promise<ChannelResult> {
    // No prefix of its own: `MAIL_SUBJECT_PREFIX` already exists and applies to
    // every message this transport sends, so an operator filtering one mailbox for
    // a deployment's name finds these alongside the transactional mail rather than
    // under a second convention.
    const subject = payload.headline;
    const to = this.config.email.to;

    try {
      const results = await Promise.all(
        to.map(async (address) =>
          this.mailer.sendNotification(address, subject, payload.body),
        ),
      );

      // One refused address does not make the whole notification a failure: the
      // others received it, and a shared mailbox that bounced is a configuration
      // problem to see in the log rather than a reason to retry the whole thing five
      // times. Permanent when every address refused permanently, because that is the
      // case where another attempt changes nothing.
      const delivered = results.filter((result) => result.delivered).length;
      const allPermanent = results.every(
        (result) => !result.delivered && result.permanent === true,
      );
      const first = results.find((result) => !result.delivered);

      if (delivered === 0) {
        return {
          delivered: false,
          permanent: allPermanent,
          status: first?.status,
          error: first?.error ?? 'every recipient refused it',
          recipient: to.join(', '),
        };
      }

      if (delivered < to.length) {
        this.logger.warn(
          `${to.length - delivered} of ${to.length} operator addresses refused a ` +
            `${payload.event}; the rest received it`,
        );
      }

      return { delivered: true, recipient: to.join(', ') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Notification mail could not be sent: ${message}`);

      return { delivered: false, error: message, recipient: to.join(', ') };
    }
  }
}
