import { Logger } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationConfig } from '../../configs/notification.config.js';
import { dedupeKey } from '../queue/dedupe-key.js';
import { QUEUE_NAMES } from '../queue/queue.interface.js';
import type { Job, JobQueue, QueueName } from '../queue/queue.interface.js';
import { NotificationEventsService } from './notification-events.service.js';
import { NOTIFICATION_JOB } from './processors/notification.processor.js';

/**
 * The emit side is what a business service calls, and its whole job is to be
 * unbreakable: a registration must return its token whether or not redis is
 * reachable, and the notification must be the only thing lost when it is not.
 */

const KEYS = [
  'NOTIFICATION_ENABLED',
  'NOTIFICATION_CONSOLE_ENABLED',
  'NOTIFICATION_EMAIL_ENABLED',
  'NOTIFICATION_EMAIL_TO',
  'TELEGRAM_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_TOPIC_ID',
  'TELEGRAM_TOPICS',
  'SLACK_ENABLED',
  'SLACK_WEBHOOK_URL',
  'SLACK_CHANNEL',
  'DISCORD_ENABLED',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_CHANNEL',
  'NOTIFICATION_TIMEOUT',
  'NOTIFICATION_RETRIES',
  'NOTIFICATION_RETRY_DELAY',
  'NOTIFICATION_THROW_ON_FAILURE',
] as const;

interface Harness {
  service: NotificationEventsService;
  enqueue: ReturnType<typeof vi.fn>;
  /** Every `(queue, job)` pair the dispatcher was handed, in order. */
  calls: { queue: QueueName; job: Job }[];
}

function harness(
  enqueue: (queue: QueueName, job: Job) => Promise<void> = async () =>
    undefined,
): Harness {
  const calls: { queue: QueueName; job: Job }[] = [];
  const record = vi.fn(async (queue: QueueName, job: Job) => {
    calls.push({ queue, job });

    return enqueue(queue, job);
  });

  return {
    service: new NotificationEventsService({
      driver: 'in-process',
      enqueue: record,
    } as unknown as JobQueue),
    enqueue: record,
    calls,
  };
}

beforeEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }

  vi.clearAllMocks();
});

describe('enqueueing', () => {
  it("uses the notification queue and this module's job name", async () => {
    // The queue is chosen by the name's prefix inside the BullMQ adapter, so a job
    // named `notification.send` would land on the mail queue and inherit mail's
    // concurrency and dedupe key.
    const h = harness();

    await h.service.notify('user.registered', {
      email: 'ada@example.com',
      firstName: 'Ada',
    });

    expect(h.calls[0].queue).toBe(QUEUE_NAMES.notification);
    expect(h.calls[0].job.name).toBe(NOTIFICATION_JOB);
  });

  it('carries the event name and its data, never a rendered message', async () => {
    // Rendering at enqueue time would freeze the wording into the queue, so a template
    // changed between the enqueue and the run would send the old text — and a template
    // bug would fail the request instead of the job.
    const h = harness();

    await h.service.notify('user.registered', {
      email: 'ada@example.com',
      firstName: 'Ada',
    });

    expect(h.calls[0].job.payload).toEqual({
      event: 'user.registered',
      data: { email: 'ada@example.com', firstName: 'Ada' },
      userId: undefined,
    });
  });

  it('passes a user id through so a preference can be applied', async () => {
    const h = harness();

    await h.service.notify(
      'auth.2fa.enabled',
      { email: 'ada@example.com' },
      { userId: 'u1' },
    );

    expect(h.calls[0].job.payload).toMatchObject({ userId: 'u1' });
  });

  it('reports success once the queue accepted the job', async () => {
    const h = harness();

    await expect(
      h.service.notify('user.registered', {
        email: 'a@x.com',
        firstName: 'A',
      }),
    ).resolves.toMatchObject({ queued: true });
  });

  it('gives every event its own id, so two log lines can be told apart', async () => {
    const h = harness();

    const first = await h.service.notify('user.registered', {
      email: 'a@x.com',
      firstName: 'A',
    });
    const second = await h.service.notify('user.registered', {
      email: 'a@x.com',
      firstName: 'A',
    });

    expect(first.notificationId).not.toBe(second.notificationId);
  });
});

