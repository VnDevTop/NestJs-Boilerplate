import { describe, expect, it, vi } from 'vitest';

import { runWithRequestId } from '../../common/utils/index.js';
import { NotificationEventsService } from './notification-events.service.js';
import type { JobQueue } from '../queue/queue.interface.js';

/**
 * The request id has to survive the queue boundary, and that is the whole problem.
 *
 * A notification is emitted in a request and delivered in a worker, possibly much
 * later if the queue is backed up. By the time the `notification_logs` row is
 * written, the async context that held the id is long gone — so it has to travel
 * *in the payload*, and the only place it can be added is at the enqueue.
 *
 * Reading it at delivery time instead would write `null` on every row, silently,
 * which is the worst possible shape for a correlation column: it looks implemented.
 */
function harness() {
  const enqueued: { queue: string; job: { payload: unknown } }[] = [];

  const queue = {
    driver: 'in-process' as const,
    enqueue: vi.fn(async (queueName: string, job: { payload: unknown }) => {
      enqueued.push({ queue: queueName, job });

      return undefined;
    }),
  } as unknown as JobQueue;

  const service = new NotificationEventsService(queue);

  return { service, enqueued, queue };
}

describe('an event raised inside a request', () => {
  it('carries the request id into the job payload', async () => {
    const h = harness();

    await runWithRequestId('req-42', async () => {
      await h.service.notifyUser(
        'user.registered',
        { email: 'a@x.com', firstName: 'Ada' },
        'u1',
      );
    });

    expect(h.enqueued[0]?.job.payload).toMatchObject({ requestId: 'req-42' });
  });

  it('carries it on the plain notify path too', async () => {
    // Both entry points, because they are separate code paths and the second is the
    // one most events take.
    const h = harness();

    await runWithRequestId('req-43', async () => {
      await h.service.notify('auth.account.locked', {
        email: 'a@x.com',
        reason: 'because',
      });
    });

    expect(h.enqueued[0]?.job.payload).toMatchObject({ requestId: 'req-43' });
  });

  it('leaves it out entirely when no request made it', async () => {
    // A system action — the retention anomaly — has no request, and a row with
    // `requestId: undefined` is not the same as a row that says "no request".
    const h = harness();

    await h.service.notify('maintenance.retention.anomaly', {
      reason: 'x',
      pending: [],
      failed: [],
      durationMs: 1,
    });

    expect(h.enqueued[0]?.job.payload).toMatchObject({
      requestId: undefined,
    });
  });
});

describe('when the enqueue fails', () => {
  it('still resolves, because a notification is never worth failing the request over', async () => {
    // A registration returning its token whether or not redis is reachable is the
    // property that lets the request path stay fast. A rejected promise here would
    // become an unhandled rejection in whichever caller forgot a `.catch`.
    const h = harness();

    (h.queue.enqueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('redis is unreachable'),
    );

    await expect(
      h.service.notify('user.registered', {
        email: 'a@x.com',
        firstName: 'Ada',
      }),
    ).resolves.toMatchObject({ queued: false });
  });
});
