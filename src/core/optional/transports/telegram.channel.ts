import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';

import { postJson } from './json-poster.js';
import type {
  WebhookChannel,
  WebhookPayload,
  WebhookResult,
} from './webhook.interface.js';

const logger = new Logger('TelegramChannel');

export interface TelegramChannelOptions {
  botToken: string;
  chatId: string;
  /** Optional forum topic id, so events can be routed to separate rooms. */
  topicId?: string;
  baseUrl?: string;
}

/**
 * Telegram Bot API over `HttpService`, no package of its own.
 *
 * Telegram rejects a message containing an unescaped `_`, `*` or backtick, so
 * the text is escaped here rather than at each call site.
 */
export class TelegramChannel implements WebhookChannel {
  readonly name = 'telegram';

  constructor(
    private readonly http: HttpService,
    private readonly options: TelegramChannelOptions,
  ) {}

  async send(payload: WebhookPayload): Promise<WebhookResult> {
    const baseUrl = this.options.baseUrl ?? 'https://api.telegram.org';
    const response = await postJson(this.http, {
      url: `${baseUrl}/bot${this.options.botToken}/sendMessage`,
      body: {
        chat_id: this.options.chatId,
        message_thread_id: this.options.topicId,
        text: escapeMarkdownV2(payload.text),
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      logger.error(`Telegram rejected the message: ${response.status}`);
      return { delivered: false, status: response.status };
    }

    return { delivered: true, status: response.status };
  }
}

const MARKDOWN_V2_SPECIALS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escapes the characters Telegram's MarkdownV2 parser treats as markup.
 * Centralised so a message can never be half escaped.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIALS, '\\$1');
}
