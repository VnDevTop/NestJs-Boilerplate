import { describe, expect, it } from 'vitest';

import type { ConfigService } from '@nestjs/config';

import type { QueueConfig } from '../../configs/queue.config.js';
import { JobProgressService } from './job-progress.service.js';
import type { Job } from './queue.interface.js';
import type { RedisClientService } from './redis-client.service.js';

const config: QueueConfig = {
  enabled: false,
  url: '',
  prefix: 'queue',
  jobTimeout: 300_000,
  retry: { attempts: 3, backoffDelay: 5, backoffMaxDelay: 10 },
  concurrency: { mail: 2, notification: 2, maintenance: 1, digest: 1 },
  removeOnCompleteAfter: 1000,
  removeOnFailAfter: 1000,
  progressTtl: 60_000,
  inProcessFallback: true,
  inProcessConcurrency: 5,
};

const job: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'maintenance.run-retention',
  payload: {},
};

/**
 * A redis that keeps what it is given, and can be told to be unreachable.
 *
 * The unreachable case is the interesting one: it is the difference between "no
 * such job" and "the store is down", and a store that answers both the same
 * way is what makes an operator think their job does not exist.
 */
function redis() {
  const keys = new Map<string, string>();
  let reachable = true;

  const client = {
    get: async (key: string): Promise<string | null> =>
      reachable ? (keys.get(key) ?? null) : null,
    inspect: async (key: string) => ({
      value: reachable ? (keys.get(key) ?? null) : null,
      reachable,
    }),
    set: async (key: string, value: string): Promise<boolean | null> => {
      if (!reachable) {
        return null;
      }

      keys.set(key, value);

      return true;
    },
    delete: async (key: string): Promise<boolean | null> => {
      if (!reachable) {
        return null;
      }

      return keys.delete(key);
    },
  };

  return {
    client: client as unknown as RedisClientService,
    keys,
    break: () => {
      reachable = false;
    },
  };
}

function build() {
  const store = redis();

  const service = new JobProgressService(store.client, {
    getOrThrow: (key: string) => (key === 'queue' ? config : undefined),
  } as unknown as ConfigService);

  return { service, ...store };
}

describe('JobProgressService', () => {
  it('records a job as waiting when it is queued', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');

    const lookup = await service.lookup(job.id);

    expect(lookup).toMatchObject({
      status: 'found',
      progress: {
        id: job.id,
        name: job.name,
        queue: 'maintenance',
        status: 'queued',
        processed: 0,
        total: null,
        startedAt: null,
      },
    });
  });

  it('records when a worker picked the job up', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.markRunning(job);

    const lookup = await service.lookup(job.id);

    expect(lookup).toMatchObject({
      status: 'found',
      progress: { status: 'running' },
    });
    expect(
      lookup.status === 'found' ? lookup.progress.startedAt : null,
    ).toBeTruthy();
  });

  it('keeps the first start time across a retry', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.markRunning(job);

    const first = await service.lookup(job.id);
    const startedAt =
      first.status === 'found' ? first.progress.startedAt : null;

    await service.markRunning(job);

    const second = await service.lookup(job.id);

    // A retried job is the same run, and a second "started" would make the
    // duration a lie.
    expect(second.status === 'found' ? second.progress.startedAt : null).toBe(
      startedAt,
    );
  });

  it('records what the job reports about its own progress', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.markRunning(job);
    await service.report(job.id, {
      processed: 3,
      total: 9,
      current: 'notification_logs',
    });

    const lookup = await service.lookup(job.id);

    expect(lookup).toMatchObject({
      status: 'found',
      progress: {
        processed: 3,
        total: 9,
        current: 'notification_logs',
      },
    });
  });

  it('leaves the progress alone when a report says nothing', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.report(job.id, { processed: 3, total: 9 });
    await service.report(job.id, {});

    const lookup = await service.lookup(job.id);

    expect(lookup).toMatchObject({
      status: 'found',
      progress: { processed: 3, total: 9 },
    });
  });

  it('records the end of a job and why it failed', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.finish(job.id, 'failed', 'the database went away');

    const lookup = await service.lookup(job.id);

    expect(lookup).toMatchObject({
      status: 'found',
      progress: { status: 'failed', error: 'the database went away' },
    });
    expect(
      lookup.status === 'found' ? lookup.progress.finishedAt : null,
    ).toBeTruthy();
  });

  it('says a job it never heard of is absent', async () => {
    const { service } = build();

    await expect(service.lookup('nobody')).resolves.toEqual({
      status: 'absent',
    });
  });

  it('says the store is unreachable rather than that the job is absent', async () => {
    const { service, break: breakRedis } = build();

    breakRedis();

    // The two are different facts. Answering "absent" would tell an operator
    // their job does not exist while it is running.
    await expect(service.lookup(job.id)).resolves.toEqual({
      status: 'unreachable',
    });
  });

  it('accepts a cancellation for a job that is still going', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.markRunning(job);

    await expect(service.requestCancel(job.id)).resolves.toEqual({
      outcome: 'accepted',
      status: 'running',
    });
    await expect(service.isCancelled(job.id)).resolves.toBe(true);
  });

  it('refuses to cancel a job that has already finished', async () => {
    const { service } = build();

    await service.record(job, 'maintenance');
    await service.finish(job.id, 'completed');

    await expect(service.requestCancel(job.id)).resolves.toEqual({
      outcome: 'finished',
      status: 'completed',
    });
  });

  it('says there is no such job rather than accepting a cancellation', async () => {
    const { service } = build();

    await expect(service.requestCancel('nobody')).resolves.toEqual({
      outcome: 'absent',
    });
  });

  it('says the store is unreachable when the cancellation cannot be recorded', async () => {
    const { service, break: breakRedis } = build();

    await service.record(job, 'maintenance');
    breakRedis();

    await expect(service.requestCancel(job.id)).resolves.toEqual({
      outcome: 'unreachable',
    });
  });

  it('forgets a job that is not going to run', async () => {
    const { service, keys } = build();

    await service.record(job, 'maintenance');
    await service.forget(job.id);

    // A record of a job that never reached the queue is a lie an operator would
    // watch.
    expect(keys.size).toBe(0);
    await expect(service.lookup(job.id)).resolves.toEqual({
      status: 'absent',
    });
  });

  it('survives a store that cannot be written to', async () => {
    const { service, break: breakRedis } = build();

    breakRedis();

    // The work is the point. A progress store that is down must not stop it.
    await expect(service.record(job, 'maintenance')).resolves.toBeUndefined();
    await expect(service.markRunning(job)).resolves.toBeUndefined();
    await expect(service.finish(job.id, 'completed')).resolves.toBeUndefined();
  });
});
