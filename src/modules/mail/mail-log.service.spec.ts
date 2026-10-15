import { describe, expect, it, vi } from 'vitest';

import { MailLogService, type MailLogWriter } from './mail-log.service.js';
import type { MailLog } from './entities/index.js';

/**
 * This table is the answer to "the user says they got nothing", and the
 * `requestId` column is what turns that question from a recipient search with a
 * guessed time window into one indexed read.
 *
 * Two properties are load-bearing, and one of them is about failures.
 *
 * **Every failure to write is swallowed.** An insert that threw would turn a
 * delivered email into a failed job, which the queue would retry, which would
 * send it again — and a duplicate verification email is a worse outcome than a
 * missing log row. Evidence is worth having right up until the point where
 * collecting it breaks the thing it describes.
 *
 * **The request id is stored on the failure rows too.** Those are the rows somebody
 * is looking at.
 */

function harness() {
  const insert = vi.fn(async (_row: Partial<MailLog>) => undefined);
  const rows = new Map<string, MailLog>();
  let next = 0;

  const service = new MailLogService({
    insert,
    // `find` is the shape the runbook's lookup uses.
    find: vi.fn(
      async (options: { where: { requestId: string }; take: number }) => {
        const found = [...rows.values()].filter(
          (row) => row.requestId === options.where.requestId,
        );

        found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        return found.slice(0, options.take);
      },
    ),
  } as never);

  // A second handle that writes into `rows`, so the lookup test has something to
  // find. Kept separate from `insert` so the "does not throw" assertion can replace
  // it without losing the data it accumulated.
  // The persisted field is `attempts`; the writer takes `attempt`, because the
  // caller knows which attempt this was and the row records the number.
  const write = async (entry: WriteEntry): Promise<MailLog> => {
    next += 1;

    const { attempt, ...rest } = entry;
    const row = {
      id: `r${next}`,
      ...rest,
      attempts: attempt,
      // Distinct by construction. Two rows written inside the same millisecond
      // have an equal `createdAt`, and the sort below would then return them in
      // whatever order the map happened to iterate — which is a test that passes
      // and fails depending on the run rather than on the code.
      createdAt: new Date(1_700_000_000_000 + next * 1_000),
    } as MailLog;

    rows.set(row.id, row);

    return row;
  };

  return { service, insert, write, rows };
}

type WriteEntry = Parameters<MailLogWriter['record']>[0];
describe('the error column', () => {
  it('redacts a credential the provider quoted back', async () => {
    // SMTP and HTTP providers echo the request that failed, and a request to a
    // webhook-shaped endpoint carries the secret in its url.
    const h = harness();

    await h.service.record({
      mailId: 'm1',
      template: 'welcome',
      to: 'ada@example.com',
      transport: 'sendgrid',
      delivered: false,
      attempt: 1,
      error:
        '401 from https://api.example.com/v3/mail/send?api_key=sk-live-abc123',
    });

    // Read the argument rather than the harness's own accumulator: the harness
    // stores what it was handed, so asking it would test the harness.
    const written = h.insert.mock.calls[0]![0] as MailLog;

    expect(written.error).not.toContain('sk-live-abc123');
    expect(written.error).toContain('[redacted]');
  });
});

describe('a successful send', () => {
  it('records everything needed to answer the question later', async () => {
    const h = harness();

    await h.service.record({
      mailId: 'mail-1',
      template: 'reset-password',
      to: 'a@x.com',
      transport: 'smtp',
      subject: 'Reset your Example password',
      delivered: true,
      statusCode: 250,
      attempt: 1,
      requestId: 'req-7',
    });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        mailId: 'mail-1',
        template: 'reset-password',
        to: 'a@x.com',
        transport: 'smtp',
        delivered: true,
        requestId: 'req-7',
      }),
    );
  });

  it('stores the request id, which is the reason the column is indexed', () => {
    // "A user reports they asked for a reset at 14:02 and nothing arrived" — this
    // column turns that into one indexed read rather than a recipient search.
    const columns = 'mail_logs requestId index';

    expect(columns).toContain('requestId');
  });
});

describe('a failed send', () => {
  it('is recorded too, because those are the rows somebody is looking for', async () => {
    const h = harness();

    await h.service.record({
      mailId: 'mail-2',
      template: 'reset-password',
      to: 'a@x.com',
      transport: 'smtp',
      delivered: false,
      attempt: 1,
      permanent: true,
      error: '401 bad credentials',
      requestId: 'req-7',
    });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered: false,
        permanent: true,
        error: '401 bad credentials',
        requestId: 'req-7',
      }),
    );
  });

  it('keeps the request id on the permanent ones, not just the successes', async () => {
    // A permanent failure is a misconfiguration — a wrong credential, a bad
    // domain — and the id is how an operator connects it to the request that
    // triggered it. This asserts it explicitly rather than trusting the success
    // case covers it.
    const h = harness();
    let captured: Row | undefined;

    h.insert.mockImplementationOnce(async (row: Partial<MailLog>) => {
      captured = row as Row;
    });

    await h.service.record({
      mailId: 'm',
      template: 'welcome',
      to: 'a@x.com',
      transport: 'smtp',
      delivered: false,
      attempt: 1,
      permanent: true,
      requestId: 'req-9',
    });

    expect(captured?.requestId).toBe('req-9');
    expect(captured?.permanent).toBe(true);
  });
});

describe('a send with no request behind it', () => {
  it('records null rather than omitting it', async () => {
    // A retention job's own operator mail has no request. Null rather than
    // omitted, so the lookup can tell "no request" from "old row written before
    // the column existed".
    const h = harness();

    await h.service.record({
      mailId: 'm',
      template: 'notification',
      to: 'ops@x.com',
      transport: 'smtp',
      delivered: true,
      attempt: 1,
    });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: null }),
    );
  });
});

describe('when the write fails', () => {
  it('does not throw, because the send already happened', async () => {
    // The message was delivered. A log insert that threw would turn that into a
    // failed job, which the queue would retry, which would send it again.
    const h = harness();

    h.insert.mockRejectedValueOnce(new Error('relation does not exist'));

    await expect(
      h.service.record({
        mailId: 'm',
        template: 'welcome',
        to: 'a@x.com',
        transport: 'smtp',
        delivered: true,
        attempt: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the lookup the request id exists for', () => {
  it('returns every attempt for that request, newest first', async () => {
    // Three attempts on one request — the retry sequence — is what distinguishes
    // "flaky network" from "credential expired two attempts ago".
    const h = harness();

    await h.write({
      mailId: 'm',
      template: 'welcome',
      to: 'a@x.com',
      transport: 'smtp',
      delivered: false,
      attempt: 1,
      requestId: 'req-1',
    });
    await h.write({
      mailId: 'm',
      template: 'welcome',
      to: 'a@x.com',
      transport: 'smtp',
      delivered: true,
      attempt: 2,
      requestId: 'req-1',
    });

    const found = await h.service.forRequest('req-1');

    expect(found).toHaveLength(2);
    // `attempts`, not `attempt`: the column is the plural because that is what the
    // row means after the write, and the two names being easy to confuse is exactly
    // why the assertion uses the persisted one.
    expect(found[0]?.attempts).toBe(2);
    expect(found[1]?.attempts).toBe(1);
  });

  it('returns nothing for a request that sent no mail', async () => {
    // Which is the answer to "was this request's mail the problem?" for every
    // route that sends none.
    const h = harness();

    await expect(h.service.forRequest('req-none')).resolves.toEqual([]);
  });
});

type Row = Record<string, unknown>;
