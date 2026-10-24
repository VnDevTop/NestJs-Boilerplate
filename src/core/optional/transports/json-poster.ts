import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { classifyHttpError } from '../../http/http.error.js';

export interface JsonPostOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
}

export interface JsonPostResult {
  status: number;
  body: string;
}

/**
 * Single JSON POST, on top of `HttpService`.
 *
 * Telegram and Slack both take one JSON payload at an https endpoint, so a
 * webhook channel is a few lines of payload building. The transport itself is
 * `HttpService` from `HttpCoreModule`, which is already configured with a global
 * timeout and request-id propagation, so neither channel needs a package of its
 * own or a hand-set timeout.
 *
 * `validateStatus` accepts every status, so a 4xx from a provider is returned to
 * the caller as a result instead of thrown: a rejected Telegram message is a
 * fact to log, not an exception to unwind a request with. Network failures still
 * reject with a classified `HttpError`, because those are retryable.
 *
 * Only https is allowed, so a misconfigured `http://` webhook fails loudly
 * instead of sending a bot token in clear text.
 */
export async function postJson(
  http: HttpService,
  options: JsonPostOptions,
): Promise<JsonPostResult> {
  let url: URL;

  try {
    url = new URL(options.url);
  } catch {
    // The url itself, never. Slack and Discord incoming webhooks carry the bot
    // credential in the path, and this message travels — the notification service
    // catches it into an `error` field, and that field is a database column.
    // Saying nothing about the input is enough: a url that will not parse is one
    // of the settings, and an operator has two.
    throw new Error(
      'Invalid webhook url: expected an absolute https url. ' +
        'If this is Slack or Discord, check the webhook URL for a stray character.',
    );
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Refusing to post to ${url.protocol}//, expected https:`);
  }

  try {
    const response = await firstValueFrom(
      http.post(options.url, options.body, {
        headers: options.headers,
        responseType: 'text',
        transformResponse: [(data: unknown) => data],
        validateStatus: () => true,
      }),
    );

    return {
      status: response.status,
      body: typeof response.data === 'string' ? response.data : '',
    };
  } catch (error) {
    throw classifyHttpError(error);
  }
}
