import { HttpService } from '@nestjs/axios';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import { postJson } from './json-poster.js';

function httpReturning(status: number, data: unknown): HttpService {
  const post = vi.fn().mockReturnValue(of({ status, data }));
  return { post } as unknown as HttpService;
}

function lastConfig(http: HttpService) {
  return vi.mocked(http.post).mock.calls[0][2];
}

describe('postJson', () => {
  it('refuses a plain http url so a token is never sent in clear text', async () => {
    const http = httpReturning(200, 'ok');

    await expect(
      postJson(http, { url: 'http://api.telegram.org/x', body: {} }),
    ).rejects.toThrow(/expected https/);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses a malformed url', async () => {
    await expect(
      postJson(httpReturning(200, ''), { url: 'not-a-url', body: {} }),
    ).rejects.toThrow(/Invalid webhook url/);
  });

  it('never puts the url in that message, because a webhook url is the credential', async () => {
    // Slack and Discord incoming webhooks carry the bot token in the path. This
    // message is caught by the notification service into an `error` field, and
    // that field is a database column — so echoing the input here wrote a live
    // credential into `notification_logs`.
    // A bad port, so `new URL` genuinely throws rather than quietly normalising.
    const webhook = 'https://hooks.slack.com:not-a-port/services/T1/B1/x';

    const error = await postJson(httpReturning(200, ''), {
      url: webhook,
      body: {},
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('/services/');
    expect((error as Error).message).not.toContain('slack.com');
  });

  it('posts the body to the url', async () => {
    const http = httpReturning(200, '{"ok":true}');

    const result = await postJson(http, {
      url: 'https://api.telegram.org/bot1/sendMessage',
      body: { chat_id: 1 },
      headers: { 'x-test': 'yes' },
    });

    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(http.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bot1/sendMessage',
      { chat_id: 1 },
      expect.objectContaining({ headers: { 'x-test': 'yes' } }),
    );
  });

  it('returns a rejected status instead of throwing it', async () => {
    const result = await postJson(httpReturning(400, 'bad request'), {
      url: 'https://x.test/h',
      body: {},
    });

    expect(result).toEqual({ status: 400, body: 'bad request' });
  });

  it('asks axios to accept every status, so 4xx is a result not an error', async () => {
    const http = httpReturning(400, '');

    await postJson(http, { url: 'https://x.test/h', body: {} });

    expect(lastConfig(http)?.validateStatus?.(500)).toBe(true);
  });

  it('does not hand-set a timeout, relying on the shared client configuration', async () => {
    const http = httpReturning(200, '');

    await postJson(http, { url: 'https://x.test/h', body: {} });

    expect(lastConfig(http)?.timeout).toBeUndefined();
  });

  it('rethrows network failures unchanged', async () => {
    const http = {
      post: vi.fn().mockReturnValue(throwError(() => new Error('ECONNRESET'))),
    } as unknown as HttpService;

    await expect(
      postJson(http, { url: 'https://x.test/h', body: {} }),
    ).rejects.toThrow('ECONNRESET');
  });

  it('asks axios for a text body and leaves the payload unparsed', async () => {
    const http = httpReturning(200, '');

    await postJson(http, { url: 'https://x.test/h', body: {} });

    const config = lastConfig(http);
    expect(config?.responseType).toBe('text');
    expect(config?.transformResponse).toEqual([expect.any(Function)]);
  });

  it('rejects on a network failure so the caller can retry', async () => {
    const http = {
      post: vi.fn().mockReturnValue(throwError(() => new Error('ECONNRESET'))),
    } as unknown as HttpService;

    await expect(
      postJson(http, { url: 'https://x.test/h', body: {} }),
    ).rejects.toThrow('ECONNRESET');
  });

  it('returns an empty body when the provider answers with json', async () => {
    const result = await postJson(httpReturning(200, { ok: true }), {
      url: 'https://x.test/h',
      body: {},
    });

    expect(result.body).toBe('');
  });
});