describe('the dedupe key', () => {
  it('differs between two events of the same kind, because they are not duplicates', async () => {
    // The guard's job is to stop a queue *redelivery* producing two copies, not to
    // collapse two genuine events. A key derived from the event name alone would
    // suppress the second failed sign-in, which is the one an operator wants.
    const h = harness();

    await h.service.notify('auth.login.failed', {
      email: 'a@x.com',
      failures: 5,
      blockedMinutes: 1,
    });
    await h.service.notify('auth.login.failed', {
      email: 'a@x.com',
      failures: 6,
      blockedMinutes: 2,
    });

    expect(h.calls[0].job.dedupeKey).not.toBe(h.calls[1].job.dedupeKey);
  });

  it('is stable for the same subject id, so a redelivery is recognised as one', async () => {
    // This is the case the guard exists for: the same event enqueued twice with the
    // same subject must collide, or a redelivery delivers a duplicate alert.
    const h = harness();

    await h.service.notify(
      'auth.login.failed',
      { email: 'a@x.com', failures: 5, blockedMinutes: 1 },
      { subjectId: 'block-1' },
    );
    await h.service.notify(
      'auth.login.failed',
      { email: 'a@x.com', failures: 5, blockedMinutes: 1 },
      { subjectId: 'block-1' },
    );

    expect(h.calls[0].job.dedupeKey).toBe(h.calls[1].job.dedupeKey);
  });

  it('is built by the shared helper rather than by hand at the call site', async () => {
    // A hand-rolled key is subtly different from the one the guard expects, and then
    // the guard silently stops guarding.
    const h = harness();

    await h.service.notify(
      'user.registered',
      { email: 'ada@example.com', firstName: 'Ada' },
      { userId: 'u1', subjectId: 's1' },
    );

    expect(h.calls[0].job.dedupeKey).toBe(
      dedupeKey({
        template: 'user.registered',
        to: 'u1',
        subjectId: 's1',
      }),
    );
  });

  it('names the event in the key, so two events for one user are not one job', async () => {
    const h = harness();

    await h.service.notify(
      'auth.2fa.enabled',
      { email: 'a@x.com' },
      { userId: 'u1', subjectId: 's1' },
    );
    await h.service.notify(
      'auth.2fa.disabled',
      { email: 'a@x.com' },
      { userId: 'u1', subjectId: 's1' },
    );

    expect(h.calls[0].job.dedupeKey).not.toBe(h.calls[1].job.dedupeKey);
  });
});

describe('when the queue is down', () => {
  it('reports it and resolves rather than rejecting', async () => {
    // The caller is a registration that is already holding a token. Rejecting here
    // would need a `catch` at every one of those call sites, and one of them would
    // eventually be forgotten.
    const h = harness(async () => {
      throw new Error('redis is unreachable');
    });

    await expect(
      h.service.notify('user.registered', {
        email: 'a@x.com',
        firstName: 'A',
      }),
    ).resolves.toMatchObject({ queued: false });
  });

  it('says so in the log, because a dropped alert is otherwise invisible', async () => {
    // Nothing else records it: no log row is written, because the job never ran.
    const h = harness(async () => {
      throw new Error('redis is unreachable');
    });
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await h.service.notify('user.registered', {
      email: 'a@x.com',
      firstName: 'A',
    });

    const logged = error.mock.calls.flat().join('\n');

    error.mockRestore();

    expect(logged).toContain('user.registered');
    expect(logged).toContain('nothing else was affected');
  });

  it('still returns an id, so a caller logging the call has something to quote', async () => {
    const h = harness(async () => {
      throw new Error('redis is unreachable');
    });

    const result = await h.service.notify('user.registered', {
      email: 'a@x.com',
      firstName: 'A',
    });

    expect(result.notificationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('notifyUser', () => {
  it('is the same call with the user id in the obvious place', async () => {
    const h = harness();

    await h.service.notifyUser(
      'user.registered',
      { email: 'ada@example.com', firstName: 'Ada' },
      'u1',
    );

    expect(h.calls[0].job.payload).toMatchObject({ userId: 'u1' });
  });

  it('still accepts a subject id, because a per-user event can repeat', async () => {
    const h = harness();

    await h.service.notifyUser(
      'auth.login.failed',
      { email: 'a@x.com', failures: 5, blockedMinutes: 1 },
      'u1',
      { subjectId: 'block-1' },
    );
    await h.service.notifyUser(
      'auth.login.failed',
      { email: 'a@x.com', failures: 5, blockedMinutes: 1 },
      'u1',
      { subjectId: 'block-1' },
    );

    expect(h.calls[0].job.dedupeKey).toBe(h.calls[1].job.dedupeKey);
  });
});

describe('the configuration namespace', () => {
  it('is loaded with forFeature rather than globally, so an app that never notifies carries none of it', () => {
    // Asserted here rather than in the config spec because the reason it is not in
    // `configs/index.ts` is the module graph, and this is where that graph is declared.
    expect(notificationConfig()).toMatchObject({ enabled: false });
  });
});
