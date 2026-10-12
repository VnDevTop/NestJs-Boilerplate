import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { IdempotencyGuard } from './idempotency.guard.js';
import { IDEMPOTENCY_KEY } from './idempotency.decorator.js';
import type { IdempotencyPolicy } from './idempotency-policy.interface.js';
import { IdempotencyService } from '../../modules/queue/idempotency.service.js';

/**
 * What a client retry gets, and what it gets refused.
 *
 * The two decisions worth defending are both about refusing: **the header is
 * required**, and **a key that is already in flight is a 409 rather than a wait**.
 * Both are cases where the obvious softer answer is wrong, so both are asserted
 * rather than assumed.
 */

const KEY = IdempotencyService.buildKey('u1', 'POST', '/users', 'client-key-1');

function harness(
  claim: unknown,
  options: {
    policy?: IdempotencyPolicy;
    headers?: Record<string, string>;
  } = {},
) {
  const begin = vi.fn(async () => claim);
  const complete = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);

  const reflector = {
    getAllAndOverride: vi.fn(() =>
      options.policy === undefined ? {} : options.policy,
    ),
  } as unknown as Reflector;

  // An express response, which is an EventEmitter plus a few chainable methods.
  // Typed as its own shape rather than as `Response`, so the double can be handed
  // to the guard without a cast at every call.
  interface FakeResponse extends EventEmitter {
    statusCode: number;
    status(code: number): FakeResponse;
    type(value: string): FakeResponse;
    send(body: string): FakeResponse;
    end(): FakeResponse;
  }

  const response: FakeResponse = Object.assign(new EventEmitter(), {
    statusCode: 201,
    status: vi.fn(function (this: FakeResponse, code: number) {
      response.statusCode = code;

      return response;
    }),
    type: vi.fn(function () {
      return response;
    }),
    send: vi.fn(function () {
      return response;
    }),
    end: vi.fn(function () {
      return response;
    }),
  });

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        route: { path: '/users' },
        params: {},
        headers: options.headers ?? { 'idempotency-key': 'client-key-1' },
        user: { id: 'u1' },
        ip: '203.0.113.9',
      }),
      getResponse: () => response,
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;

  return {
    guard: new IdempotencyGuard(
      reflector as never,
      {
        begin,
        complete,
        release,
      } as never,
    ),
    begin,
    complete,
    release,
    response,
    context,
  };
}

/** The response finish event, which is when the answer is recorded. */
function finish(
  response: { statusCode: number; emit(event: string): boolean },
  status = 201,
): void {
  response.statusCode = status;
  response.emit('finish');
}

describe('a route that did not ask for idempotency', () => {
  it('passes straight through, without reading a header', async () => {
    // The guard is registered globally, so this fast path is what keeps the
    // feature off every other request in the application.
    const reflector = {
      getAllAndOverride: vi.fn(() => undefined),
    } as unknown as Reflector;
    const begin = vi.fn();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, method: 'GET' }),
        getResponse: () => ({ on: vi.fn() }),
      }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;

    await expect(
      new IdempotencyGuard(reflector, { begin } as never).canActivate(context),
    ).resolves.toBe(true);
    expect(begin).not.toHaveBeenCalled();
  });

  it('reads the metadata from the handler and the class', async () => {
    const reflector = {
      getAllAndOverride: vi.fn(() => undefined),
    } as unknown as Reflector;
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
        getResponse: () => ({ on: vi.fn() }),
      }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;

    await new IdempotencyGuard(reflector, {} as never).canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IDEMPOTENCY_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});

