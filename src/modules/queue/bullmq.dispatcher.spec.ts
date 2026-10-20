import type { ConfigService } from '@nestjs/config';

import { describe, expect, it, vi } from 'vitest';

import type { QueueConfig } from '../../configs/queue.config.js';
import {
  BullMqDispatcher,
  type BullMqDispatcherOptions,
} from './bullmq.dispatcher.js';
import type { JobProgressService } from './job-progress.service.js';
import { MAIL_JOB, type MailJobPayload } from './processors/mail.processor.js';
import type { Job, JobRequest, JobResult } from './queue.interface.js';

const config: QueueConfig = {
  enabled: true,
  url: 'redis://localhost:6379/1',
  prefix: 'queue',
  jobTimeout: 300_000,
  retry: { attempts: 4, backoffDelay: 25, backoffMaxDelay: 100 },
  concurrency: { mail: 3, notification: 2, maintenance: 1, digest: 1 },
  removeOnCompleteAfter: 60_000,
  removeOnFailAfter: 86_400_000,
  progressTtl: 60_000,
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

const job: JobRequest = { name: MAIL_JOB, payload };

/** Stands in for the real bullmq module, recording what it was asked for. */
function fakeBullmq() {
  const queues: { name: string; options: Record<string, unknown> }[] = [];
  const workers: {
    queue: { name: string };
    handler: (job: { name: string; data: unknown }) => Promise<unknown>;
    options: Record<string, unknown>;
  }[] = [];
  const closed: string[] = [];

  /**
   * What each queue was asked to store, per queue name.
   *
   * The fake keeps it so a test can hand the worker exactly what bullmq would
   * hand it. A test that invents its own `data` is testing a path that does not
   * exist, and that is how a double-wrapped payload survived in this file.
   */
  const stored = new Map<string, { name: string; data: unknown }[]>();

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

      async add(name: string, data: unknown, options: Record<string, unknown>) {
        const entries = stored.get(this.name) ?? [];

        entries.push({ name, data });
        stored.set(this.name, entries);

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

  return { module, queues, workers, closed, counts, stored };
}

type FakeBullmq = ReturnType<typeof fakeBullmq>;

/**
 * Hands a stored job to the worker the way bullmq does.
 *
 * BullMQ gives the worker the name the job was added under and the data that
 * was stored with it, so a test that passes anything else is not testing the
 * delivery path.
 */
function deliver(
  fake: FakeBullmq,
  queueName: string,
  index = 0,
): Promise<unknown> {
  const worker = fake.workers.find((w) => w.queue.name === queueName);
  const entry = fake.stored.get(queueName)?.[index];

  if (worker === undefined || entry === undefined) {
    throw new Error(`no stored job ${index} on the ${queueName} queue`);
  }

  return worker.handler({ name: entry.name, data: entry.data });
}

/**
 * A progress store that records what it was told.
 *
 * The dispatcher writes to it on every state change, and a test that asserts
 * nothing about it would pass whether the progress worked or not.
 */
function progress() {
  const record = vi.fn().mockResolvedValue(undefined);
  const markRunning = vi.fn().mockResolvedValue(undefined);
  const finish = vi.fn().mockResolvedValue(undefined);
  const forget = vi.fn().mockResolvedValue(undefined);

  return {
    service: {
      record,
      markRunning,
      finish,
      report: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn(),
      requestCancel: vi.fn(),
      isCancelled: vi.fn().mockResolvedValue(false),
      forget,
    } as unknown as JobProgressService,
    record,
    markRunning,
    finish,
    forget,
  };
}

function build(
  behaviour: () => Promise<JobResult> = async () => ({ ok: true }),
  bullmq: BullMqDispatcherOptions['bullmq'] = undefined,
) {
  const fake = fakeBullmq();
  // Typed so a test can read back the job the registry was called with, which is
  // the only way to see what the processor would have received.
  const process = vi.fn<(job: Job) => Promise<JobResult>>(behaviour);
  const store = progress();

  const dispatcher = new BullMqDispatcher(
    configService(),
    { process },
    store.service,
    bullmq === undefined ? (fake.module as never) : bullmq,
  );

  return { dispatcher, process, progress: store, ...fake };
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
      progress().service,
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
      progress().service,
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
    const fake = build(async () => ({ ok: true }));

    const id = await fake.dispatcher.enqueue('mail', job);
    await deliver(fake, 'mail');

    // The same registry the in-process dispatcher uses, which is what makes the
    // fallback a fallback rather than a second implementation.
    //
    // The id is the one the enqueue handed back, so the caller can watch the
    // exact run the processor is doing.
    expect(fake.process).toHaveBeenCalledWith({ id, name: MAIL_JOB, payload });
  });

  it('hands the processor the payload, not the stored envelope', async () => {
    const fake = build(async () => ({ ok: true }));

    await fake.dispatcher.enqueue('mail', job);
    await deliver(fake, 'mail');

    // The whole job is stored, because the processor needs the name and the
    // dedupe key as well as the payload. Wrapping it again on the way out put
    // the job *inside* the payload, so `payload.to` did not exist and every mail
    // failed validation as malformed.
    const received = fake.process.mock.calls[0]?.[0] as Job;

    expect(received.payload).toEqual(payload);
  });

  it('carries the dedupe key through the queue', async () => {
    const fake = build(async () => ({ ok: true }));

    const id = await fake.dispatcher.enqueue('mail', {
      ...job,
      dedupeKey: 'dedupe:abc',
    });
    await deliver(fake, 'mail');

    // The key is what stops a redelivery sending the same mail twice, and it
    // only does that if it survives the trip through redis.
    expect(fake.process).toHaveBeenCalledWith({
      id,
      name: MAIL_JOB,
      payload,
      dedupeKey: 'dedupe:abc',
    });
  });

  it('leaves the dedupe key off a job that was enqueued without one', async () => {
    const fake = build(async () => ({ ok: true }));

    await fake.dispatcher.enqueue('mail', job);
    await deliver(fake, 'mail');

    // An empty key would be a key every such job shares, which would collapse
    // unrelated work into one.
    const received = fake.process.mock.calls[0]?.[0] as Job;

    expect(received.dedupeKey).toBeUndefined();
  });

  it('fails a stored value that is not a job, permanently', async () => {
    const fake = build(async () => ({ ok: true }));

    await fake.dispatcher.enqueue('mail', job);

    // BullMQ hands back whatever was stored. A value that is not a job cannot be
    // processed, and a retry would read the same bytes again, so this must not
    // burn the retry budget.
    const outcome = await fake.workers[0]
      .handler({ name: MAIL_JOB, data: { to: 'a@x.com' } })
      .then(() => ({ threw: false, name: '' }))
      .catch((error: Error) => ({ threw: true, name: error.name }));

    expect(outcome.threw).toBe(true);
    expect(outcome.name).toBe('UnrecoverableError');
  });

  it('gives each queue the concurrency its config names', async () => {
    const fake = build();

    await fake.dispatcher.enqueue('maintenance', job);
    await fake.dispatcher.enqueue('mail', job);

    const maintenance = fake.workers.find(
      (w) => w.queue.name === 'maintenance',
    );
    const mail = fake.workers.find((w) => w.queue.name === 'mail');

    expect(maintenance?.options.concurrency).toBe(1);
    expect(mail?.options.concurrency).toBe(3);
  });
});

