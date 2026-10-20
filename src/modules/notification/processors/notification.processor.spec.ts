import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Job } from '../../queue/queue.interface.js';
import type { NotificationService } from '../notification.service.js';
import {
  NOTIFICATION_JOB,
  NotificationProcessor,
} from './notification.processor.js';

/**
 * The processor is the only caller of the delivery service, so it owns two decisions
 * nobody else makes: what counts as malformed, and — the one that matters — whether a
 * partially delivered notification is a failure.
 */

const DATA = { email: 'ada@example.com', firstName: 'Ada' };

interface Harness {
  processor: NotificationProcessor;
  notify: ReturnType<typeof vi.fn>;
}

function harness(
  outcome:
    | {
        deliveries?: {
          channel: string;
          delivered: boolean;
          skipped?: boolean;
          permanent?: boolean;
          error?: string;
          attempts?: number;
        }[];
        skipped?: boolean;
      }
    | Error = {},
): Harness {
  const notify = vi.fn().mockImplementation(async () =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve({
          notificationId: 'n1',
          event: 'user.registered',
          deliveries: [],
          ...outcome,
        }),
  );

  return {
    processor: new NotificationProcessor({
      notify,
    } as unknown as NotificationService),
    notify,
  };
}

const job = (payload: unknown): Job<never> =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name: NOTIFICATION_JOB,
    payload,
  }) as Job<never>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('routing', () => {
  it('claims exactly its own job name', () => {
    // The router asks this rather than comparing strings itself, so the answer is
    // one place. `notify.` and not `notification.` because the BullMQ adapter routes
    // queues by prefix and its notification branch tests for `notify`.
    expect(NotificationProcessor.handles(NOTIFICATION_JOB)).toBe(true);
    expect(NotificationProcessor.handles('mail.send')).toBe(false);
    expect(NotificationProcessor.handles('maintenance.run-retention')).toBe(
      false,
    );
    expect(NotificationProcessor.handles('notify')).toBe(false);
  });
});

