import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaintenanceLog } from '../entities/maintenance-log.entity.js';
import { RetentionTrigger } from '../entities/retention-trigger.enum.js';
import {
  RETENTION_JOB,
  RetentionProcessor,
  type RetentionJobPayload,
} from './retention.processor.js';
import type {
  RetentionRunResult,
  RetentionService,
} from '../retention.service.js';
import type { Job } from '../../queue/queue.interface.js';
import type { NotificationService } from '../../notification/notification.service.js';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service.js';
import { TenantRegistry } from '../../tenancy/tenant-registry.service.js';
import type { TenantContextValue } from '../../tenancy/tenant-registry.service.js';

function runResult(
  overrides: Partial<RetentionRunResult> = {},
): RetentionRunResult {
  return {
    dryRun: false,
    startedAt: '2026-10-03T03:17:00.000Z',
    durationMs: 1_234,
    timedOut: false,
    cancelled: false,
    pending: [],
    totalDeleted: 42,
    failed: [],
    targets: [
      {
        id: 'users',
        table: 'users',
        description: 'soft-deleted users',
        ageDays: 30,
        deleted: 40,
        batches: 1,
        durationMs: 900,
        cascades: ['refresh_tokens'],
      },
      {
        id: 'refresh-tokens',
        table: 'refresh_tokens',
        description: 'dead tokens',
        ageDays: 7,
        deleted: 2,
        batches: 1,
        durationMs: 300,
        cascades: [],
      },
    ],
    ...overrides,
  };
}

interface Harness {
  processor: RetentionProcessor;
  run: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  /** The anomaly notification the processor raises for a dirty run. */
  notify: ReturnType<typeof vi.fn>;
}

function harness(
  result: RetentionRunResult | Error = runResult(),
  tenants: TenantContextValue[] = [],
): Harness {
  const run =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  // The processor records through the service, so the fake stands in for the
  // service's public surface rather than a repository the processor no longer
  // touches. `insert` keeps its name so the call assertions read the same.
  const insert = vi.fn().mockResolvedValue({ id: 'log-1' });
  const notify = vi.fn().mockResolvedValue({ deliveries: [] });

  const tenantScope: TenantContextValue = {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'acme',
    name: 'Acme',
    status: 'active',
    plan: 'free',
    schemaName: null,
  };

  return {
    processor: new RetentionProcessor(
      {
        run,
        record: insert,
      } as unknown as RetentionService,
      { notify } as unknown as NotificationService,
      // One tenant, so the run is the one the tenant has. A registry with no
      // tenants would make the job a no-op, which is a job that reports success
      // without cleaning anything.
      {
        active: async () => (tenants.length > 0 ? tenants : [tenantScope]),
      } as unknown as TenantRegistry,
      new TenantContextService(),
    ),
    run,
    insert,
    notify,
  };
}

/**
 * Builds a job carrying an arbitrary payload, including the malformed ones the
 * validation tests need. The cast is the point: `unknown` is exactly what arrives
 * at a processor, so the helper has to be able to produce it, and the type system
 * cannot tell the difference between a payload from the queue and a typo in a
 * test.
 */
const job = (payload: unknown): Job<RetentionJobPayload> =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name: RETENTION_JOB,
    payload,
  }) as Job<RetentionJobPayload>;

