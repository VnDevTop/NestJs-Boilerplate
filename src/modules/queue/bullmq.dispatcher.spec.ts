import type { ConfigService } from '@nestjs/config';

import { describe, expect, it, vi } from 'vitest';

import type { QueueConfig } from '../../configs/queue.config.js';
import {
  BullMqDispatcher,
  type BullMqDispatcherOptions,
} from './bullmq.dispatcher.js';
import { MAIL_JOB, type MailJobPayload } from './processors/mail.processor.js';
import type { Job, JobResult } from './queue.interface.js';

const config: QueueConfig = {
  enabled: true,
  url: 'redis://localhost:6379/1',
  prefix: 'queue',
  jobTimeout: 300_000,
  retry: { attempts: 4, backoffDelay: 25, backoffMaxDelay: 100 },
  concurrency: { mail: 3, notification: 2, maintenance: 1, digest: 1 },
  removeOnCompleteAfter: 60_000,
  removeOnFailAfter: 86_400_000,
  inProcessFallback: true,
  inProcessConcurrency: 5,
};

function configService(): ConfigService {
  return { getOrThrow: () => config } as unknown as ConfigService;
}

const payload: MailJobPayload = {
  to: 'a@x.com',
  template: 'welcome',
  data: { firstName: 'Ada', appName: 'Example' },
};

const job: Job = { name: MAIL_JOB, payload };

/** Stands in for the real bullmq module, recording what it was asked for. */
function fakeBullmq() {
  const queues: { name: string; options: Record<string, unknown> }[] = [];
  const workers: {
    queue: { name: string };
    handler: (job: { name: string; data: unknown }) => Promise<unknown>;
    options: Record<string, unknown>;
  }[] = [];
  const closed: string[] = [];

  /** Per-queue counts, so a test can say what the backlog looks like. */
  const counts: Record<string, Record<string, number>> = {};

  const module = {
    Queue: class {
      constructor(
        public name: string,
        public options: Record<string, unknown>,
      ) {
        queues.push({ name, options });
      }

      async add(
        _name: string,
        _data: unknown,
        options: Record<string, unknown>,
      ) {
        return { id: 'job-1', options };
      }

      async close() {
        closed.push(`queue:${this.name}`);
      }

      /** Counts per state, overridable per test through `counts`. */
      async getJobCounts(..._types: string[]) {
        return counts[this.name] ?? {};
      }
    },
    Worker: class {
      constructor(
        public queue: { name: string },
        public handler: (job: {
          name: string;
          data: unknown;
        }) => Promise<unknown>,
        public options: Record<string, unknown>,
      ) {
        workers.push({ queue, handler, options });
      }

      on() {
        return this;
      }

      async close() {
        closed.push(`worker:${this.queue.name}`);
      }
    },
  };

  return { module, queues, workers, closed, counts };
}

function build(
  behaviour: () => Promise<JobResult> = async () => ({ ok: true }),
  bullmq: BullMqDispatcherOptions['bullmq'] = undefined,
) {
  const { module, queues, workers, closed, counts } = fakeBullmq();
  const process = vi.fn(behaviour);

  const dispatcher = new BullMqDispatcher(
    configService(),
    { process },
    bullmq === undefined ? (module as never) : bullmq,
  );

  return { dispatcher, process, queues, workers, closed, counts };
}

describe('BullMqDispatcher availability', () => {
  it('reports itself available when bullmq resolves', () => {
    expect(build().dispatcher.isAvailable()).toBe(true);
  });

  it('reports itself unavailable when the package is missing', () => {
    // This is the case the whole abstraction exists for: the package is not
    // installed, so the factory picks the in-process dispatcher instead.
    expect(build(undefined, null).dispatcher.isAvailable()).toBe(false);
  });

  it('names its driver, so the health check can report it', () => {
    expect(build().dispatcher.driver).toBe('bullmq');
  });
});

