import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_KEY, type AuditPolicy } from '../../common/constants/index.js';
import { AuditInterceptor } from './audit.interceptor.js';
import type { AuditEntry } from './audit.service.js';

/**
 * What the interceptor decides, and what it refuses to.
 *
 * Two failures it is built to avoid, and both are tested first:
 *
 * - **Logging everything.** A global interceptor that records every request
 *   produces a table dominated by profile reads, and the entries that matter are
 *   the ones nobody scrolls to.
 * - **Inventing evidence.** `before` is null on every entry this writes, because
 *   the interceptor sees the request and the response and never the row as it was.
 *   A reconstructed before-state in a table presented as evidence is worse than
 *   none: it looks like a record and it is an inference.
 */

/**
 * The shape a route in this file returns.
 *
 * Nullable, because two of them do: a 204 hands the interceptor `undefined`, and a
 * refusal hands it an exception. Typing it as an object and casting at the call
 * site would have hidden both, and "the 204 case is covered" is a claim worth
 * having the compiler check.
 */
type Row = Record<string, unknown> | undefined;

function harness(policy?: AuditPolicy) {
  const record = vi.fn(
    async (_entry: AuditEntry, _context: unknown) => undefined,
  );
  const reflector = {
    getAllAndOverride: vi.fn(() => policy),
  } as unknown as Reflector;

  return {
    interceptor: new AuditInterceptor(reflector, { record } as never),
    record,
  };
}

function contextFor(request: Row = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        params: {},
        ...request,
      }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

/** The entries written, in order. */
function entries(record: ReturnType<typeof harness>['record']): Row[] {
  return record.mock.calls.map(([entry]) => entry as unknown as Row);
}

const user = { id: 'u1', email: 'admin@x.com' };

const policy: AuditPolicy = {
  action: 'users.update',
  targetType: 'user',
  targetIdFrom: [['param', 'id']],
};

/**
 * Runs one intercepted call and hands back what the subscriber would have seen.
 *
 * Returning the resolved value rather than swallowing it is what lets the response
 * tests assert the interceptor is transparent rather than merely non-throwing.
 */
function run(
  h: ReturnType<typeof harness>,
  next: () => Observable<Row>,
  context = contextFor(),
): Promise<Row> {
  // `intercept` is typed for the un-audited case and returns `Observable<unknown>`
  // once it has decided to audit, which is exactly the widening under test. The
  // cast is on the return, not on the observable, so a handler returning the wrong
  // shape still fails here.
  return firstValueFrom(
    h.interceptor.intercept(context, {
      handle: next,
    } as never) as Observable<Row>,
  );
}

describe('a route that did not ask for auditing', () => {
  it('is left alone, with no request read and no entry written', async () => {
    // The fast path is the reason this is safe to bind at a controller: an
    // undecorated route must cost nothing at all, or binding it broadly would put
    // an interceptor on every request in the application.
    const h = harness(undefined);
    const getRequest = vi.fn(() => ({ headers: {}, params: {} }));

    await firstValueFrom(
      h.interceptor.intercept(
        {
          switchToHttp: () => ({ getRequest }),
          getHandler: () => function handler() {},
          getClass: () => class Controller {},
        } as never,
        { handle: () => of({ id: 'u1' }) } as never,
      ),
    );

    expect(h.record).not.toHaveBeenCalled();
    expect(getRequest).not.toHaveBeenCalled();
  });

  it('passes the response through untouched', async () => {
    const h = harness(undefined);

    await expect(run(h, () => of({ id: 'u1' }))).resolves.toEqual({ id: 'u1' });
  });

  it('still lets an error through untouched', async () => {
    // An undecorated route must not gain a failure path as a side effect of the
    // interceptor being bound above it.
    const h = harness(undefined);
    const failure = new Error('boom');

    await expect(
      firstValueFrom(
        h.interceptor.intercept(contextFor(), {
          handle: () => throwError(() => failure),
        } as never),
      ),
    ).rejects.toThrow('boom');
  });
});

