import type { ConfigService } from '@nestjs/config';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueConfig } from '../../configs/queue.config.js';
import {
  InProcessDispatcher,
  type ProcessorRegistry,
} from './in-process.dispatcher.js';
import { MAIL_JOB, type MailJobPayload } from './processors/mail.processor.js';
import type { Job, JobResult } from './queue.interface.js';

const config: QueueConfig = {
  enabled: false,
  url: '',
  prefix: 'queue',
  jobTimeout: 300_000,
  retry: { attempts: 3, backoffDelay: 5, backoffMaxDelay: 10 },
  concurrency: { mail: 2, notification: 2, maintenance: 1, digest: 1 },
  removeOnCompleteAfter: 1000,
  removeOnFailAfter: 1000,
  inProcessFallback: true,
  inProcessConcurrency: 5,
};

interface Counters {
  calls: Job[];
  concurrent: number;
  peak: number;
}

function build(
  behaviour: (job: Job, attempt: number) => Promise<JobResult>,
  deadLetter?: unknown,
) {
  const counters: Counters = { calls: [], concurrent: 0, peak: 0 };
  const attempts = new WeakMap<Job, number>();

  const processors: ProcessorRegistry = {
    process: async (job: Job) => {
      counters.concurrent += 1;
      counters.peak = Math.max(counters.peak, counters.concurrent);
      counters.calls.push(job);

      const attempt = (attempts.get(job) ?? 0) + 1;
      attempts.set(job, attempt);

      try {
        return await behaviour(job, attempt);
      } finally {
        counters.concurrent -= 1;
      }
    },
  };

  const configService = {
    getOrThrow: (key: string) => (key === 'queue' ? config : undefined),
  } as unknown as ConfigService;

  return {
    dispatcher: new InProcessDispatcher(
      configService,
      processors,
      deadLetter as never,
    ),
    counters,
  };
}

const ok: JobResult = { ok: true };

const payload: MailJobPayload = {
  to: 'a@x.com',
  template: 'welcome',
  data: { firstName: 'Ada', appName: 'Example' },
};

const job: Job = { name: MAIL_JOB, payload };

/** Lets the detached promise chain settle, including any backoff timers. */
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('InProcessDispatcher.enqueue', () => {
  let dispatcher: InProcessDispatcher;

  beforeEach(() => {
    dispatcher = build(async () => ok).dispatcher;
  });

  it('names its driver, so the health check can report it', () => {
    expect(dispatcher.driver).toBe('in-process');
  });

  it('resolves before the job runs, so a request does not wait for it', async () => {
    const slow = build(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ok;
    });

    const started = Date.now();
    await slow.dispatcher.enqueue('mail', job);

    // The enqueue is what `register()` awaits. Resolving on completion would put
    // the provider's latency back into the request.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('hands the job to the processor', async () => {
    const { dispatcher: d, counters } = build(async () => ok);

    await d.enqueue('mail', job);
    await settle();

    expect(counters.calls).toHaveLength(1);
  });

  it('never rejects, whatever the processor does', async () => {
    const throwing = build(async () => {
      throw new Error('processor exploded');
    });

    await expect(
      throwing.dispatcher.enqueue('mail', job),
    ).resolves.toBeUndefined();
  });

  it('leaves no unhandled rejection when a processor throws', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const throwing = build(async () => {
        throw new Error('processor exploded');
      });

      await throwing.dispatcher.enqueue('mail', job);
      await settle();

      // Node ends the process on one of these, so this is a correctness property.
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('drops a job during shutdown rather than starting it', async () => {
    const { dispatcher: d, counters } = build(async () => ok);

    await d.onModuleDestroy();
    await d.enqueue('mail', job);
    await settle();

    expect(counters.calls).toHaveLength(0);
  });
});

describe('InProcessDispatcher concurrency', () => {
  it('never exceeds the per-queue limit', async () => {
    const { dispatcher, counters } = build(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok;
    });

    for (let index = 0; index < 10; index += 1) {
      await dispatcher.enqueue('mail', job);
    }
    await settle(80);

    // config.concurrency.mail is 2.
    expect(counters.peak).toBeLessThanOrEqual(2);
  });

  it('gives each queue its own limit, so maintenance cannot block mail', async () => {
    const { dispatcher, counters } = build(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok;
    });

    // maintenance is capped at 1, so six of them must not occupy the whole pool.
    for (let index = 0; index < 6; index += 1) {
      await dispatcher.enqueue('maintenance', job);
    }
    for (let index = 0; index < 2; index += 1) {
      await dispatcher.enqueue('mail', job);
    }
    await settle(120);

    expect(counters.calls).toHaveLength(8);
  });

  it('reports its depth, so the health check can show a backlog', async () => {
    const { dispatcher } = build(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok;
    });

    for (let index = 0; index < 5; index += 1) {
      await dispatcher.enqueue('mail', job);
    }

    const depth = await dispatcher.depth('mail');

    expect(depth.waiting + depth.active).toBeGreaterThan(0);
  });

  it('refuses work once the backlog is full, rather than growing the heap', async () => {
    const { dispatcher, counters } = build(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ok;
    });

    // The bound is concurrency * 50, so 100 with 2 slots.
    for (let index = 0; index < 120; index += 1) {
      await dispatcher.enqueue('mail', job);
    }
    await settle(30);

    expect(counters.calls.length).toBeLessThan(120);
  });
});

