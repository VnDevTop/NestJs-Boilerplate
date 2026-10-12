import { describe, expect, it, vi } from 'vitest';

import {
  AuditService,
  changedFields,
  redactForAudit,
} from './audit.service.js';

/**
 * Two things this suite exists to pin down.
 *
 * The redaction, because an audit diff is built from whatever object the action was
 * performed on — usually a `User`, which carries a password hash. A year of
 * "who changed what" that quietly also holds every credential the system has is
 * worse than no audit trail at all, and it fails open: nothing about the table
 * looks wrong until somebody exports it.
 *
 * And the never-throw behaviour, which is the opposite of the usual advice and
 * needs an assertion to survive the next person who "fixes" it.
 */

/**
 * The row as it was handed to `insert`.
 *
 * Typed as taking one argument of a fixed shape, so `mock.calls[0][0]` is a
 * `Record` rather than `undefined` — which is what it would be against a
 * zero-argument `vi.fn()`, and what made every assertion in this file a compile
 * error before the signature was here.
 */
interface InsertedRow {
  [key: string]: unknown;
}

function harness() {
  const insert = vi.fn(async (_row: InsertedRow) => undefined);

  const service = new AuditService({ insert } as never);

  return { service, insert };
}

/** The row a call wrote, typed for reading. */
function rowOf(insert: ReturnType<typeof harness>['insert']): InsertedRow {
  return insert.mock.calls[0]?.[0] ?? {};
}

const context = {
  ipAddress: '203.0.113.9',
  userAgent: 'Firefox on Linux',
  requestId: 'req-1',
};

const actor = { id: 'u1', email: 'admin@x.com', type: 'user' };

describe('what never gets written', () => {
  it('drops the password hash', async () => {
    // The whole reason this module is careful. `users.password` holds an scrypt
    // hash, and an audit table is read by operators, exported to a SIEM and kept
    // for a year — none of which are places a credential belongs.
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        before: { email: 'a@x.com', password: '$scrypt$salt$key' },
        after: { email: 'a@x.com', password: '$scrypt$other$key' },
        outcome: 'success',
      },
      context,
    );

    const row = rowOf(h.insert);

    expect(row.before).toMatchObject({ password: '[redacted]' });
    expect(row.after).toMatchObject({ password: '[redacted]' });
    // The key itself stays, which is deliberate: "the password changed" is useful
    // to an operator and "this field exists" is not a disclosure.
    expect(JSON.stringify(row)).not.toContain('$scrypt$');
  });

  it('drops bearer credentials, which are the same hazard', async () => {
    // A reset token, a two-factor secret and a recovery code are all credentials
    // that work, and all three live on objects an action might be performed on.
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'auth.2fa.setup',
        targetType: 'user',
        targetId: 'u1',
        after: {
          tokenHash: 'abc',
          secret: 'JBSWY3DPEHPK3PXP',
          recoveryCodes: ['a', 'b'],
          challengeToken: 'c',
        },
        outcome: 'success',
      },
      context,
    );

    expect(rowOf(h.insert).after).toEqual({
      tokenHash: '[redacted]',
      secret: '[redacted]',
      recoveryCodes: '[redacted]',
      challengeToken: '[redacted]',
    });
  });

  it('drops them at any depth, not only at the top', async () => {
    // A diff of a nested object is a diff of whatever the entity happened to hold.
    // A top-level filter passes this test and fails in production.
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        after: { profile: { secrets: { password: 'nested-hash' } } },
        outcome: 'success',
      },
      context,
    );

    expect(JSON.stringify(h.insert.mock.calls[0]?.[0])).not.toContain(
      'nested-hash',
    );
  });

  it('drops them inside arrays too', async () => {
    // A list of sessions each carrying its own token is a list of credentials.
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'auth.logout',
        targetType: 'user',
        targetId: 'u1',
        before: { sessions: [{ refreshToken: 'r1' }, { refreshToken: 'r2' }] },
        outcome: 'success',
      },
      context,
    );

    expect(JSON.stringify(h.insert.mock.calls[0]?.[0])).not.toContain('r1');
  });

  it('keeps everything else, which is the point of a diff', async () => {
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        before: { role: 'user' },
        after: { role: 'admin' },
        outcome: 'success',
      },
      context,
    );

    expect(rowOf(h.insert)).toMatchObject({
      before: { role: 'user' },
      after: { role: 'admin' },
      changedFields: ['role'],
    });
  });

  it('replaces rather than truncates, so the field is still visibly present', async () => {
    // An operator looking at the row should be able to see that the password
    // changed without being able to see what it is. Removing the key entirely
    // makes "changed" and "never existed" the same answer.
    expect(redactForAudit({ password: 'x', email: 'a@x.com' })).toEqual({
      password: '[redacted]',
      email: 'a@x.com',
    });
  });

  it('stops at a fixed depth rather than recursing into a hostile body', async () => {
    // A body is a diff source for some actions and a body can nest ten thousand
    // levels deep. Unbounded recursion on that is a stack overflow inside the error
    // handler, which is the worst place to have one.
    let deep: Record<string, unknown> = { password: 'bottom' };

    for (let level = 0; level < 50; level += 1) {
      deep = { nested: deep };
    }

    const redacted = JSON.stringify(redactForAudit(deep));

    expect(redacted).not.toContain('bottom');
    expect(redacted).toContain('[too deep]');
  });

  it('is a no-op on a primitive, which several actions pass', async () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit('a string')).toBe('a string');
    expect(redactForAudit(42)).toBe(42);
  });
});

