import { describe, expect, it, vi } from 'vitest';

import { QueueHealthIndicator } from './queue.health.js';
import { QUEUE_NAMES } from '../../modules/queue/queue.interface.js';

/**
 * The queue check answers "is work piling up", and the rule under test is the same
 * one the cache check follows: **`degraded`, never `down`**.
 *
 * A backlog does not stop the application answering requests. It stops mail
 * arriving. Reporting `down` would take every instance out of rotation and turn a
 * delayed email into an outage of the API itself.
 *
 * The second rule is about honesty rather than safety: an **unreadable** backlog is
 * `degraded`, never `up`. A dashboard reporting zero waiting jobs while the store
 * is unreachable looks healthier than an application with no jobs at all.
 */

type Depth = {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
};

function harness(
  options: {
    depths?: Partial<Record<string, Depth | null>>;
    deadLettered?: number;
    reachable?: boolean;
    driver?: 'bullmq' | 'in-process';
  } = {},
) {
  const driver = options.driver ?? 'bullmq';

  const depth = vi.fn(async (queue: string) => {
    const found = options.depths?.[queue];

    return found === undefined
      ? { waiting: 0, active: 0, failed: 0, delayed: 0 }
      : found;
  });

  const size = vi.fn(async () => options.deadLettered ?? 0);
  const getClient = vi.fn(async () => {
    if (options.reachable === false) {
      throw new Error('redis is unreachable');
    }

    return {} as never;
  });

  const indicator = new QueueHealthIndicator(
    { driver, depth } as never,
    { size } as never,
    { getClient } as never,
  );

  return { indicator, depth, size, getClient };
}

describe('an idle queue', () => {
  it('is up', async () => {
    const h = harness();

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'up', backlog: 0 });
  });

  it('reports the driver, because the same symptom needs different answers', async () => {
    // "The queue is backed up" and "the queue is the in-process one" look the
    // same from outside, and the second means every pending job dies with the
    // process.
    const h = harness({ driver: 'in-process' });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ driver: 'in-process' });
  });

  it('reports a backlog per queue, because mail being slow is not maintenance being slow', async () => {
    const h = harness({
      depths: {
        mail: { waiting: 4, active: 1, failed: 0, delayed: 0 },
        maintenance: { waiting: 0, active: 0, failed: 0, delayed: 0 },
      },
    });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({
      worstQueue: 'mail',
      backlog: 4,
      depths: { mail: { waiting: 4 }, maintenance: { waiting: 0 } },
    });
  });
});

describe('a growing backlog', () => {
  it('is degraded once it passes the threshold', async () => {
    const h = harness({
      depths: {
        mail: { waiting: 5_000, active: 1, failed: 0, delayed: 0 },
      },
    });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'degraded' });
  });

  it('says which queue and by how much, because "the queue" is not actionable', async () => {
    const h = harness({
      depths: {
        mail: { waiting: 5_000, active: 0, failed: 0, delayed: 0 },
      },
    });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({
      reasons: expect.arrayContaining([
        expect.stringContaining('mail backlog is 5000'),
      ]),
    });
  });

  it('stays up just below the threshold', async () => {
    // The boundary is asserted from both sides, because an off-by-one here either
    // pages at 999 or misses a real backlog of 1001.
    const h = harness({
      depths: {
        mail: { waiting: 999, active: 1, failed: 0, delayed: 0 },
      },
    });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'up' });
  });
});

describe('a backlog that cannot be read', () => {
  it('is degraded, not up', async () => {
    // The dangerous answer is `up`. Zero waiting jobs because the store is
    // unreachable is indistinguishable from a healthy idle system, and it is the
    // exact moment an operator most wants to be told.
    const h = harness({ depths: { mail: null } });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'degraded' });
  });

  it('says the backlog is unknown rather than reporting a zero', async () => {
    const h = harness({ depths: { mail: null } });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({
      reasons: expect.arrayContaining([
        expect.stringContaining('could not be read'),
      ]),
    });
    expect(result.queue).not.toMatchObject({ backlog: 0, status: 'up' });
  });
});

describe('redis', () => {
  it('makes the queue degraded when bullmq cannot reach it', async () => {
    const h = harness({ reachable: false });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({
      status: 'degraded',
      reachable: false,
    });
  });

  it('does not hold it against the in-process dispatcher, which needs no redis', async () => {
    // A redis outage there costs the throttle counters and the session-revocation
    // record and nothing else. Reporting the queue unreachable would page somebody
    // about a queue that is working.
    const h = harness({ reachable: false, driver: 'in-process' });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'up', reachable: true });
  });
});

describe('the dead-letter list', () => {
  it('degrades the queue when anything has exhausted its retries', async () => {
    const h = harness({ deadLettered: 1 });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ status: 'degraded' });
  });

  it('counts the entry, because one is one', async () => {
    const h = harness({ deadLettered: 1 });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ deadLettered: 1 });
  });

  it('does not report a queue full of failures as full of undelivered mail', async () => {
    // Two different incidents. An alert that cannot tell them apart pages somebody
    // for the wrong one.
    const h = harness({ deadLettered: 7 });

    const result = await h.indicator.isHealthy();

    expect(result.queue).toMatchObject({ backlog: 0, deadLettered: 7 });
  });
});

describe('what it reads', () => {
  it('asks about every queue the application defines', async () => {
    // Missing one would report a healthy system while mail sat in a queue nobody
    // looked at.
    const h = harness();

    await h.indicator.isHealthy();

    expect(h.depth.mock.calls.map(([queue]) => queue).sort()).toEqual(
      Object.values(QUEUE_NAMES).sort(),
    );
  });

  it('keeps reading after one queue fails, rather than reporting the rest as fine', async () => {
    // `Promise.all` here would reject on the first unreadable queue and lose the
    // answers for the ones that did respond, which is exactly when the operator
    // needs to know which queues are affected.
    const h = harness({ depths: { mail: null } });

    await h.indicator.isHealthy();

    expect(h.depth).toHaveBeenCalledTimes(Object.values(QUEUE_NAMES).length);
  });
});
