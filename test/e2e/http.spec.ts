import { describe, expect, it, vi } from 'vitest';

import { createHttp } from './harness.js';

/**
 * The idempotency key the harness attaches.
 *
 * This exists because of a bug that cost a CI run and would have cost every run
 * after it. `http()` returned `Object.assign(wrapped, agent)` — supertest's verb
 * methods copied onto a wrapper object. Every mutating route in this application
 * requires an `Idempotency-Key`, so every `POST` in the e2e suite answered:
 *
 * ```text
 * 400 Bad Request — This endpoint requires an Idempotency-Key header.
 * ```
 *
 * The wrapper was bypassed rather than broken. supertest's `agent.post` is a
 * closure over the agent, so calling the copy went straight to the original and
 * the header was never set — the code read as though it did the right thing, and
 * no assertion noticed because the failure surfaced as a status code three files
 * away from the line that caused it.
 *
 * Which is also why these are unit tests: the fix is in how the wrapper is
 * assembled, and that is testable with a stub agent and no server, no database and
 * no Docker.
 */

/** Records what the wrapper asked for, without a socket anywhere. */
function fakeAgent() {
  const calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }[] = [];

  const agent = ((method: string, url: string) => {
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

    calls.push({ method, url, headers: request.headers });

    return request;
  }) as never;

  return { agent, calls };
}

describe('the http helper', () => {
  it('attaches a distinct key to every mutating request', () => {
    const { agent, calls } = fakeAgent();
    const http = createHttp(agent);

    http.post('/auth/register');
    http.put('/admin/roles/user/permissions');

    // Read through what the wrapper built, because that is the object supertest
    // sends — the same object the header was set on.
    expect(calls[0].headers['Idempotency-Key']).toBe('e2e-1');
    expect(calls[1].headers['Idempotency-Key']).toBe('e2e-2');
  });

  it('leaves a read alone', () => {
    const { agent, calls } = fakeAgent();

    createHttp(agent).get('/auth/me');

    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('sends the key through the verb methods, not only the call signature', () => {
    // The regression itself. Calling `http(app).post(...)` has to reach the same
    // code path as `http(app)('post', ...)`, and copying supertest's methods onto
    // the wrapper does not.
    const { agent, calls } = fakeAgent();
    const http = createHttp(agent);

    http.post('/auth/register');
    http.delete('/auth/sessions/1');

    expect(calls.map((call) => call.method)).toEqual(['post', 'delete']);

    for (const call of calls) {
      expect(call.headers['Idempotency-Key']).toBeDefined();
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