describe('BullMqDispatcher.enqueue', () => {
  it('resolves without opening a worker for a queue it never uses', async () => {
    const { dispatcher, workers } = build();

    await dispatcher.enqueue('mail', job);

    expect(workers).toHaveLength(1);
  });

  it('opens one queue per name, and reuses it', async () => {
    const { dispatcher, queues } = build();

    await dispatcher.enqueue('mail', job);
    await dispatcher.enqueue('mail', job);

    expect(queues).toHaveLength(1);
  });

  it('passes the retry budget from config, so the queue and the fallback agree', async () => {
    const added: Record<string, unknown>[] = [];
    const { module } = fakeBullmq();
    const originalAdd = module.Queue.prototype.add;

    module.Queue.prototype.add = async function (
      this: { name: string },
      name: string,
      data: unknown,
      options: Record<string, unknown>,
    ) {
      added.push({ queue: this.name, name, data, ...options });

      return originalAdd.call(this, name, data, options);
    };

    const dispatcher = new BullMqDispatcher(
      configService(),
      { process: vi.fn() },
      module as never,
    );

    await dispatcher.enqueue('mail', job);

    // Turning the queue on must not change how many attempts a job gets, or the
    // same failure behaves differently depending on a config flag.
    expect(added[0].attempts).toBe(config.retry.attempts);
    expect(added[0].backoff).toEqual({
      type: 'exponential',
      delay: config.retry.backoffDelay,
    });
  });

  it('converts the removal ages to seconds, which is what bullmq expects', async () => {
    const added: Record<string, unknown>[] = [];
    const { module } = fakeBullmq();
    const originalAdd = module.Queue.prototype.add;

    module.Queue.prototype.add = async function (
      this: { name: string },
      name: string,
      data: unknown,
      options: Record<string, unknown>,
    ) {
      added.push(options);

      return originalAdd.call(this, name, data, options);
    };

    const dispatcher = new BullMqDispatcher(
      configService(),
      { process: vi.fn() },
      module as never,
    );

    await dispatcher.enqueue('mail', job);

    // Config is in milliseconds and bullmq's age is in seconds. Passing the raw
    // number would keep failed jobs a thousand times too long.
    expect(added[0].removeOnComplete).toEqual({ age: 60 });
    expect(added[0].removeOnFail).toEqual({ age: 86_400 });
  });

  it('opens the connection lazily, so a redis outage is not a boot failure', () => {
    // The constructor takes bullmq but must not build a Queue until something is
    // enqueued, or the app would crash at start instead of falling back.
    const { queues } = build();

    expect(queues).toHaveLength(0);
  });

  it('rejects clearly when the package is absent and something still enqueues', async () => {
    const { dispatcher } = build(undefined, null);

    await expect(dispatcher.enqueue('mail', job)).rejects.toThrow(
      /npm install bullmq/,
    );
  });
});

describe('BullMqDispatcher.depth', () => {
  it('reports the counts per state, which is what the backlog alert reads', async () => {
    const { dispatcher, counts } = build();

    counts['mail'] = {
      waiting: 12,
      active: 2,
      failed: 3,
      delayed: 1,
    };

    await expect(dispatcher.depth('mail')).resolves.toEqual({
      waiting: 12,
      active: 2,
      failed: 3,
      delayed: 1,
    });
  });

  it('defaults a state the backend did not count to zero', async () => {
    // `getJobCounts` returns only the states it was asked for, so an absent key is
    // an empty list rather than a missing measurement.
    const { dispatcher, counts } = build();

    counts['mail'] = { waiting: 5 };

    await expect(dispatcher.depth('mail')).resolves.toMatchObject({
      waiting: 5,
      active: 0,
    });
  });

  it('answers null rather than zeroes when redis cannot be asked', async () => {
    // The dangerous answer is zeros. A dashboard reporting no waiting jobs while
    // the store is unreachable looks healthier than an application with no jobs.
    const broken = {
      Queue: class {
        constructor() {}
        async getJobCounts() {
          throw new Error('ECONNREFUSED');
        }
      },
      Worker: class {
        constructor() {}
        on() {
          return this;
        }
      },
    };

    const { dispatcher } = build(async () => ({ ok: true }), broken as never);

    await expect(dispatcher.depth('mail')).resolves.toBeNull();
  });

  it('answers null when bullmq itself is absent, which is the same situation', async () => {
    // Opening the queue is what fails when the package is missing, so this covers
    // both "redis is down" and "not installed" with one answer.
    const { dispatcher } = build(async () => ({ ok: true }), null);

    await expect(dispatcher.depth('mail')).resolves.toBeNull();
  });
});

