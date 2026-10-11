import { Logger } from '@nestjs/common';

import {
  channelFlag,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';
import type { NotificationConfig } from '../../../configs/notification.config.js';

/**
 * The development default, and the only channel that cannot fail.
 *
 * Writes the message to the application log under the event's own name, so what a
 * developer reads locally is what an operator would have received. A fresh clone
 * with nothing configured therefore shows every notification it would have sent,
 * which is the point of it defaulting to on inside `NOTIFICATION_ENABLED`.
 *
 * It reports success unconditionally. A log line is written or it is not, and
 * there is no provider whose opinion about that is worth recording.
 */
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console' as const;

  private readonly logger = new Logger('NotificationConsole');

  isEnabled(): boolean {
    return true;
  }

  async send(payload: NotificationPayload): Promise<{
    delivered: boolean;
    recipient: string;
  }> {
    this.logger.log(
      `[notify:${payload.event}] ${payload.headline}\n${payload.body}`,
    );

    return { delivered: true, recipient: 'application log' };
  }
}

/**
 * Builds the set of channels a notification goes out on.
 *
 * A factory over a list rather than five conditional providers in the module, so
 * the enabled set is derived from one config object and a channel nobody enabled
 * costs nothing: no instance, no held socket, no branch in the delivery loop.
 *
 * The email channel is passed in rather than built here, because it delegates to
 * `MailService` and that needs injection. Passing it also means `selectChannels`
 * stays a pure function of its arguments, which is what makes the enabled-set rules
 * testable without a Nest container.
 *
 * Order is the order channels are attempted in, and console is last on purpose: it
 * always succeeds, so listing it first would let a broken webhook read as a
 * partial success in the summary rather than in the per-channel columns.
 */
export function selectChannels(
  config: NotificationConfig,
  webhookChannels: readonly NotificationChannel[],
  emailChannel?: NotificationChannel,
): NotificationChannel[] {
  if (!config.enabled) {
    return [];
  }

  const channels: NotificationChannel[] = [...webhookChannels];

  if (emailChannel !== undefined && channelFlag(config, 'email')) {
    channels.push(emailChannel);
  }

  if (channelFlag(config, 'console')) {
    channels.push(new ConsoleChannel());
  }

  return channels.filter((channel) => channel.isEnabled());
}
