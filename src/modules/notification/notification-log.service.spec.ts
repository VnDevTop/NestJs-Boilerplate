import { Logger } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationLogService } from './notification-log.service.js';
import type { LogEntry } from './types/index.js';

/**
 * The log is evidence, and its one hard rule is that collecting it must never break
 * the thing it describes. Every test here is about that, plus the truncation that
 * keeps a provider's html error body out of a `varchar`.
 */

const ENTRY: LogEntry = {
  notificationId: 'n1',
  event: 'user.registered',
  channel: 'slack',
  userId: 'u1',
  delivered: true,
  attempts: 1,
  recipient: 'ops',
  body: 'Address: ada@example.com',
};

interface Harness {
  service: NotificationLogService;
  insert: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const insert = vi.fn().mockResolvedValue({ identifiers: [] });

  return {
    service: new NotificationLogService({ insert } as never),
    insert,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('record', () => {
  it('writes the row the delivery needs to be reconstructed', async () => {
    const h = harness();

    await h.service.record(ENTRY);

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'n1',
        event: 'user.registered',
        channel: 'slack',
        userId: 'u1',
        delivered: true,
        attempts: 1,
        recipient: 'ops',
        body: 'Address: ada@example.com',
      }),
    );
  });

  it('writes null rather than undefined for the fields a failure has no value for', async () => {
    // The columns are nullable rather than optional, so an insert carrying `undefined`
    // asks the driver to guess what was meant.
    const h = harness();

    await h.service.record({
      notificationId: 'n1',
      event: 'user.registered',
      channel: 'telegram',
      delivered: false,
      attempts: 0,
      error: 'muted by the recipient',
    });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        recipient: null,
        statusCode: null,
        body: null,
      }),
    );
  });

  it('stores a failure as readily as a success, because the refusal is the record', async () => {
    // A log that only records successes cannot answer "did it arrive", which is the
    // only question anybody has at 3am.
    const h = harness();

    await h.service.record({
      notificationId: 'n1',
      event: 'user.registered',
      channel: 'telegram',
      delivered: false,
      attempts: 3,
      statusCode: 401,
      error: 'status 401',
    });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: false, statusCode: 401 }),
    );
  });

  it('cuts an over-long error rather than letting the insert fail', async () => {
    // A proxy's error body can be a page of html. The column is 500 characters, and
    // the first 500 of an error still identify the error.
    const h = harness();

    await h.service.record({ ...ENTRY, error: 'x'.repeat(5_000) });

    const written = h.insert.mock.calls[0][0];

    expect(written.error).toHaveLength(501);
    expect(written.error.endsWith('…')).toBe(true);
  });

  it('cuts an over-long body, which a rendered event can be', async () => {
    const h = harness();

    await h.service.record({ ...ENTRY, body: 'y'.repeat(4_000) });

    expect(h.insert.mock.calls[0][0].body).toHaveLength(1_001);
  });

  it('leaves a value that fits untouched, so truncation is never silent', async () => {
    const h = harness();

    await h.service.record({ ...ENTRY, error: 'status 401' });

    expect(h.insert.mock.calls[0][0].error).toBe('status 401');
  });

  it('swallows an insert failure rather than failing the delivery it describes', async () => {
    // The alternative: a notification log insert that throws turns a delivered webhook
    // into a failed job, which the queue retries, which delivers it again. An operator
    // would rather have a missing row than a tripled security alert.
    const h = harness();

    h.insert.mockRejectedValue(new Error('connection terminated'));

    await expect(h.service.record(ENTRY)).resolves.toBeUndefined();
  });

  it('says so when a row could not be written', async () => {
    // Otherwise a table that silently stopped growing looks exactly like a deployment
    // where nothing happened.
    const h = harness();
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    h.insert.mockRejectedValue(new Error('connection terminated'));

    await h.service.record(ENTRY);

    const logged = error.mock.calls.flat().join('\n');

    error.mockRestore();

    expect(logged).toContain('user.registered');
    expect(logged).toContain(ENTRY.channel as string);
  });
});

describe('reading', () => {
  it('asks for the newest rows first, capped by the caller', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const service = new NotificationLogService({ find } as never);

    await service.recent(50);

    expect(find).toHaveBeenCalledWith({
      order: { createdAt: 'DESC' },
      take: 50,
    });
  });

  it('returns one notification of attempts in the order they were made', async () => {
    // Collapsing these would lose the sequence, and the sequence is what tells
    // "flaky network" from "the token expired".
    const find = vi.fn().mockResolvedValue([]);
    const service = new NotificationLogService({ find } as never);

    await service.forNotification('n1');

    expect(find).toHaveBeenCalledWith({
      where: { notificationId: 'n1' },
      order: { createdAt: 'ASC' },
    });
  });
});
