import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';

import { postJson } from './json-poster.js';
import type {
  WebhookChannel,
  WebhookPayload,
  WebhookResult,
} from './webhook.interface.js';

const logger = new Logger('SlackChannel');

export interface SlackChannelOptions {
  /** Incoming webhook url, which already carries the credential. */
  webhookUrl: string;
  /** Channel label used in the log line. */
  channel?: string;
}

/**
 * Slack incoming webhook over `HttpService`, no package of its own.
 *
 * The same shape serves Discord, which also accepts a Slack-compatible
 * `{ text }` payload, so the two share one implementation.
 */
export class SlackChannel implements WebhookChannel {
  readonly name = 'slack';

  constructor(
    private readonly http: HttpService,
    private readonly options: SlackChannelOptions,
  ) {}

  async send(payload: WebhookPayload): Promise<WebhookResult> {
    const response = await postJson(this.http, {
      url: this.options.webhookUrl,
      body: this.blockKit(payload),
    });

    if (response.status < 200 || response.status >= 300) {
      logger.error(
        `Webhook ${this.options.channel ?? this.name} rejected the message: ${response.status}`,
      );
      return { delivered: false, status: response.status };
    }

    return { delivered: true, status: response.status };
  }

  /**
   * Slack shows a bold line for the event and a plain paragraph for the
   * detail, which is enough structure without the full Block Kit surface.
   *
   * Both parts are escaped, and both have to be. A notification body carries a
   * user-supplied email address and a user-supplied device label, and Slack's
   * `mrkdwn` reads `<https://x|label>` as a link and `&` as an entity — so an
   * address containing `<` becomes a clickable link in an operator's channel. The
   * sender cannot escape it, because the same body goes to Telegram, whose
   * MarkdownV2 uses a different backslash syntax; escaping belongs here, once per
   * channel, next to the markup that needs it.
   */
  private blockKit(payload: WebhookPayload): unknown {
    const blocks: unknown[] = [];

    if (payload.title) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackMarkdown(payload.title)}*`,
        },
      });
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: escapeSlackMarkdown(payload.text) },
    });

    return {
      text: payload.title
        ? escapeSlackMarkdown(payload.title)
        : escapeSlackMarkdown(payload.text),
      blocks,
    };
  }
}

/**
 * The three characters Slack's `mrkdwn` treats as markup.
 *
 * `mrkdwn` is not Markdown and its escaping is HTML-shaped rather than
 * backslash-shaped, which is exactly why it cannot share a helper with Telegram's
 * `escapeMarkdownV2`: one takes `\&`, the other takes `&amp;`. Two helpers, one per
 * syntax, rather than one that is wrong for one of them.
 */
export function escapeSlackMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
