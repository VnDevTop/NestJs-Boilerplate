import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';

import { postJson } from '../../../core/optional/transports/json-poster.js';
import type { NotificationConfig } from '../../../configs/notification.config.js';
import {
  isPermanentStatus,
  type ChannelResult,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';

/**
 * Discord, over a webhook of the same shape as Slack's.
 *
 * **Not the Slack payload**, which is the only thing worth writing down here. The
 * Phase 12 transport noted that one implementation could serve both, and for the
 * url and the transport that is true — it is `postJson` either way. The *body* is
 * not the same: Discord ignores `text` and posts an empty message, because its
 * field is `content`, and it calls a Block Kit section an `embed` rather than a
 * `block`. A channel that reused Slack's payload delivers nothing while answering
 * 200, which is the failure this class exists to prevent.
 *
 * `content` is set alongside the embed rather than instead of it. Discord clients
 * show an embed and no body when the message is empty, so an embed alone loses the
 * message from a notification that has already scrolled past.
 */
export class DiscordNotificationChannel implements NotificationChannel {
  readonly name = 'discord' as const;

  private readonly logger = new Logger('NotificationDiscord');

  constructor(
    private readonly http: HttpService,
    private readonly config: NotificationConfig,
  ) {}

  /** As with the other webhooks: an enabled channel with no url says so. */
  isEnabled(): boolean {
    if (this.config.discord.webhookUrl === undefined) {
      if (this.config.channels.discord) {
        this.logger.error(
          'DISCORD_ENABLED is true but DISCORD_WEBHOOK_URL is missing, so nothing ' +
            'will be delivered. See docs/optional-integrations.md.',
        );
      }

      return false;
    }

    return this.config.enabled && this.config.channels.discord;
  }

  async send(payload: NotificationPayload): Promise<ChannelResult> {
    const label = this.config.discord.channel ?? 'discord';

    try {
      const response = await postJson(this.http, {
        url: this.config.discord.webhookUrl as string,
        body: {
          content: payload.headline,
          embeds: [
            {
              title: payload.headline,
              description: payload.body,
              color: 0x3e4c59,
            },
          ],
        },
      });

      if (response.status < 200 || response.status >= 300) {
        this.logger.error(
          `Discord rejected a ${payload.event}: ${response.status}`,
        );

        return {
          delivered: false,
          status: response.status,
          permanent: isPermanentStatus(response.status),
          error: `status ${response.status}`,
          recipient: label,
        };
      }

      return { delivered: true, status: response.status, recipient: label };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Discord could not be reached: ${message}`);

      return { delivered: false, error: message, recipient: label };
    }
  }
}