describe('the delivery classification', () => {
  it('succeeds when one channel took it and another did not', async () => {
    // The opposite of the mail processor, and the reason is the fan-out: a queue
    // retry here would re-attempt every channel for the sake of the one that failed,
    // so a Slack alert would arrive five times because Telegram was down.
    const h = harness({
      deliveries: [
        { channel: 'telegram', delivered: false, error: 'status 500' },
        { channel: 'slack', delivered: true, attempts: 1 },
      ],
    });

    await expect(
      h.processor.process(job({ event: 'user.registered', data: DATA })),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it('succeeds when nothing was configured, rather than filling the dead-letter list', async () => {
    // A deployment with notifications off was told not to send. A failure here would
    // retry it and then record work nobody asked for.
    const h = harness({ deliveries: [], skipped: true });

    await expect(
      h.processor.process(job({ event: 'user.registered', data: DATA })),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it('succeeds when every channel was muted, because retrying cannot un-mute one', async () => {
    const h = harness({
      deliveries: [
        { channel: 'slack', delivered: false, skipped: true, attempts: 0 },
        { channel: 'telegram', delivered: false, skipped: true, attempts: 0 },
      ],
    });

    await expect(
      h.processor.process(job({ event: 'user.registered', data: DATA })),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it('ignores a muted channel when judging whether anything was delivered', async () => {
    // Slack muted, Telegram down. The muted channel is not a channel that failed, so
    // the job still fails — and "one channel refused" is the useful error.
    const h = harness({
      deliveries: [
        { channel: 'slack', delivered: false, skipped: true, attempts: 0 },
        { channel: 'telegram', delivered: false, error: 'timeout' },
      ],
    });

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('telegram');
    expect(result.error).not.toContain('slack');
  });

  it('fails retryably when a channel refused transiently', async () => {
    const h = harness({
      deliveries: [
        { channel: 'slack', delivered: false, error: 'socket hang up' },
      ],
    });

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('fails permanently when every channel refused permanently', async () => {
    // A revoked token answers identically every time, so retrying spends the budget
    // and delays the dead-letter entry that says the credential is wrong.
    const h = harness({
      deliveries: [
        {
          channel: 'slack',
          delivered: false,
          permanent: true,
          error: 'status 401',
        },
      ],
    });

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('retries when one channel refused permanently and another did not', async () => {
    // One of them might come back. A blanket "permanent" because one address was a
    // 404 would drop the retry on the channel that was merely down.
    const h = harness({
      deliveries: [
        {
          channel: 'slack',
          delivered: false,
          permanent: true,
          error: 'status 404',
        },
        { channel: 'telegram', delivered: false, error: 'timeout' },
      ],
    });

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('names every channel that failed, because one of them is the one to fix', async () => {
    const h = harness({
      deliveries: [
        { channel: 'slack', delivered: false, error: 'status 500' },
        { channel: 'discord', delivered: false, error: 'socket hang up' },
      ],
    });

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result.error).toContain('slack: status 500');
    expect(result.error).toContain('discord: socket hang up');
  });
});

describe('payload validation', () => {
  it('refuses a payload that is not an object', async () => {
    for (const payload of [null, 'notify', 42, undefined]) {
      const h = harness();

      await expect(h.processor.process(job(payload))).resolves.toMatchObject({
        ok: false,
        retryable: false,
      });
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it('refuses an event the registry does not have', async () => {
    // The payload crossed a queue, so its event name is untrusted. Rendering an
    // unknown one would be a lookup that returns undefined and a crash inside the job.
    const h = harness();

    await expect(
      h.processor.process(job({ event: 'user.exploded', data: DATA })),
    ).resolves.toMatchObject({ ok: false, retryable: false });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('refuses an event name that only looks like a real one', async () => {
    // `in` would have accepted `constructor` from a prototype chain walk.
    const h = harness();

    await expect(
      h.processor.process(job({ event: 'constructor', data: DATA })),
    ).resolves.toMatchObject({ ok: false, retryable: false });
  });

  it('refuses a payload with no data object', async () => {
    const h = harness();

    await expect(
      h.processor.process(job({ event: 'user.registered' })),
    ).resolves.toMatchObject({ ok: false, retryable: false });
  });

  it('refuses a user id that is not a string, rather than passing it to the log', async () => {
    const h = harness();

    await expect(
      h.processor.process(
        job({ event: 'user.registered', data: DATA, userId: 42 }),
      ),
    ).resolves.toMatchObject({ ok: false, retryable: false });
  });

  it('refuses permanently, because retrying a malformed payload only produces it again', async () => {
    const h = harness();

    const result = await h.processor.process(
      job({ event: 'nope', data: DATA }),
    );

    expect(result.retryable).toBe(false);
    expect(result.error).toContain('Malformed');
  });

  it('accepts a payload with no user, for a deployment-level event', async () => {
    const h = harness({ deliveries: [{ channel: 'slack', delivered: true }] });

    await expect(
      h.processor.process(job({ event: 'user.registered', data: DATA })),
    ).resolves.toEqual({ ok: true });
  });

  it('forwards the user id so a preference can be applied', async () => {
    const h = harness({ deliveries: [{ channel: 'slack', delivered: true }] });

    await h.processor.process(
      job({ event: 'user.registered', data: DATA, userId: 'u1' }),
    );

    expect(h.notify).toHaveBeenCalledWith('user.registered', DATA, {
      userId: 'u1',
    });
  });
});

describe('an unclassified fault', () => {
  it('is retryable rather than discarded, and never rejects', async () => {
    // A rejection here would be an unhandled rejection in the in-process dispatcher,
    // and Node ends the process on one.
    const h = harness(new Error('boom'));

    const result = await h.processor.process(
      job({ event: 'user.registered', data: DATA }),
    );

    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(result.error).toContain('boom');
  });

  it('is left retryable even though the service absorbs channel failures', async () => {
    // Only `throwOnFailure` or a bug in the service reaches here, and both are worth
    // another attempt: the alternative is discarding real work over a fault nobody
    // has classified.
    const h = harness(new Error('unexpected'));

    await expect(
      h.processor.process(job({ event: 'user.registered', data: DATA })),
    ).resolves.toMatchObject({ ok: false, retryable: true });
  });
});
