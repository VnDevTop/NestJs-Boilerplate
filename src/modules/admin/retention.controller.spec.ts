import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaintenanceLog } from '../maintenance/entities/maintenance-log.entity.js';
import { RetentionTrigger } from '../maintenance/entities/retention-trigger.enum.js';
import type {
  RetentionRunResult,
  RetentionService,
} from '../maintenance/retention.service.js';
import { RETENTION_JOB } from '../maintenance/processors/retention.processor.js';
import { QUEUE_NAMES, type JobQueue } from '../queue/queue.interface.js';
import { AdminRetentionController } from './retention.controller.js';
import {
  CursorPaginationQueryDto,
  PaginatedResultDto,
  encodeCursor,
} from '../../common/pagination/index.js';

const RUN: RetentionRunResult = {
  dryRun: true,
  startedAt: '2026-10-03T03:17:00.000Z',
  durationMs: 1_234,
  timedOut: false,
  pending: [],
  totalDeleted: 0,
  failed: [],
  targets: [],
};

function entry(overrides: Partial<MaintenanceLog> = {}): MaintenanceLog {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    startedAt: new Date('2026-10-03T03:17:00.000Z'),
    finishedAt: new Date('2026-10-03T03:17:01.234Z'),
    durationMs: 1_234,
    dryRun: true,
    totalDeleted: 0,
    timedOut: false,
    trigger: RetentionTrigger.Admin,
    pending: [],
    failedTargets: [],
    targets: [],
    createdAt: new Date('2026-10-03T03:17:01.234Z'),
    ...overrides,
  } as MaintenanceLog;
}

interface Harness {
  controller: AdminRetentionController;
  run: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  latest: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
}

function harness(
  options: { latestFound?: MaintenanceLog | null } = {},
): Harness {
  const run = vi.fn().mockResolvedValue(RUN);
  const record = vi.fn().mockImplementation(async () => entry());
  const history = vi.fn().mockResolvedValue(
    PaginatedResultDto.of([entry()], {
      limit: 20,
      hasMore: false,
      nextCursor: null,
    }),
  );
  const latest = vi.fn().mockResolvedValue(options.latestFound ?? entry());
  const enqueue = vi.fn().mockResolvedValue('job-id-1');

  const controller = new AdminRetentionController(
    { run, record, history, latest } as unknown as RetentionService,
    { driver: 'in-process', enqueue } as unknown as JobQueue,
  );

  return { controller, run, record, history, latest, enqueue };
}