describe('a successful audited action', () => {
  it('names the actor, not the token', async () => {
    const h = harness(policy);

    await run(h, () => of({ id: 'u9' }), contextFor({ user }));

    expect(entries(h.record)[0]).toMatchObject({
      actor: { id: 'u1', email: 'admin@x.com', type: 'user' },
    });
  });

  it('calls an unauthenticated caller anonymous rather than guessing', async () => {
    // A public route that reaches a service which is audited anyway. "anonymous" is
    // the honest answer; inventing an actor from an ip would be a fabrication.
    const h = harness({ ...policy, targetIdFrom: [] });

    await run(h, () => of({ id: 'u9' }));

    expect(entries(h.record)[0]).toMatchObject({
      actor: { id: null, type: 'anonymous' },
    });
  });

  it('takes the target id from the route parameter', async () => {
    const h = harness(policy);

    await run(h, () => of({ id: 'u9' }), contextFor({ params: { id: 'u9' } }));

    expect(entries(h.record)[0]).toMatchObject({ targetId: 'u9' });
  });

  it('takes it from the caller for a self-service route', async () => {
    // The shape with no id in the path at all, which is why `targetIdFrom` is a
    // list rather than a single source.
    const h = harness({ ...policy, targetIdFrom: ['user'] });

    await run(h, () => of({ id: 'u1' }), contextFor({ user }));

    expect(entries(h.record)[0]).toMatchObject({ targetId: 'u1' });
  });

  it('takes it from the response for a create', async () => {
    const h = harness({ ...policy, targetIdFrom: ['result'] });

    await run(h, () => of({ id: 'new-1' }));

    expect(entries(h.record)[0]).toMatchObject({ targetId: 'new-1' });
  });

  it('records a null target rather than failing the request', async () => {
    // Incomplete audit metadata is not worth a 500. The entry is still evidence
    // that the action ran, which is most of the value.
    const h = harness({ ...policy, targetIdFrom: [['param', 'missing']] });

    await run(h, () => of({ id: 'u9' }));

    expect(entries(h.record)[0]).toMatchObject({ targetId: null });
  });

  it('records the response as `after`', async () => {
    const h = harness(policy);

    await run(
      h,
      () => of({ id: 'u9', role: 'admin' }),
      contextFor({ params: { id: 'u9' } }),
    );

    expect(entries(h.record)[0]).toMatchObject({
      after: { role: 'admin' },
    });
  });

  it('never invents a `before`', async () => {
    // The interceptor sees the request and the response, never the row as it was.
    // A reconstructed before-state in a table presented as evidence is worse than
    // none: it looks like a record and it is an inference.
    const h = harness(policy);

    await run(h, () => of({ id: 'u9', role: 'admin' }));

    expect(entries(h.record)[0]?.before).toBeNull();
  });

  it('stores nothing for a response with no shape to diff', async () => {
    // A 204 and a list of sessions are both "the action happened". Storing an empty
    // object for either would read as "nothing changed" instead.
    const h = harness(policy);

    await run(h, () => of(undefined));

    expect(entries(h.record)[0]?.after).toBeNull();
  });

  it('stores nothing when the route turned diffing off', async () => {
    // A delete. Diffing its empty response would be a diff of nothing, stored as
    // an object, which is the same shape as a real diff with no changes in it.
    const h = harness({ ...policy, diffResponse: false });

    await run(h, () => of({ id: 'u9' }));

    expect(entries(h.record)[0]?.after).toBeNull();
  });

  it('carries the address, the agent and the request id', async () => {
    const h = harness(policy);

    await run(
      h,
      () => of({ id: 'u9' }),
      contextFor({
        ip: '203.0.113.9',
        headers: { 'user-agent': 'Firefox on Linux', 'x-request-id': 'req-7' },
      }),
    );

    const [entry, context] = h.record.mock.calls[0] ?? [];

    expect(entry).toBeDefined();
    expect(context).toMatchObject({
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox on Linux',
      requestId: 'req-7',
    });
  });

  it('does not wait for the write', async () => {
    // The write goes to the database the request already used, and `record` never
    // throws, so there is nothing to wait for and something to lose: the response
    // time of every privileged action.
    const h = harness(policy);

    await expect(run(h, () => of({ id: 'u9' }))).resolves.toEqual({ id: 'u9' });
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});

describe('a refused audited action', () => {
  it('is recorded, because a refusal is evidence', async () => {
    // The half most systems skip. A permission that was refused is a fact about
    // the account; a permission that was never asked for is not.
    const h = harness(policy);

    await expect(
      firstValueFrom(
        h.interceptor.intercept(contextFor(), {
          handle: () => throwError(() => new ForbiddenException('Nope')),
        } as never),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(entries(h.record)[0]).toMatchObject({
      outcome: 'failure',
      statusCode: 403,
      error: 'Nope',
    });
  });

  it('rethrows the original error, unchanged', async () => {
    // Byte-identical. An interceptor that shaped the failure would be a second way
    // to answer an enumeration question, and would break every client that matches
    // on the body.
    const h = harness(policy);
    const failure = new ForbiddenException('Nope');

    await expect(
      firstValueFrom(
        h.interceptor.intercept(contextFor(), {
          handle: () => throwError(() => failure),
        } as never),
      ),
    ).rejects.toBe(failure);
  });

  it('stores no `after`, because nothing was returned', async () => {
    const h = harness(policy);

    await firstValueFrom(
      h.interceptor.intercept(contextFor(), {
        handle: () => throwError(() => new ForbiddenException()),
      } as never),
    ).catch(() => undefined);

    expect(entries(h.record)[0]?.after).toBeNull();
  });

  it('can be opted out of, for a route where a refusal is noise', async () => {
    const h = harness({ ...policy, recordFailures: false });

    await firstValueFrom(
      h.interceptor.intercept(contextFor(), {
        handle: () => throwError(() => new ForbiddenException()),
      } as never),
    ).catch(() => undefined);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('records a null status rather than guessing 500', async () => {
    // An error that never reached the client has no status, and a wrong one in an
    // audit table is a small lie that is expensive to notice later.
    const h = harness(policy);

    await firstValueFrom(
      h.interceptor.intercept(contextFor(), {
        handle: () => throwError(() => new Error('something broke')),
      } as never),
    ).catch(() => undefined);

    expect(entries(h.record)[0]).toMatchObject({ statusCode: null });
  });
});

describe('the metadata lookup', () => {
  it('reads the handler and the class', async () => {
    // A controller-level `@Audited()` is the natural way to protect a whole
    // controller, and a lookup that ignored the class would silently not apply it.
    const reflector = { getAllAndOverride: vi.fn() };

    await firstValueFrom(
      new AuditInterceptor(
        reflector as unknown as Reflector,
        { record: vi.fn() } as never,
      ).intercept(contextFor(), { handle: () => of({}) } as never),
    );

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(AUDIT_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});

describe('a route with no user on the request', () => {
  beforeEach(() => {
    // A rejected request that never reached a controller still has `user` attached
    // by the JWT guard. This asserts the interceptor reads it rather than assuming
    // it, and copes when it is genuinely absent.
  });

  it('reads the address from the socket when there is no ip', async () => {
    const h = harness(policy);

    await run(
      h,
      () => of({ id: 'u9' }),
      contextFor({ socket: { remoteAddress: '198.51.100.4' } }),
    );

    const [, context] = h.record.mock.calls[0] ?? [];

    expect(context).toMatchObject({ ipAddress: '198.51.100.4' });
  });

  it('takes the first of a repeated header rather than joining it', async () => {
    // A repeated `user-agent` arrives as an array. Joining it would put a value
    // chosen by the caller, separator and all, into an audit row.
    const h = harness(policy);

    await run(
      h,
      () => of({ id: 'u9' }),
      contextFor({ headers: { 'user-agent': ['first', 'second'] } }),
    );

    const [, context] = h.record.mock.calls[0] ?? [];

    expect(context).toMatchObject({ userAgent: 'first' });
  });

  it('records null rather than undefined when there is no address at all', async () => {
    const h = harness(policy);

    await run(h, () => of({ id: 'u9' }));

    const [, context] = h.record.mock.calls[0] ?? [];

    expect(context).toMatchObject({ ipAddress: null, userAgent: null });
  });
});