describe('the changed fields', () => {
  it('lists only what actually differs', () => {
    expect(
      changedFields(
        { role: 'user', email: 'a@x.com' },
        { role: 'admin', email: 'a@x.com' },
      ),
    ).toEqual(['role']);
  });

  it('is sorted, so two entries for the same change compare equal', () => {
    // An entry compared against a later one for "did anybody else touch this too"
    // should not report a difference caused only by key order.
    expect(changedFields({ b: 1, a: 1 }, { a: 1, b: 1 })).toEqual([]);
  });

  it('counts a field appearing or disappearing as a change', () => {
    // This is what makes a create and a delete readable from `changedFields` alone.
    expect(changedFields(null, { email: 'a@x.com' })).toEqual(['email']);
    expect(changedFields({ email: 'a@x.com' }, null)).toEqual(['email']);
  });

  it('does not compare by reference', () => {
    // A value rebuilt rather than mutated is not a change, and `!==` would report
    // one on every diff of an object TypeORM reassembled.
    expect(
      changedFields({ nested: { role: 'user' } }, { nested: { role: 'user' } }),
    ).toEqual([]);
  });
});

describe('writing the row', () => {
  it('leaves before, after and changedFields null for an action with no diff', async () => {
    // A sign-in has no before and no after. Writing empty objects would make
    // "nothing changed" indistinguishable from "we did not look".
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'auth.login',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'success',
      },
      context,
    );

    expect(rowOf(h.insert)).toMatchObject({
      before: null,
      after: null,
      changedFields: null,
    });
  });

  it('records failures as well as successes', async () => {
    // The half most systems skip. A permission that was refused is evidence; a
    // permission that was never asked for is not.
    const h = harness();

    await h.service.record(
      {
        actor: { id: null, email: null, type: 'anonymous' },
        action: 'users.delete',
        targetType: 'user',
        targetId: 'u9',
        outcome: 'failure',
        statusCode: 403,
        error: 'Forbidden resource',
      },
      context,
    );

    expect(rowOf(h.insert)).toMatchObject({
      outcome: 'failure',
      actorType: 'anonymous',
      statusCode: 403,
    });
  });

  it('caps the user agent, which is attacker-controlled', async () => {
    // An uncapped one is a megabyte of whatever the caller felt like sending,
    // written to a table nobody is watching for size.
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'success',
      },
      { ...context, userAgent: 'x'.repeat(5000) },
    );

    expect(rowOf(h.insert).userAgent).toHaveLength(500);
  });

  it('caps the error for the same reason', async () => {
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'failure',
        error: 'e'.repeat(5000),
      },
      context,
    );

    expect(rowOf(h.insert).error).toHaveLength(500);
  });

  it('carries the request id, which is what makes it an investigation', async () => {
    const h = harness();

    await h.service.record(
      {
        actor,
        action: 'users.update',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'success',
      },
      context,
    );

    expect(rowOf(h.insert)).toMatchObject({ requestId: 'req-1' });
  });
});

describe('when the write fails', () => {
  it('does not throw', async () => {
    // An audit write that failed the action it was recording would mean an outage
    // in the log becomes an outage in the product — and the log is the thing you
    // least want taking the application down. The availability failure is larger,
    // more frequent and more visible than the integrity failure, and an operator
    // reading the gap can see that it happened.
    const h = harness();
    h.insert.mockRejectedValueOnce(new Error('table is full'));

    await expect(
      h.service.record(
        {
          actor,
          action: 'users.delete',
          targetType: 'user',
          targetId: 'u1',
          outcome: 'success',
        },
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it('says which action was lost', async () => {
    // A silent gap is indistinguishable from an action that never happened, which
    // is the one conclusion an audit log must never support.
    const h = harness();
    const logged: string[] = [];

    vi.spyOn(
      (h.service as never as { logger: { error: (m: string) => void } }).logger,
      'error',
    ).mockImplementation((message: string) => logged.push(message));

    h.insert.mockRejectedValueOnce(new Error('connection terminated'));

    await h.service.record(
      {
        actor,
        action: 'users.delete',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'success',
      },
      context,
    );

    expect(logged.join('\n')).toContain('users.delete');
  });

  it('reports that the action itself was unaffected, so nobody reads it as a failure', async () => {
    const h = harness();
    const logged: string[] = [];

    vi.spyOn(
      (h.service as never as { logger: { error: (m: string) => void } }).logger,
      'error',
    ).mockImplementation((message: string) => logged.push(message));

    h.insert.mockRejectedValueOnce(new Error('x'));

    await h.service.record(
      {
        actor,
        action: 'users.delete',
        targetType: 'user',
        targetId: 'u1',
        outcome: 'success',
      },
      context,
    );

    expect(logged.join('\n')).toContain('not affected');
  });
});
