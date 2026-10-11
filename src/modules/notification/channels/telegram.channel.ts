import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';

import {
  escapeMarkdownV2,
  TelegramChannel,
} from '../../../core/optional/transports/telegram.channel.js';
import type { NotificationConfig } from '../../../configs/notification.config.js';
import {
  isPermanentStatus,
  type ChannelResult,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';

/**
 * Telegram, over the Bot API, with no package.
 *
 * Wraps the transport from Phase 12 rather than reimplementing it. That transport
 * already centralises `escapeMarkdownV2`, which is the one thing a Telegram channel
 * gets wrong when there are two of them: the Bot API rejects a message containing
 * an unescaped `_`, `*` or backtick, and an event body carrying a user-supplied
 * email address is exactly the message that trips it.
 *
 * **A new instance per send**, unlike every other channel. A forum chat routes by
 * `message_thread_id`, so where a message goes depends on the event rather than on
 * the channel, and the transport takes the topic in its constructor. Building it per
 * send is the only way one channel reaches several rooms without a lookup table
 * inside the transport.
 */
export class TelegramNotificationChannel implements NotificationChannel {
  readonly name = 'telegram' as const;

  private readonly logger = new Logger('NotificationTelegram');

  constructor(
    private readonly http: HttpService,
    private readonly config: NotificationConfig,
  ) {}

  /**
   * False without both credentials, and says which one is missing.
   *
   * A channel enabled with no bot token answers as though it worked, because every
   * message disappears and nothing else changes. The log line is the difference
   * between "notifications are quiet" and "notifications are misconfigured".
   */
  isEnabled(): boolean {
    const { botToken, chatId } = this.config.telegram;

    if (botToken === undefined || chatId === undefined) {
      if (this.config.channels.telegram) {
        this.logger.error(
          'TELEGRAM_ENABLED is true but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is ' +
            'missing, so nothing will be delivered. See docs/optional-integrations.md.',
        );
      }

      return false;
    }

    return this.config.enabled && this.config.channels.telegram;
  }

  /**
   * The topic for one event: its own entry in `TELEGRAM_TOPICS`, else the chat-wide
   * `TELEGRAM_TOPIC_ID`, else none.
   *
   * An event with no route of its own lands in the default room rather than being
   * dropped. A new event nobody remembered to route is a notification in the wrong
   * place, which is recoverable; a missing route is a notification nobody sees.
   */
  topicFor(event: NotificationPayload['event']): string | undefined {
    return this.config.telegram.topics[event] ?? this.config.telegram.topicId;
  }

  async send(payload: NotificationPayload): Promise<ChannelResult> {
    const topicId = this.topicFor(payload.event);

    const channel = new TelegramChannel(this.http, {
      botToken: this.config.telegram.botToken as string,
      chatId: this.config.telegram.chatId as string,
      topicId,
      timeoutMs: this.config.delivery.timeout,
    });

    try {
      const result = await channel.send({
        title: payload.headline,
        text: payload.body,
        event: payload.event,
      });

      if (!result.delivered) {
        return {
          delivered: false,
          status: result.status,
          permanent: isPermanentStatus(result.status),
          error: `status ${result.status}`,
          recipient: this.recipient(topicId),
        };
      }

      return {
        delivered: true,
        status: result.status,
        recipient: this.recipient(topicId),
      };
    } catch (error) {
      // Network failure, or a url the poster refused. Neither is permanent: the
      // credentials are fixed by configuration and a socket error usually is not.
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Telegram could not be reached: ${message}`);

      return {
        delivered: false,
        error: message,
        recipient: this.recipient(topicId),
      };
    }
  }

  /** The chat, and the topic when there is one, so the log says where it went. */
  private recipient(topicId: string | undefined): string {
    const chat = this.config.telegram.chatId ?? 'unknown';

    return topicId === undefined ? chat : `${chat}#${topicId}`;
  }
}

export { escapeMarkdownV2 };