describe('BullMqDispatcher worker routing', () => {
  it('runs the job through the shared registry', async () => {
    const { dispatcher, process, workers } = build(async () => ({ ok: true }));

    await dispatcher.enqueue('mail', job);
    await workers[0].handler({ name: MAIL_JOB, data: payload });

    // The same registry the in-process dispatcher uses, which is what makes the
    // fallback a fallback rather than a second implementation.
    expect(process).toHaveBeenCalledWith({ name: MAIL_JOB, payload });
  });

  it('gives each queue the concurrency its config names', async () => {
    const { dispatcher, workers } = build();

    await dispatcher.enqueue('maintenance', job);
    await dispatcher.enqueue('mail', job);

    const maintenance = workers.find((w) => w.queue.name === 'maintenance');
    const mail = workers.find((w) => w.queue.name === 'mail');

    expect(maintenance?.options.concurrency).toBe(1);
    expect(mail?.options.concurrency).toBe(3);
  });
});

describe('BullMqDispatcher failure signalling', () => {
  /** Calls the worker handler the way bullmq does and reports what it threw. */
  async function runHandler(
    behaviour: () => Promise<JobResult>,
  ): Promise<{ threw: boolean; name: string; message: string }> {
    const { dispatcher, workers } = build(behaviour);
    await dispatcher.enqueue('mail', job);

    try {
      await workers[0].handler({ name: MAIL_JOB, data: payload });

      return { threw: false, name: '', message: '' };
    } catch (error) {
      const err = error as Error;

      return { threw: true, name: err.name, message: err.message };
    }
  }

  it('throws nothing when the job succeeded', async () => {
    expect((await runHandler(async () => ({ ok: true }))).threw).toBe(false);
  });

  it('throws a retryable error, which is what makes bullmq retry', async () => {
    const outcome = await runHandler(async () => ({
      ok: false,
      error: 'ETIMEDOUT',
      retryable: true,
    }));

    expect(outcome.threw).toBe(true);
    expect(outcome.name).not.toBe('UnrecoverableError');
  });

  it('throws an UnrecoverableError for a permanent failure, so bullmq stops', async () => {
    const outcome = await runHandler(async () => ({
      ok: false,
      error: 'invalid api key',
      retryable: false,
    }));

    // bullmq checks `err instanceof UnrecoverableError || err.name ==
    // 'UnrecoverableError'`, so the name is enough and the class does not have to
    // be imported, which would break a deployment without the package.
    expect(outcome.name).toBe('UnrecoverableError');
    expect(outcome.message).toContain('invalid api key');
  });

  it('says something when a permanent failure carried no reason', async () => {
    const outcome = await runHandler(async () => ({
      ok: false,
      retryable: false,
    }));

    expect(outcome.message).toBeTruthy();
  });
});

describe('BullMqDispatcher shutdown', () => {
  it('closes workers before queues', async () => {
    const { dispatcher, closed } = build();

    await dispatcher.enqueue('mail', job);
    await dispatcher.onModuleDestroy();

    // Closing a queue while its worker is still draining drops the jobs in flight.
    expect(closed[0]).toMatch(/^worker:/);
    expect(closed.some((entry) => entry.startsWith('queue:'))).toBe(true);
  });

  it('survives a close that throws, rather than blocking shutdown', async () => {
    const { module } = fakeBullmq();
    module.Worker.prototype.close = async () => {
      throw new Error('socket already gone');
    };
    const dispatcher = new BullMqDispatcher(
      configService(),
      { process: vi.fn() },
      module as never,
    );

    await dispatcher.enqueue('mail', job);

    await expect(dispatcher.onModuleDestroy()).resolves.toBeUndefined();
  });
});