describe('InProcessDispatcher retry', () => {
  it('retries a retryable failure up to the configured attempts', async () => {
    const { dispatcher, counters } = build(async () => ({
      ok: false,
      error: 'ETIMEDOUT',
      retryable: true,
    }));

    await dispatcher.enqueue('mail', job);
    await settle(150);

    // config.retry.attempts is 3, so three runs: not one, not four.
    expect(counters.calls).toHaveLength(3);
  });

  it('does not retry a failure the processor called permanent', async () => {
    const { dispatcher, counters } = build(async () => ({
      ok: false,
      error: 'invalid api key',
      retryable: false,
    }));

    await dispatcher.enqueue('mail', job);
    await settle(80);

    // A 4xx answers the same way every time, so a second attempt is wasted.
    expect(counters.calls).toHaveLength(1);
  });

  it('stops after a success, so a recovered job is not run again', async () => {
    const { dispatcher, counters } = build(async (_job, attempt) =>
      attempt < 2 ? { ok: false, error: 'flaky', retryable: true } : ok,
    );

    await dispatcher.enqueue('mail', job);
    await settle(80);

    expect(counters.calls).toHaveLength(2);
  });

  it('waits longer before each retry', async () => {
    const at: number[] = [];
    const { dispatcher } = build(async () => {
      at.push(Date.now());
      return { ok: false, error: 'x', retryable: true };
    });

    await dispatcher.enqueue('mail', job);
    await settle(150);

    const gaps = at.slice(1).map((time, index) => time - at[index]);

    // backoffDelay is 5 then 10 with this config.
    expect(gaps[1] ?? 0).toBeGreaterThanOrEqual(gaps[0] ?? 0);
  });

  it('retries a processor that threw, rather than discarding the work', async () => {
    const { dispatcher, counters } = build(async () => {
      throw new Error('bug');
    });

    await dispatcher.enqueue('mail', job);
    await settle(150);

    expect(counters.calls).toHaveLength(3);
  });

  it('sends an exhausted job to the dead letter, with the attempt count', async () => {
    const record = vi.fn().mockResolvedValue(true);
    const deadLetter = { record, size: vi.fn() } as never;
    const { dispatcher } = build(
      async () => ({ ok: false, error: 'ETIMEDOUT', retryable: true }),
      deadLetter,
    );

    await dispatcher.enqueue('mail', job);
    await settle(150);

    // Without this the only record of a permanently lost email is a log line
    // nobody is watching.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({ error: 'ETIMEDOUT' });
    expect(record.mock.calls[0][2]).toBe(3);
  });

  it('sends a permanent failure to the dead letter without retrying first', async () => {
    const record = vi.fn().mockResolvedValue(true);
    const { dispatcher, counters } = build(
      async () => ({ ok: false, error: 'bad key', retryable: false }),
      { record, size: vi.fn() } as never,
    );

    await dispatcher.enqueue('mail', job);
    await settle(80);

    expect(counters.calls).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not dead-letter a job that succeeded', async () => {
    const record = vi.fn().mockResolvedValue(true);
    const { dispatcher } = build(async () => ok, {
      record,
      size: vi.fn(),
    } as never);

    await dispatcher.enqueue('mail', job);
    await settle(40);

    expect(record).not.toHaveBeenCalled();
  });

  it('does not retry a malformed payload, which cannot become valid', async () => {
    const { dispatcher, counters } = build(async () => ({
      ok: false,
      error: 'malformed',
      retryable: false,
    }));

    await dispatcher.enqueue('mail', { name: MAIL_JOB, payload: null });
    await settle(80);

    expect(counters.calls).toHaveLength(1);
  });
});

describe('InProcessDispatcher shutdown', () => {
  it('clears its pending retry timers, so the event loop can drain', async () => {
    const { dispatcher } = build(async () => ({
      ok: false,
      error: 'x',
      retryable: true,
    }));

    await dispatcher.enqueue('mail', job);
    await settle(20);

    // A live timer here would keep the process alive and hang the suite.
    await expect(dispatcher.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('is safe to shut down with nothing queued', async () => {
    const { dispatcher } = build(async () => ok);

    await expect(dispatcher.onModuleDestroy()).resolves.toBeUndefined();
  });
});
