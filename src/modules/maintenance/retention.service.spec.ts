import type { DataSource, Repository } from 'typeorm';

import { MaintenanceLog } from './entities/maintenance-log.entity.js';
import { RetentionTrigger } from './entities/retention-trigger.enum.js';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AGES,
  type RetentionAges,
} from '../../configs/retention.config.js';
import {
  countAffectedRows,
  RetentionService,
  type RetentionRunResult,
} from './retention.service.js';
import { RETENTION_TARGETS } from './retention.policy.js';

/**
 * The shape a TypeORM query runner returns for `DELETE ... RETURNING`, which is
 * `[entities, affected]` rather than the deleted rows.
 *
 * A fake that handed back an array of row objects passed every counting test
 * while the real runner reports two rows for a one-row delete. Anything that
 * stands in for a database here has to reproduce that.
 */
const deleted = (affected: number): [unknown[], number] => [[], affected];

/** Records every statement and transaction boundary the service drives. */
class FakeQueryRunner {
  readonly queries: string[] = [];
  readonly parameters: unknown[][] = [];
  started = 0;
  committed = 0;
  rolledBack = 0;
  released = 0;
  connected = 0;

  constructor(
    private readonly respond: (sql: string) => unknown[] = () => [],
  ) {}

  async connect(): Promise<void> {
    this.connected += 1;
  }

  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    this.queries.push(sql);
    this.parameters.push(params ?? []);

    return this.respond(sql);
  }

  async startTransaction(): Promise<void> {
    this.started += 1;
  }

  async commitTransaction(): Promise<void> {
    this.committed += 1;
  }

  async rollbackTransaction(): Promise<void> {
    this.rolledBack += 1;
  }

  async release(): Promise<void> {
    this.released += 1;
  }

  /** Statements that delete, as opposed to count. */
  deletes(): string[] {
    return this.queries.filter((sql) => sql.startsWith('DELETE'));
  }

  counts(): string[] {
    return this.queries.filter((sql) => sql.startsWith('SELECT count'));
  }
}

interface Harness {
  service: RetentionService;
  runner: FakeQueryRunner;
  sleep: ReturnType<typeof vi.fn>;
  /** The repository fake, exposed so the recorded row can be inspected. */
  logs: {
    create: (entry: unknown) => unknown;
    save: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  /** Default run options, so a test can override only what it cares about. */
  run: RetentionService['run'];
}

function harness(options: {
  respond?: (sql: string) => unknown[];
  ages?: Partial<RetentionAges>;
  batchSize?: number;
  batchDelay?: number;
  dryRun?: boolean;
  now?: () => number;
  runTimeout?: number;
}): Harness {
  const runner = new FakeQueryRunner(options.respond ?? (() => []));
  const sleep = vi.fn().mockResolvedValue(undefined);
  const dataSource = {
    createQueryRunner: () => runner,
  } as unknown as DataSource;
  const logs = {
    create: (entry: unknown) => entry,
    save: vi.fn().mockImplementation(async (entry: unknown) => entry),
    find: vi.fn().mockResolvedValue([]),
  };

  const service = new RetentionService(
    dataSource,
    {
      enabled: true,
      dryRun: options.dryRun ?? false,
      schedule: '17 3 * * *',
      batchSize: options.batchSize ?? 5_000,
      batchDelay: options.batchDelay ?? 100,
      runTimeout: options.runTimeout ?? 3_600_000,
      ages: { ...DEFAULT_AGES, ...options.ages },
    },
    logs as unknown as Repository<MaintenanceLog>,
  );

  return {
    service,
    runner,
    sleep,
    logs,
    run: (overrides = {}) =>
      service.run({ now: options.now, sleep, ...overrides }),
  };
}

/**
 * A clock that jumps far enough forward to cross a run timeout. Real time cannot
 * be used for this: a run that must be cut short would otherwise wait out the
 * real timeout, which is an hour.
 */
function advancingClock(stepMs: number): () => number {
  let tick = 0;

  return () => {
    tick += stepMs;

    return tick;
  };
}

/**
 * How many targets the policy has.
 *
 * Derived rather than written down, because a new target is exactly the change that
 * should not require editing a dozen assertions in a service spec. When Phase 18
 * added `notification-logs` this was a literal 5 and every count in this file was
 * silently wrong until the tests were run — which is the failure mode a derived
 * number removes.
 */
const POLICY_LENGTH = RETENTION_TARGETS.length;

function entry(): MaintenanceLog {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    startedAt: new Date('2026-10-03T03:17:00.000Z'),
    finishedAt: new Date('2026-10-03T03:17:01.234Z'),
    durationMs: 1_234,
    dryRun: true,
    totalDeleted: 0,
    timedOut: false,
    trigger: RetentionTrigger.Cron,
    pending: [],
    failedTargets: [],
    targets: [],
    createdAt: new Date('2026-10-03T03:17:01.234Z'),
  } as MaintenanceLog;
}

