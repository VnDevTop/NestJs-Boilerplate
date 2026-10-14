import { describe, expect, it, vi } from 'vitest';

import { createHttp } from './harness.js';

/**
 * The idempotency key the harness attaches.
 *
 * This exists because of two bugs, both found by CI, both of which this file
 * originally failed to catch because **the fake did not match the real thing**.
 *
 * The first was `Object.assign(wrapped, agent)`: supertest's verb methods are
 * closures over the agent, so copying them onto a wrapper never reached the
 * wrapper and the `Idempotency-Key` was never sent. Every mutating route answered
 * 400 with "This endpoint requires an Idempotency-Key header", in files that had
 * nothing to do with idempotency.
 *
 * The second was assuming `request(server)` is callable. It is not — supertest
 * returns an **object** with verb methods — so calling it was
 * `TypeError: agent is not a function`. The fake here was a function, so the test
 * agreed with the bug.
 *
 * Which is the lesson both times: a fake models what the real dependency *is*, not
 * what the code under test wishes it were. So `fakeAgent` below is an object with
 * verb methods, exactly like the real one.
 */

const VERBS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

/** Records what the wrapper asked for, without a socket anywhere. */
function fakeAgent() {
  const calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }[] = [];

  const verbs = Object.fromEntries(
    VERBS.map((verb) => [
      verb,
      (url: string) => {
        const request = {
          headers: {} as Record<string, string>,
          set(name: string, value: string) {
            request.headers[name] = value;

            return request;
          },
          // The registered listeners, so a test can fire the `response` event the
          // way supertest does.
          listeners: {} as Record<string, ((res: unknown) => void)[]>,
          on(event: string, listener: (res: unknown) => void) {
            (request.listeners[event] ??= []).push(listener);

            return request;
          },
        };

        calls.push({ method: verb, url, headers: request.headers });

        return request;
      },
    ]),
  ) as unknown as Parameters<typeof createHttp>[0];

  return { agent: verbs, calls };
}

describe('the http helper', () => {
  it('attaches a distinct key to every mutating request', () => {
    const { agent, calls } = fakeAgent();
    const http = createHttp(agent);

    http.post('/auth/register');
    http.put('/admin/roles/user/permissions');

    // Read through what the wrapper built, because that is the object supertest
    // sends — the same object the header was set on.
    expect(calls[0].headers['Idempotency-Key']).toBeDefined();
    expect(calls[1].headers['Idempotency-Key']).toBeDefined();

    // Distinct, and not a counter: vitest gives each file a fresh module
    // registry, so a counter restarts at 1 and every file's second register
    // sends the key the previous file's second register sent — which the
    // idempotency guard then replays instead of registering.
    expect(calls[0].headers['Idempotency-Key']).not.toBe(
      calls[1].headers['Idempotency-Key'],
    );
  });

  it('leaves a read alone', () => {
    const { agent, calls } = fakeAgent();

    createHttp(agent).get('/auth/me');

    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('reaches supertest through a verb method, never by calling the agent', () => {
    // The regression. `request(server)` is an object; calling it throws
    // `TypeError: agent is not a function`, which is what every request in the
    // suite reported until this was fixed.
    const { agent, calls } = fakeAgent();
    const http = createHttp(agent);

    http.post('/auth/register');
    http.delete('/auth/sessions/1');

    expect(calls.map((call) => call.method)).toEqual(['post', 'delete']);

    for (const call of calls) {
      expect(call.headers['Idempotency-Key']).toBeDefined();
    }
  });

  it('exposes every verb supertest does', () => {
    const { agent } = fakeAgent();
    const http = createHttp(agent);

    for (const verb of VERBS) {
      expect(typeof http[verb]).toBe('function');
    }
  });

  it('logs the body of a failed response, which `.expect()` throws away', () => {
    const { agent } = fakeAgent();
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const test = createHttp(agent).post('/auth/register') as unknown as {
        listeners: Record<string, ((res: unknown) => void)[]>;
      };

      for (const listener of test.listeners['response']) {
        listener({ status: 400, body: { message: 'needs a key' } });
      }

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('needs a key'),
      );
    } finally {
      error.mockRestore();
    }
  });
});