describe('AdminRetentionController', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  describe('POST admin/retention/dry-run', () => {
    it('forces a dry run regardless of configuration', async () => {
      await h.controller.dryRun();

      // The route exists to rehearse. A deployment configured to delete must not
      // be able to turn an operator's rehearsal into a real deletion.
      expect(h.run).toHaveBeenCalledWith({ dryRun: true });
    });

    it('records the rehearsal, labelled as an admin run', async () => {
      await h.controller.dryRun();

      // Otherwise a rehearsal leaves no trace and cannot be told apart from one
      // that never happened.
      expect(h.record).toHaveBeenCalledWith(RUN, RetentionTrigger.Admin);
    });

    it('answers from the row it wrote, so the id is real', async () => {
      h.record.mockResolvedValue(entry({ id: 'dry-run-id' }));

      const result = await h.controller.dryRun();

      expect(result.id).toBe('dry-run-id');
    });

    it('returns the counts the operator asked for', async () => {
      h.record.mockResolvedValue(entry({ totalDeleted: 0, dryRun: true }));

      const result = await h.controller.dryRun();

      expect(result.dryRun).toBe(true);
      expect(result.totalDeleted).toBe(0);
      expect(result.durationMs).toBe(1_234);
    });

    it('surfaces a timeout in the response', async () => {
      h.record.mockResolvedValue(
        entry({ timedOut: true, pending: ['user-devices'] }),
      );

      const result = await h.controller.dryRun();

      expect(result.timedOut).toBe(true);
      expect(result.pending).toEqual(['user-devices']);
    });

    it('reports a failed target rather than hiding it', async () => {
      h.record.mockResolvedValue(entry({ failedTargets: ['refresh-tokens'] }));

      expect((await h.controller.dryRun()).failedTargets).toEqual([
        'refresh-tokens',
      ]);
    });

    it('does not queue anything, because it already ran', async () => {
      await h.controller.dryRun();

      expect(h.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('POST admin/retention/run', () => {
    it('queues the job instead of running it', async () => {
      await h.controller.run();

      // A real run deletes in batches with pauses and can take minutes, which is
      // longer than a request should stay open.
      expect(h.run).not.toHaveBeenCalled();
      expect(h.enqueue).toHaveBeenCalledTimes(1);
    });

    it('queues it on the maintenance queue under the right name', async () => {
      await h.controller.run();

      const [queue, job] = h.enqueue.mock.calls[0];

      expect(queue).toBe(QUEUE_NAMES.maintenance);
      expect(job.name).toBe(RETENTION_JOB);
    });

    it('labels the run as coming from an admin', async () => {
      await h.controller.run();

      const [, job] = h.enqueue.mock.calls[0];

      expect(job.payload.trigger).toBe(RetentionTrigger.Admin);
    });

    it('does not force dryRun, so the run really deletes', async () => {
      await h.controller.run();

      const [, job] = h.enqueue.mock.calls[0];

      // Left undefined on purpose: forcing false would override a deployment
      // deliberately configured to rehearse only.
      expect(job.payload.dryRun).toBeUndefined();
    });

    it('points at where the outcome will appear', async () => {
      const result = await h.controller.run();

      expect(result.queued).toBe(true);
      expect(result.see).toBe('/admin/retention/runs/latest');
    });

    it('hands back the id of the job, so the run can be watched', async () => {
      const result = await h.controller.run();

      // The history says what happened; the job says what is happening now, and
      // a run that takes minutes raises that question while it is still going.
      expect(result.jobId).toBe('job-id-1');
    });
  });

  describe('GET admin/retention/runs', () => {
    /**
     * The page size and the cursor are the route's whole contract now.
     *
     * Asserted on the argument rather than on the response, because clamping and
     * cursor decoding happen in the shared pagination layer — testing them here
     * again would pin this route to an implementation it no longer has.
     */
    it('hands the query DTO straight to the service', async () => {
      const query = { limit: 20 } as CursorPaginationQueryDto;

      await h.controller.history(query);

      // Passed through whole rather than unpacked and re-clamped here. The clamp
      // lives in `effectiveLimit`, so it applies whether the value came from the
      // validation pipe, from a unit test, or from another service in-process —
      // which is what makes it a rule rather than a habit on one route.
      expect(h.history).toHaveBeenCalledWith(query);
    });

    it('hands the query DTO straight to the service, cursor and all', async () => {
      const cursor = encodeCursor({
        value: '2026-10-03T03:17:01.234Z',
        id: 'row-1',
      });

      await h.controller.history({
        limit: 20,
        cursor,
      } as CursorPaginationQueryDto);

      expect(h.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, cursor }),
      );
    });

    it('hands back the meta the service decided, unchanged', async () => {
      h.history.mockResolvedValue(
        PaginatedResultDto.of([entry()], {
          limit: 20,
          hasMore: true,
          nextCursor: 'next',
        }),
      );

      const result = await h.controller.history({
        limit: 20,
      } as CursorPaginationQueryDto);

      expect(result.items).toHaveLength(1);
      expect(result.meta).toEqual({
        limit: 20,
        hasMore: true,
        nextCursor: 'next',
      });
    });

    it('handles an empty history', async () => {
      h.history.mockResolvedValue(
        PaginatedResultDto.of([], {
          limit: 20,
          hasMore: false,
          nextCursor: null,
        }),
      );

      const result = await h.controller.history({
        limit: 20,
      } as CursorPaginationQueryDto);

      expect(result.items).toEqual([]);
      expect(result.meta.hasMore).toBe(false);
    });
  });

  describe('GET admin/retention/runs/latest', () => {
    it('returns the most recent run', async () => {
      h.latest.mockResolvedValue(entry({ id: 'latest-id' }));

      expect((await h.controller.latest())?.id).toBe('latest-id');
    });

    it('returns null rather than an empty run when nothing has run', async () => {
      h.latest.mockResolvedValue(null);

      // An app that only just enabled retention has genuinely never run it, and a
      // response shaped like a run full of zeroes would read as one that found
      // nothing.
      expect(await h.controller.latest()).toBeNull();
    });

    it('formats the timestamps as ISO strings', async () => {
      const result = await h.controller.latest();

      expect(result?.startedAt).toBe('2026-10-03T03:17:00.000Z');
      expect(result?.finishedAt).toBe('2026-10-03T03:17:01.234Z');
    });

    it('copies the lists so a caller cannot mutate the stored row', async () => {
      const pending = ['a'];
      const failedTargets = ['b'];
      h.latest.mockResolvedValue(entry({ pending, failedTargets }));

      const result = await h.controller.latest();

      // Identity, not equality. Two arrays with the same contents would pass an
      // equality check while leaving the caller's push writing into history.
      expect(result?.pending).toEqual(pending);
      expect(result?.pending).not.toBe(pending);
      expect(result?.failedTargets).not.toBe(failedTargets);
    });

    it('copies the per-target cascade lists for the same reason', async () => {
      const cascades = ['refresh_tokens'];
      h.latest.mockResolvedValue(
        entry({
          targets: [
            {
              id: 'users',
              table: 'users',
              description: 'soft-deleted users',
              ageDays: 30,
              deleted: 5,
              batches: 1,
              durationMs: 10,
              cascades,
            },
          ],
        }),
      );

      const result = await h.controller.latest();

      expect(result?.targets[0]?.cascades).toEqual(cascades);
      expect(result?.targets[0]?.cascades).not.toBe(cascades);
    });
  });
});
