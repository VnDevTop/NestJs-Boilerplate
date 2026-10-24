import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';

import { SlackChannel } from '../../../core/optional/transports/slack.channel.js';
import type { NotificationConfig } from '../../../configs/notification.config.js';
import {
  isPermanentStatus,
  type ChannelResult,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';

/**
 * Slack, over an incoming webhook, with no package.
 *
 * Wraps the Block Kit transport from Phase 12 rather than rebuilding it. The
 * payload shape is the interesting part and it is not Slack's: an incoming webhook
 * posts `{ text, blocks }` and no auth header, which is why the credential lives in
 * the url and why the configuration refuses an `http://` one.
 */
export class SlackNotificationChannel implements NotificationChannel {
  readonly name = 'slack' as const;

  private readonly logger = new Logger('NotificationSlack');

  constructor(
    private readonly http: HttpService,
    private readonly config: NotificationConfig,
  ) {}

  /** As with Telegram: an enabled channel with no url says so rather than failing silently. */
  isEnabled(): boolean {
    if (this.config.slack.webhookUrl === undefined) {
      if (this.config.channels.slack) {
        this.logger.error(
          'SLACK_ENABLED is true but SLACK_WEBHOOK_URL is missing, so nothing will ' +
            'be delivered. See docs/optional-integrations.md.',
        );
      }

      return false;
    }

    return this.config.enabled && this.config.channels.slack;
  }

  async send(payload: NotificationPayload): Promise<ChannelResult> {
    const channel = new SlackChannel(this.http, {
      webhookUrl: this.config.slack.webhookUrl as string,
      channel: this.config.slack.channel,
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
          recipient: this.config.slack.channel ?? 'slack',
        };
      }

      return {
        delivered: true,
        status: result.status,
        recipient: this.config.slack.channel ?? 'slack',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Slack could not be reached: ${message}`);

      return {
        delivered: false,
        error: message,
        recipient: this.config.slack.channel ?? 'slack',
      };
    }
  }
}