describe('BullMqDispatcher progress', () => {
  it('gives the caller the id of the job it queued', async () => {
    const fake = build(async () => ({ ok: true }));

    // The id is the handle: without it a caller cannot ask what happened to
    // the job it asked for.
    await expect(fake.dispatcher.enqueue('mail', job)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('records the job under that id before it is handed to bullmq', async () => {
    const fake = build(async () => ({ ok: true }));

    const id = await fake.dispatcher.enqueue('mail', job);

    // The record is written first, so a worker that picks the job up
    // immediately cannot have its "running" overwritten by "queued".
    expect(fake.progress.record).toHaveBeenCalledWith(
      expect.objectContaining({ id, name: MAIL_JOB }),
      'mail',
    );
  });

  it('records that the job started, and how it ended', async () => {
    const fake = build(async () => ({ ok: true }));

    const id = await fake.dispatcher.enqueue('mail', job);
    await deliver(fake, 'mail');

    expect(fake.progress.markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
    );
    expect(fake.progress.finish).toHaveBeenCalledWith(
      id,
      'completed',
      undefined,
    );
  });

  it('records a failure as a failure, with the reason', async () => {
    const fake = build(async () => ({
      ok: false,
      error: 'the database went away',
      retryable: false,
    }));

    const id = await fake.dispatcher.enqueue('mail', job);

    await expect(deliver(fake, 'mail')).rejects.toThrow(/database went away/);

    expect(fake.progress.finish).toHaveBeenCalledWith(
      id,
      'failed',
      'the database went away',
    );
  });

  it('forgets a job that bullmq refused, rather than leaving a record of it', async () => {
    const fake = build();
    const broken = {
      Queue: class {
        constructor() {}
        async add() {
          throw new Error('redis is down');
        }
        async close() {}
      },
      Worker: class {
        constructor() {}
        on() {
          return this;
        }
      },
    };

    const dispatcher = new BullMqDispatcher(
      configService(),
      { process: vi.fn() },
      fake.progress.service,
      broken as never,
    );

    await expect(dispatcher.enqueue('mail', job)).rejects.toThrow(
      /redis is down/,
    );

    // A record of a job that never reached the queue is a lie an operator would
    // watch.
    expect(fake.progress.forget).toHaveBeenCalled();
  });
});

describe('BullMqDispatcher failure signalling', () => {
  /** Calls the worker handler the way bullmq does and reports what it threw. */
  async function runHandler(
    behaviour: () => Promise<JobResult>,
  ): Promise<{ threw: boolean; name: string; message: string }> {
    const fake = build(behaviour);

    await fake.dispatcher.enqueue('mail', job);

    try {
      await deliver(fake, 'mail');

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
      progress().service,
      module as never,
    );

    await dispatcher.enqueue('mail', job);

    await expect(dispatcher.onModuleDestroy()).resolves.toBeUndefined();
  });
});