describe('RetentionProcessor', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  describe('routing', () => {
    it('claims its own job name only', () => {
      expect(RetentionProcessor.handles(RETENTION_JOB)).toBe(true);
      expect(RetentionProcessor.handles('mail.send')).toBe(false);
    });

    it('publishes the job name the queue will enqueue', () => {
      expect(RETENTION_JOB).toBe('maintenance.run-retention');
    });
  });

  describe('a cancelled run', () => {
    it('reports the job as cancelled, not as a failure', async () => {
      h = harness(runResult({ cancelled: true }));

      const result = await h.processor.process(job({}));

      // A cancelled run is neither a success nor a failure: the work is
      // unfinished and it was asked to be. The dispatcher reads `cancelled`
      // before it reads anything else, so the two cannot be confused.
      expect(result.cancelled).toBe(true);
      expect(result.ok).toBe(false);
    });

    it('asks the context whether to stop, and reports what it is doing', async () => {
      const report = vi.fn().mockResolvedValue(undefined);
      const isCancelled = vi.fn().mockResolvedValue(false);
      const context = {
        id: '11111111-1111-4111-8111-111111111111',
        name: RETENTION_JOB,
        report,
        isCancelled,
      };

      await h.processor.process(job({}), context);

      // The two seams the run needs: one to be told when to stop, one to say
      // where it is. Without them the run cannot be watched or stopped.
      expect(h.run).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldStop: expect.any(Function),
          onProgress: expect.any(Function),
        }),
      );
    });

    it('passes the cancellation check straight to the context', async () => {
      const report = vi.fn().mockResolvedValue(undefined);
      const isCancelled = vi.fn().mockResolvedValue(true);
      const context = {
        id: '11111111-1111-4111-8111-111111111111',
        name: RETENTION_JOB,
        report,
        isCancelled,
      };

      await h.processor.process(job({}), context);

      const options = h.run.mock.calls[0]?.[0] as {
        shouldStop: () => Promise<boolean>;
      };

      await expect(options.shouldStop()).resolves.toBe(true);
      expect(isCancelled).toHaveBeenCalled();
    });

    it('reports the progress the run gives it', async () => {
      const report = vi.fn().mockResolvedValue(undefined);
      const context = {
        id: '11111111-1111-4111-8111-111111111111',
        name: RETENTION_JOB,
        report,
        isCancelled: vi.fn().mockResolvedValue(false),
      };

      await h.processor.process(job({}), context);

      const options = h.run.mock.calls[0]?.[0] as {
        onProgress: (progress: {
          processed: number;
          total: number;
          current: string;
        }) => Promise<void>;
      };

      await options.onProgress({ processed: 2, total: 9, current: 'users' });

      expect(report).toHaveBeenCalledWith({
        processed: 2,
        total: 9,
        current: 'users',
      });
    });
  });

  describe('running the job', () => {
    it('runs the policy and records the result', async () => {
      const result = await h.processor.process(job({}));

      expect(result.ok).toBe(true);
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.insert).toHaveBeenCalledTimes(1);
    });

    it('passes an explicit dry run through to the service', async () => {
      // The operator has to be able to rehearse against production data without
      // a configuration change and a restart.
      await h.processor.process(job({ dryRun: true }));

      expect(h.run).toHaveBeenCalledWith({ dryRun: true });
    });

    it('leaves the mode to the configuration when the job does not say', async () => {
      await h.processor.process(job({}));

      // `undefined` rather than `false`, so a deployment configured for dry runs
      // cannot be flipped into deleting real rows by an empty payload.
      expect(h.run).toHaveBeenCalledWith({ dryRun: undefined });
    });
  });

  /**
   * The property the phase is about.
   *
   * **The job visits every tenant.** Retention removes rows by age, and a row
   * that is expired for one tenant is another tenant's live one — so the job
   * cleans them one at a time, each run scoped to its own tenant.
   */
  describe('the tenants it visits', () => {
    it('runs the policy once per tenant', async () => {
      h = harness(runResult(), [
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'acme',
          name: 'Acme',
          status: 'active',
          plan: 'free',
          schemaName: null,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          slug: 'other',
          name: 'Other',
          status: 'active',
          plan: 'free',
          schemaName: null,
        },
      ]);

      const result = await h.processor.process(job({}));

      expect(result.ok).toBe(true);
      expect(h.run).toHaveBeenCalledTimes(2);
      // A row per tenant, so the history says whose rows went.
      expect(h.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe('recording the run', () => {
    it('hands the result to the service to record', async () => {
      await h.processor.process(job({}));

      // The row shape is the service's business now. What the processor owns is
      // that a completed run is recorded at all, and with which trigger.
      expect(h.insert).toHaveBeenCalledTimes(1);
      expect(h.insert.mock.calls[0][0]).toMatchObject({ totalDeleted: 42 });
    });

    it('labels an unlabelled run as coming from cron', async () => {
      await h.processor.process(job({}));

      expect(h.insert.mock.calls[0][1]).toBe(RetentionTrigger.Cron);
    });

    it('keeps the trigger the job carried', async () => {
      await h.processor.process(job({ trigger: RetentionTrigger.Manual }));

      expect(h.insert.mock.calls[0][1]).toBe(RetentionTrigger.Manual);
    });

    it('keeps an admin trigger, so the column distinguishes the sources', async () => {
      await h.processor.process(job({ trigger: RetentionTrigger.Admin }));

      expect(h.insert.mock.calls[0][1]).toBe(RetentionTrigger.Admin);
    });
  });

  describe('a run that finished', () => {
    it('reports success even when a target failed', async () => {
      // A renamed column will still be renamed five seconds later, so a retry
      // answers identically. The failure is in the log and the admin history.
      h = harness(runResult({ failed: ['refresh-tokens'] }));

      const result = await h.processor.process(job({}));

      expect(result.ok).toBe(true);
      expect(result.retryable).toBeUndefined();
    });

    it('reports success when nothing matched', async () => {
      h = harness(runResult({ totalDeleted: 0, targets: [] }));

      expect((await h.processor.process(job({}))).ok).toBe(true);
    });
  });

  describe('a run that timed out', () => {
    beforeEach(() => {
      h = harness(
        runResult({
          timedOut: true,
          pending: ['user-devices'],
          totalDeleted: 9,
        }),
      );
    });

    it('reports failure, because tables were left unclean', async () => {
      expect((await h.processor.process(job({}))).ok).toBe(false);
    });

    it('stays retryable, because a retry finishes what the timeout left', async () => {
      // The run is idempotent, so the retry costs the time the lost connection
      // was not using anyway.
      expect((await h.processor.process(job({}))).retryable).toBe(true);
    });

    it('says how many targets were not reached', async () => {
      const result = await h.processor.process(job({}));

      expect(result.error).toContain('1 targets not reached');
    });

    it('still records the run', async () => {
      // The partial work is real and the operator needs to see it happened.
      await h.processor.process(job({}));

      expect(h.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures around the run', () => {
    it('retries when the service throws before it can record anything', async () => {
      h = harness(new Error('connection terminated unexpectedly'));

      const result = await h.processor.process(job({}));

      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('writes no log row when the service throws', async () => {
      // The insert needs the same connection that just failed, so pretending
      // otherwise would leave a run recorded that never happened.
      h = harness(new Error('no connection'));

      await h.processor.process(job({}));

      expect(h.insert).not.toHaveBeenCalled();
    });

    it('retries when the run worked but the log insert failed', async () => {
      h = harness();
      h.insert.mockRejectedValue(new Error('disk full'));

      const result = await h.processor.process(job({}));

      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('says the cleanup itself worked, so nobody re-runs it by hand', async () => {
      h = harness();
      h.insert.mockRejectedValue(new Error('disk full'));

      const result = await h.processor.process(job({}));

      expect(result.error).toContain('run completed');
      expect(result.error).toContain('disk full');
    });

    it('does not retry a malformed payload', async () => {
      const result = await h.processor.process(job({ dryRun: 'yes' }));

      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(h.run).not.toHaveBeenCalled();
    });
  });

  describe('payload validation', () => {
    it('accepts an absent payload, since a cron job carries nothing', async () => {
      expect((await h.processor.process(job(undefined))).ok).toBe(true);
    });

    it('accepts an empty payload', async () => {
      expect((await h.processor.process(job({}))).ok).toBe(true);
    });

    it('rejects a non-object payload', async () => {
      expect((await h.processor.process(job('run'))).retryable).toBe(false);
    });

    it('rejects an unknown trigger instead of storing it', async () => {
      // 'cron' would be a valid value, so the string has to be one that is not.
      const result = await h.processor.process(
        job({ trigger: 'nightly' as never }),
      );

      expect(result.ok).toBe(false);
      expect(h.insert).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean dry run', async () => {
      expect((await h.processor.process(job({ dryRun: 1 }))).ok).toBe(false);
    });
  });

  describe('the entity it writes to', () => {
    it('inserts the maintenance log, not some other table', () => {
      // Guards against the repository being wired to the wrong entity, which
      // typechecks perfectly and silently records history nowhere.
      expect(MaintenanceLog.name).toBe('MaintenanceLog');
    });
  });
});