describe('a first request', () => {
  it('does the work', async () => {
    const h = harness('claimed');

    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
  });

  it('scopes the key to the caller, the method and the route', async () => {
    // Without the caller, two users who generate the same key collide and one is
    // handed the other's answer.
    const h = harness('claimed');

    await h.guard.canActivate(h.context);

    // The window is `undefined` rather than a number when the route did not set
    // one, which reads as "use the default" at the service. Asserting a number here
    // would force the guard to know a default it does not own.
    expect(h.begin).toHaveBeenCalledWith(KEY, undefined);
  });

  it('records the answer once the response has been sent', async () => {
    const h = harness('claimed');

    await h.guard.canActivate(h.context);
    finish(h.response);

    expect(h.complete).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ status: 201 }),
      undefined,
    );
  });

  it('records nothing until the response is actually sent', async () => {
    // The only moment both the status and the body exist. Recording earlier would
    // store a 200 for a request that then failed.
    const h = harness('claimed');

    await h.guard.canActivate(h.context);

    expect(h.complete).not.toHaveBeenCalled();
  });

  it('records once even if the event fires twice', async () => {
    const h = harness('claimed');

    await h.guard.canActivate(h.context);
    finish(h.response);
    finish(h.response);

    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('releases the key on a failure, so the client can try again', async () => {
    // Otherwise a validation error holds the key for the in-flight window and every
    // retry during it is answered "still processing" for a request that already
    // stopped.
    const h = harness('claimed');

    await h.guard.canActivate(h.context);
    finish(h.response, 422);

    expect(h.release).toHaveBeenCalledWith(KEY);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('releases on a 5xx too, because a retry of that is legitimate', async () => {
    const h = harness('claimed');

    await h.guard.canActivate(h.context);
    finish(h.response, 500);

    expect(h.release).toHaveBeenCalled();
  });

  it('proceeds when redis cannot be reached', async () => {
    // Failing closed would turn a redis outage into an application that cannot
    // write anything — a partial loss of a convenience guarantee traded for a total
    // loss of the product.
    const h = harness(null);

    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
  });

  it('stores nothing to replay when redis is down', async () => {
    const h = harness(null);

    await h.guard.canActivate(h.context);
    finish(h.response);

    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('a retry', () => {
  const recorded = {
    state: 'complete' as const,
    status: 201,
    body: '{"id":"u1","email":"a@x.com"}',
  };

  it('is handed the original answer rather than doing the work again', async () => {
    // The retry that lost a response gets its tokens or its created row back,
    // instead of a receipt telling it to go and look — which would be the retry
    // this exists to remove, moved one call later.
    const h = harness(recorded);

    await h.guard.canActivate(h.context);

    expect(h.response.status).toHaveBeenCalledWith(201);
    expect(h.response.send).toHaveBeenCalledWith(recorded.body);
  });

  it('replays as JSON, because the original was', async () => {
    const h = harness(recorded);

    await h.guard.canActivate(h.context);

    expect(h.response.type).toHaveBeenCalledWith('application/json');
  });

  it('replays a 204 as an empty 204', async () => {
    const h = harness({ state: 'complete' as const, status: 204 });

    await h.guard.canActivate(h.context);

    expect(h.response.status).toHaveBeenCalledWith(204);
    expect(h.response.end).toHaveBeenCalled();
  });

  it('replays a status alone when the body was too large to store', async () => {
    const h = harness({ state: 'complete' as const, status: 200 });

    await h.guard.canActivate(h.context);

    expect(h.response.end).toHaveBeenCalled();
  });
});

describe('a duplicate arriving while the first is still running', () => {
  it('is refused with 409 rather than queued behind it', async () => {
    // Holding a connection open for work the client cannot see and cannot cancel
    // means it times out and retries anyway — which is the situation this feature
    // exists to survive.
    const h = harness('pending');

    await expect(h.guard.canActivate(h.context)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('tells the client to retry with the same key, so the retry is still safe', async () => {
    const h = harness('pending');

    await expect(h.guard.canActivate(h.context)).rejects.toThrow(
      /Retry with the same key/,
    );
  });
});

describe('a caller that did not send the header', () => {
  it('is refused, because a client that does not know about idempotency retries blindly', async () => {
    const h = harness('claimed', { headers: {} });

    await expect(h.guard.canActivate(h.context)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('is not given a key of its own', async () => {
    // Generating one would silently promise a guarantee the caller is not making:
    // the guarantee only works if the *same* key comes back on the retry.
    const h = harness('claimed', { headers: {} });

    await h.guard.canActivate(h.context).catch(() => undefined);

    expect(h.begin).not.toHaveBeenCalled();
  });

  it('is refused on an empty value, which is not a key', async () => {
    const h = harness('claimed', { headers: { 'idempotency-key': '   ' } });

    await expect(h.guard.canActivate(h.context)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('names the header, because a client cannot guess it', async () => {
    const h = harness('claimed', { headers: {} });

    await expect(h.guard.canActivate(h.context)).rejects.toThrow(
      /Idempotency-Key/,
    );
  });
});