describe('RetentionService', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness({});
  });

  describe('a run that finds nothing', () => {
    it('reports zero for every target', async () => {
      const result = await h.run();

      expect(result.targets).toHaveLength(POLICY_LENGTH);
      expect(result.totalDeleted).toBe(0);
    });

    it('issues exactly one statement per target', async () => {
      // No rows matched, so every target's first batch came back short and the
      // loop ended. A second statement would mean the short-batch check is wrong
      // and every empty table costs two queries.
      await h.run();

      expect(h.runner.deletes()).toHaveLength(POLICY_LENGTH);
    });

    it('wraps each batch in its own transaction', async () => {
      await h.run();

      expect(h.runner.started).toBe(POLICY_LENGTH);
      expect(h.runner.committed).toBe(POLICY_LENGTH);
    });

    it('releases the runner even when the run throws', async () => {
      const broken = harness({
        respond: () => {
          throw new Error('connection lost');
        },
      });

      await broken.service.run();

      // The runner holds a pool connection. Leaking one per failed run would
      // exhaust the pool after a handful of bad nights.
      expect(broken.runner.released).toBe(1);
    });
  });

  describe('countAffectedRows', () => {
    it('reads the affected count, not the tuple length', () => {
      // Verified against Postgres: deleting one row, two rows and nothing all
      // return an array of length 2. The length is not a count of anything.
      expect(countAffectedRows([[], 1])).toBe(1);
      expect(countAffectedRows([[], 2])).toBe(2);
      expect(countAffectedRows([[], 0])).toBe(0);
    });

    it('reports zero rather than a length for a delete that matched nothing', () => {
      expect(countAffectedRows([[], 0])).not.toBe(2);
    });

    it('falls back to the array length when there is no affected element', () => {
      expect(countAffectedRows([{ id: 1 }, { id: 2 }])).toBe(2);
    });

    it('reports zero for something that is not an array at all', () => {
      expect(countAffectedRows(undefined)).toBe(0);
      expect(countAffectedRows(null)).toBe(0);
    });
  });

  describe('counting deleted rows', () => {
    it('does not treat the tuple length as the deleted count', async () => {
      // The bug this exists for. With batch size 2 the fake reports a length of 2
      // for every delete, so a length-based loop sees a full batch forever and
      // deletes until the run timeout, while reporting a count that matches no
      // rows. Reading the affected element makes the first batch look short.
      h = harness({
        batchSize: 2,
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(1) : []),
      });

      const result = await h.run();

      expect(result.totalDeleted).toBe(POLICY_LENGTH);
      expect(result.timedOut).toBe(false);
      expect(h.runner.deletes()).toHaveLength(POLICY_LENGTH);
    });

    it('finishes one batch per target when nothing matches', async () => {
      h = harness({
        batchSize: 5_000,
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(0) : []),
      });

      const result = await h.run();

      expect(result.totalDeleted).toBe(0);
      expect(h.runner.deletes()).toHaveLength(POLICY_LENGTH);
    });

    it('uses RETURNING so the database returns the row count', async () => {
      await h.run();

      for (const sql of h.runner.deletes()) {
        expect(sql).toContain('RETURNING 1');
      }
    });

    it('sums the rows across batches and targets', async () => {
      const sizes = [2, 1, 3, 1, 1, 1];
      let call = 0;
      h = harness({
        batchSize: 2,
        respond: (sql) => {
          if (!sql.startsWith('DELETE')) {
            return [];
          }

          const size = sizes[call] ?? 0;
          call += 1;

          return deleted(size);
        },
      });

      const result = await h.run();

      expect(result.totalDeleted).toBe(sizes.reduce((a, b) => a + b, 0));
    });
  });

  describe('batching', () => {
    it('stops on a short batch, since nothing can still match', async () => {
      h = harness({
        batchSize: 10,
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(1) : []),
      });

      await h.run();

      // One row against a batch size of ten: the target is empty now.
      expect(h.runner.deletes()).toHaveLength(POLICY_LENGTH);
    });

    it('keeps going while batches come back full', async () => {
      // A full batch means there may be more rows, so the loop must not stop on
      // its own. It runs until the timeout cuts it short, which is why the clock
      // advances fast rather than waiting an hour for real.
      h = harness({
        batchSize: 2,
        runTimeout: 400,
        now: advancingClock(20),
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(2) : []),
      });

      const result = await h.run();

      expect(h.runner.deletes().length).toBeGreaterThan(POLICY_LENGTH);
      expect(result.timedOut).toBe(true);
    });

    it('sleeps between batches but not after the last one', async () => {
      h = harness({
        batchSize: 3,
        respond: (sql) => {
          if (!sql.startsWith('DELETE')) {
            return [];
          }

          return h.runner.deletes().length === 1 ? deleted(3) : deleted(1);
        },
      });

      await h.run();

      // Two batches on the first target, and one sleep between them. A final
      // sleep would add dead time once per target on every single run.
      expect(h.sleep).toHaveBeenCalledTimes(1);
      expect(h.sleep).toHaveBeenCalledWith(100);
    });

    it('never deletes more than the batch size in one statement', async () => {
      h = harness({ batchSize: 250 });

      await h.run();

      for (const params of h.runner.parameters) {
        if (params.length > 0) {
          expect(params[0]).toBe(250);
        }
      }
    });
  });

  describe('dry run', () => {
    it('counts and deletes nothing', async () => {
      h = harness({ dryRun: true, respond: () => [{ n: 12 }] });

      const result = await h.run();

      expect(h.runner.deletes()).toEqual([]);
      expect(result.totalDeleted).toBe(12 * POLICY_LENGTH);
      expect(result.dryRun).toBe(true);
    });

    it('opens no transaction, because nothing is written', async () => {
      h = harness({ dryRun: true });

      await h.run();

      expect(h.runner.started).toBe(0);
    });

    it('can be forced on from the caller even when the config is off', async () => {
      h = harness({ dryRun: false, respond: () => [{ n: 7 }] });

      const result = await h.service.run({ dryRun: true });

      expect(h.runner.deletes()).toEqual([]);
      expect(result.dryRun).toBe(true);
    });

    it('reports zero batches, since it never issues a delete', async () => {
      h = harness({ dryRun: true, respond: () => [{ n: 3 }] });

      const result = await h.run();

      for (const target of result.targets) {
        expect(target.batches).toBe(0);
      }
    });
  });

  describe('a target that fails', () => {
    // Anchored on the DELETE target, not on the string. The device rule names
    // "refresh_tokens" inside a subquery, so a loose includes() would fail two
    // tables and hide the one under test.
    const failingTable = (sql: string): boolean =>
      sql.startsWith('DELETE FROM "refresh_tokens"');

    it('does not stop the targets after it', async () => {
      // The whole point: one renamed column should cost one skipped table.
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('column "revokedAt" does not exist');
          }

          return sql.startsWith('DELETE') ? [] : [];
        },
      });

      const result = await h.run();

      expect(result.failed).toEqual(['refresh-tokens']);
      expect(result.targets).toHaveLength(POLICY_LENGTH);
    });

    it('records the database message on the target', async () => {
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('column "revokedAt" does not exist');
          }

          return [];
        },
      });

      const result = await h.run();

      expect(
        result.targets.find((t) => t.id === 'refresh-tokens')?.error,
      ).toContain('does not exist');
    });

    it('reports zero deleted for a target that failed', async () => {
      // Otherwise a partial batch would be invisible: rows were removed, then the
      // table failed, and the log would claim nothing was touched.
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('boom');
          }

          return [];
        },
      });

      const result = await h.run();

      expect(
        result.targets.find((t) => t.id === 'refresh-tokens')?.deleted,
      ).toBe(0);
    });

    it('rolls the failed batch back so the next target is not blocked', async () => {
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('boom');
          }

          return [];
        },
      });

      await h.run();

      // Without the rollback the runner stays inside an aborted transaction and
      // every later statement fails with "current transaction is aborted".
      expect(h.runner.rolledBack).toBe(1);
      expect(h.runner.committed).toBe(POLICY_LENGTH - 1);
    });

    it('keeps the original error when the rollback itself fails', async () => {
      // A lost connection breaks both the delete and the rollback. Whichever
      // error surfaces decides what the operator reads at 3am.
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('connection terminated unexpectedly');
          }

          return [];
        },
      });
      h.runner.rollbackTransaction = vi
        .fn()
        .mockRejectedValue(new Error('socket hang up'));

      const result = await h.run();

      expect(
        result.targets.find((t) => t.id === 'refresh-tokens')?.error,
      ).toContain('connection terminated');
    });

    it('commits no transaction for the batch that failed', async () => {
      h = harness({
        respond: (sql) => {
          if (sql.startsWith('DELETE') && failingTable(sql)) {
            throw new Error('boom');
          }

          return [];
        },
      });

      await h.run();

      expect(h.runner.started).toBe(h.runner.committed + h.runner.rolledBack);
    });
  });

  describe('the run timeout', () => {
    it('stops the run instead of finishing the batch in progress', async () => {
      // A timeout here is almost always a lost connection. Completing the batch
      // would be another round trip against a connection that is already gone.
      h = harness({
        batchSize: 1,
        runTimeout: 400,
        now: advancingClock(20),
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(1) : []),
      });

      const result = await h.run();

      expect(result.timedOut).toBe(true);
    });

    it('keeps the rows it already deleted in the reported count', async () => {
      // Stopping early must not throw away the progress it made. A target that
      // deleted two batches before the cut-off reports both.
      h = harness({
        batchSize: 1,
        runTimeout: 400,
        now: advancingClock(20),
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(1) : []),
      });

      const result = await h.run();

      expect(result.totalDeleted).toBeGreaterThan(0);
    });

    it('names the targets it never reached', async () => {
      h = harness({ runTimeout: 0 });

      const result = await h.run();

      expect(result.targets).toHaveLength(0);
      expect(result.pending).toHaveLength(POLICY_LENGTH);
    });

    it('issues no statements at all when the deadline has already passed', async () => {
      // Better to do nothing this night than to start deleting without time left
      // to finish and to report what happened.
      h = harness({ runTimeout: 0 });

      await h.run();

      expect(h.runner.deletes()).toEqual([]);
    });

    it('does not claim success when it stopped early', async () => {
      // Full batches, so the loop is still going when the deadline arrives.
      // With empty batches every target would finish on its own and the run
      // would legitimately report no timeout.
      h = harness({
        batchSize: 1,
        runTimeout: 400,
        now: advancingClock(20),
        respond: (sql) => (sql.startsWith('DELETE') ? deleted(1) : []),
      });

      const result = await h.run();

      expect(result.timedOut).toBe(true);
      expect(result.failed).toEqual([]);
    });
  });

  describe('the run summary', () => {
    it('carries the age each target used, so a surprising number can be explained', async () => {
      h = harness({ ages: { softDeletedUsers: 45 } });

      const result = await h.run();

      expect(result.targets.find((t) => t.id === 'users')?.ageDays).toBe(45);
    });

    it('records when the run started', async () => {
      const result = await h.service.run({ now: () => 1_700_000_000_000 });

      expect(result.startedAt).toBe('2023-11-14T22:13:20.000Z');
    });

    it('lists the tables a user delete emptied', async () => {
      const result = await h.run();

      expect(result.targets.find((t) => t.id === 'users')?.cascades).toContain(
        'refresh_tokens',
      );
    });

    it('reports how long the run took', async () => {
      let clock = 0;
      const result = await h.service.run({
        now: () => {
          clock += 5;

          return clock;
        },
      });

      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  describe('record', () => {
    const finished = {
      dryRun: false,
      startedAt: '2026-10-03T03:17:00.000Z',
      durationMs: 1_234,
      timedOut: false,
      pending: ['user-devices'],
      totalDeleted: 42,
      failed: ['refresh-tokens'],
      targets: [],
    };

    it('writes the row a run produced', async () => {
      await h.service.record(finished, RetentionTrigger.Admin);

      expect(h.logs.save).toHaveBeenCalledTimes(1);
    });

    it('derives finishedAt from startedAt plus the duration', async () => {
      await h.service.record(finished, RetentionTrigger.Admin);

      const row = h.logs.save.mock.calls[0][0] as { finishedAt: Date };

      // Asserted because a wrong end time makes the history read as if every run
      // finished before it started, and nothing else in the row would show it.
      expect(row.finishedAt.toISOString()).toBe('2026-10-03T03:17:01.234Z');
    });

    it('keeps the trigger that asked for the run', async () => {
      await h.service.record(finished, RetentionTrigger.Admin);

      const row = h.logs.save.mock.calls[0][0] as { trigger: string };

      expect(row.trigger).toBe('admin');
    });

    it('copies the two lists rather than aliasing the result', async () => {
      await h.service.record(finished, RetentionTrigger.Cron);

      const row = h.logs.save.mock.calls[0][0] as {
        pending: string[];
        failedTargets: string[];
      };

      // Aliasing would let a later mutation of the run result rewrite a row that
      // is supposed to be an immutable record.
      expect(row.pending).not.toBe(finished.pending);
      expect(row.failedTargets).not.toBe(finished.failed);
      expect(row.pending).toEqual(['user-devices']);
    });

    it('lets an insert failure surface to the caller', async () => {
      h.logs.save.mockRejectedValue(new Error('disk full'));

      // Swallowing here would make a completed cleanup indistinguishable from an
      // unrecorded one, and only one of them can be retried.
      await expect(
        h.service.record(finished, RetentionTrigger.Cron),
      ).rejects.toThrow('disk full');
    });
  });

  describe('latest', () => {
    it('uses a limited find, not findOne', async () => {
      // findOne with an order and no where throws "You must provide selection
      // conditions in order to find a single row" the first time it meets a
      // non-empty table. A repository mock never surfaced that, so the shape of
      // the call is pinned here instead.
      h.logs.find = vi.fn().mockResolvedValue([entry()]) as never;

      await h.service.latest();

      expect(h.logs.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('asks for the newest first', async () => {
      h.logs.find = vi.fn().mockResolvedValue([]) as never;

      await h.service.latest();

      expect(h.logs.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { startedAt: 'DESC' } }),
      );
    });

    it('returns null on an empty history rather than throwing', async () => {
      h.logs.find = vi.fn().mockResolvedValue([]) as never;

      expect(await h.service.latest()).toBeNull();
    });

    it('returns the row when there is one', async () => {
      h.logs.find = vi.fn().mockResolvedValue([entry()]) as never;

      expect(await h.service.latest()).toEqual(entry());
    });
  });

  describe('identifier safety', () => {
    it('quotes every table it interpolates', async () => {
      await h.run();

      for (const sql of h.runner.queries) {
        expect(sql).toMatch(/(FROM|DELETE FROM) "\w+"/);
      }
    });

    it('passes the cutoff as a literal it built, never as user input', async () => {
      // Ages come from the environment and reach the predicate as an ISO string.
      // They are not bound parameters because they sit inside a comparison the
      // driver cannot parameterise; keeping them ISO-formatted is what makes
      // that safe.
      await h.run();

      for (const sql of h.runner.deletes()) {
        expect(sql).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
      }
    });
  });
});

export type { RetentionRunResult };
