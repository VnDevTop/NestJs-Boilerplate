import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
// `DataSource` is a value import, not a type import. It is injected, and a
// type-only import is erased before `design:paramtypes` is emitted, so the
// parameter arrives at Nest as `Object` and the application cannot boot with
// "Nest can't resolve dependencies of the RetentionService (?, ...)". The unit
// suite builds this service by hand and never goes near the injector, so nothing
// caught it.
import { DataSource, type QueryRunner, Repository } from 'typeorm';

import { MetricsService } from '../../core/metrics/index.js';
import {
  CursorPaginationQueryDto,
  PaginatedResultDto,
} from '../../common/pagination/index.js';
import {
  buildCriteria,
  readPaginatedResult,
} from '../../common/query/index.js';
import { retentionConfig } from '../../configs/retention.config.js';
import { MaintenanceLog } from './entities/maintenance-log.entity.js';
import { RETENTION_QUERY_SPEC } from './retention-query.js';
import { RetentionTrigger } from './entities/retention-trigger.enum.js';
import {
  buildRetentionPolicy,
  resolveCutoff,
  type RetentionTarget,
} from './retention.policy.js';

/** Per-target outcome. Returned rather than logged only, so step 5 can persist it. */
export interface RetentionTargetResult {
  readonly id: string;
  readonly table: string;
  readonly description: string;
  readonly ageDays: number;
  /** Rows deleted, or rows that would be deleted on a dry run. */
  readonly deleted: number;
  readonly batches: number;
  readonly durationMs: number;
  /** Tables emptied as a side effect. Reported, never counted separately. */
  readonly cascades: readonly string[];
  /** Set when this target failed. The run continues to the next one. */
  readonly error?: string;
}

export interface RetentionRunResult {
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly durationMs: number;
  /** True when the run hit `runTimeout` and stopped early. */
  readonly timedOut: boolean;
  /**
   * True when the run stopped because somebody asked it to.
   *
   * Separate from `timedOut` because the two mean opposite things to whoever
   * reads the record: a timed-out run needs attention, and a cancelled run was
   * stopped on purpose. Both leave targets unreached, so the reason is the only
   * thing that distinguishes them.
   */
  readonly cancelled: boolean;
  /** Targets never reached because the run stopped early. */
  readonly pending: readonly string[];
  readonly totalDeleted: number;
  readonly targets: readonly RetentionTargetResult[];
  readonly failed: readonly string[];
}

/**
 * How far a run has got.
 *
 * The items are the run's targets — the tables it cleans — because that is the
 * one count it knows up front. The rows in them are not known until they are
 * counted, and counting them would mean scanning every table twice: once to
 * count and once to delete.
 */
export interface RetentionProgress {
  /** How many targets are done. */
  processed: number;
  /** How many targets there are in all. */
  total: number;
  /** The target in flight. */
  current: string;
}

export interface RetentionRunOptions {
  /** Overrides the configured mode. The admin route uses this. */
  dryRun?: boolean;
  /** Injected so a test does not wait in real time between batches. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can move past the run timeout without waiting an hour. */
  now?: () => number;
  /**
   * Asked before each batch whether the run should stop.
   *
   * Asked at a batch boundary and never inside one, because each batch is its
   * own transaction: stopping between two batches leaves the database in a
   * state somebody could have written by hand, and stopping inside one leaves a
   * half-deleted table that nobody asked for.
   */
  shouldStop?: () => Promise<boolean> | boolean;
  /** Told how far the run has got, after each target. */
  onProgress?: (progress: RetentionProgress) => void | Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * How many rows a `DELETE ... RETURNING` actually removed.
 *
 * A TypeORM query runner does not return the deleted rows. For a statement
 * carrying `RETURNING` it returns the tuple `[entities, affected]`, so the array
 * length is always 2 no matter how many rows went. Measured against Postgres:
 * one row, two rows and a no-op all came back with a length of 2, and the real
 * counts sat in the second element as 1, 2 and 0.
 *
 * Reading the length instead costs twice over, in opposite directions. With a
 * batch size equal to the tuple length the loop never ends, because a full batch
 * is never shorter than the batch size, and the run deletes until the timeout.
 * With any larger batch size the first statement comes back looking short, the
 * loop stops after one batch, and a table needing twenty batches is reported as
 * clean while it still holds nineteen of them. Both are silent: the log says the
 * run finished.
 *
 * Falls back to the array length only if the tuple is absent, which keeps the
 * helper usable against a runner that does hand back rows.
 */
export function countAffectedRows(result: unknown): number {
  if (!Array.isArray(result)) {
    return 0;
  }

  const affected = result[1];

  return typeof affected === 'number' ? affected : result.length;
}

/**
 * Runs the retention policy: deletes rows that can no longer be useful, in
 * batches, and reports what happened.
 *
 * Three decisions shape the whole class.
 *
 * A run is safe to repeat. There is no lock and no claim table, so two runs can
 * overlap and a run that dies halfway is finished by the next one. Rows are only
 * ever removed once they are already past their age, so the worst a duplicate
 * run costs is a slightly later cleanup.
 *
 * A target that fails does not stop the run. Retention is housekeeping; a single
 * renamed column should cost the operator one skipped table, not a week of
 * uncollected data across every table.
 *
 * The run stops on the first timeout rather than finishing the batch in
 * progress. A timeout here is nearly always a lost database connection rather
 * than a full disk, since rows are removed continuously, and a lost connection
 * makes the remaining batches pointless anyway.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(retentionConfig.KEY)
    private readonly config: ConfigType<typeof retentionConfig>,
    @InjectRepository(MaintenanceLog)
    private readonly logs: Repository<MaintenanceLog>,
    private readonly metrics: MetricsService,
  ) {}

  async run(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
    const dryRun = options.dryRun ?? this.config.dryRun;
    const sleep = options.sleep ?? wait;
    const now = options.now ?? Date.now;
    const shouldStop = options.shouldStop ?? (() => false);
    const onProgress = options.onProgress ?? (() => undefined);

    const startedAtMs = now();
    const deadline = startedAtMs + this.config.runTimeout;
    const policy = buildRetentionPolicy(this.config.ages);

    const targets: RetentionTargetResult[] = [];
    const pending: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let processed = 0;

    // One runner for the whole run so the connection is reused across batches.
    // Each batch still gets its own transaction, so a failure rolls back only
    // that batch and the runner is left usable for the next target.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      for (const [index, target] of policy.entries()) {
        if (now() >= deadline) {
          timedOut = true;
          pending.push(...policy.slice(index).map((entry) => entry.id));
          break;
        }

        // Asked before the target starts rather than inside it, so a cancelled
        // run never begins work it is about to abandon.
        if (await shouldStop()) {
          cancelled = true;
          pending.push(...policy.slice(index).map((entry) => entry.id));
          break;
        }

        await onProgress({
          processed,
          total: policy.length,
          current: target.id,
        });

        const outcome = await this.runTarget(runner, target, {
          dryRun,
          deadline,
          now,
          sleep,
          shouldStop,
          onProgress,
          processed,
          total: policy.length,
        });

        targets.push(outcome.result);
        processed += 1;

        if (outcome.cancelled) {
          cancelled = true;
          pending.push(...policy.slice(index + 1).map((entry) => entry.id));
          break;
        }

        if (outcome.timedOut) {
          timedOut = true;
          pending.push(...policy.slice(index + 1).map((entry) => entry.id));
          break;
        }
      }
    } finally {
      await runner.release();
    }

    const result: RetentionRunResult = {
      dryRun,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: now() - startedAtMs,
      timedOut,
      cancelled,
      pending,
      totalDeleted: targets.reduce((sum, entry) => sum + entry.deleted, 0),
      targets,
      failed: targets
        .filter((entry) => entry.error !== undefined)
        .map((entry) => entry.id),
    };

    // Counted per target, not as one total. "The retention job deleted a million
    // rows" is not answerable by an alert; "notification_logs is not being pruned"
    // is, and it needs the per-target series to show up on a dashboard.
    for (const target of targets) {
      if (target.deleted > 0) {
        this.metrics.retentionRowsDeleted(target.id, target.deleted);
      }
    }

    this.log(result);

    return result;
  }

  /**
   * Runs one target to completion. Never throws: a failure is reported on the
   * result so the caller can carry on with the next table.
   */
  private async runTarget(
    runner: QueryRunner,
    target: RetentionTarget,
    context: {
      dryRun: boolean;
      deadline: number;
      now: () => number;
      sleep: (ms: number) => Promise<void>;
      shouldStop: () => Promise<boolean> | boolean;
      onProgress: (progress: RetentionProgress) => void | Promise<void>;
      processed: number;
      total: number;
    },
  ): Promise<{
    result: RetentionTargetResult;
    timedOut: boolean;
    cancelled: boolean;
  }> {
    const { dryRun, deadline, now, sleep, shouldStop, onProgress } = context;
    const startedAtMs = now();
    const predicate = target.buildPredicate(resolveCutoff(target.ageDays));

    const base = {
      id: target.id,
      table: target.table,
      description: target.description,
      ageDays: target.ageDays,
      cascades: target.cascades,
    };

    try {
      if (dryRun) {
        const rows = await runner.query(
          `SELECT count(*)::int AS n FROM "${target.table}" d WHERE ${predicate}`,
        );
        const deleted = Number(rows[0]?.n ?? 0);

        return {
          result: {
            ...base,
            deleted,
            batches: 0,
            durationMs: now() - startedAtMs,
          },
          timedOut: false,
          cancelled: false,
        };
      }

      let deleted = 0;
      let batches = 0;
      let timedOut = false;
      let cancelled = false;

      while (true) {
        if (now() >= deadline) {
          timedOut = true;
          break;
        }

        // The boundary. Asked before a batch and never inside one: each batch
        // is its own transaction, so stopping here leaves the table in a state
        // that a run which had simply been interrupted would also leave, and
        // stopping inside one would leave a half-deleted table.
        if (await shouldStop()) {
          cancelled = true;
          break;
        }

        // The tuple shape is why this reads a number rather than counting rows:
        // see `countAffectedRows`. A short batch ends the loop, and fewer rows
        // than the batch size means nothing can still match, so there is no final
        // SELECT to confirm it.
        const affected = await this.deleteBatch(runner, target, predicate);

        batches += 1;
        deleted += affected;

        if (affected < this.config.batchSize) {
          break;
        }

        await sleep(this.config.batchDelay);
      }

      await onProgress({
        processed: context.processed + 1,
        total: context.total,
        current: target.id,
      });

      return {
        result: { ...base, deleted, batches, durationMs: now() - startedAtMs },
        timedOut,
        cancelled,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `Target ${target.id} failed, continuing with the rest of the run: ${message}`,
      );

      return {
        result: {
          ...base,
          deleted: 0,
          batches: 0,
          durationMs: now() - startedAtMs,
          error: message,
        },
        timedOut: false,
        cancelled: false,
      };
    }
  }

  /** One batch, in its own transaction so a failure is contained. */
  private async deleteBatch(
    runner: QueryRunner,
    target: RetentionTarget,
    predicate: string,
  ): Promise<number> {
    // The outer alias is `t` and the inner one is `d`, because a predicate may
    // refer to `d` to match a child table, and the inner scope would shadow an
    // outer alias of the same name.
    const sql =
      `DELETE FROM "${target.table}" t ` +
      `WHERE t."id" IN (SELECT d."id" FROM "${target.table}" d WHERE ${predicate} LIMIT $1) ` +
      `RETURNING 1`;

    await runner.startTransaction();

    try {
      const result = await runner.query(sql, [this.config.batchSize]);
      await runner.commitTransaction();

      return countAffectedRows(result);
    } catch (error) {
      // Rolled back before the error propagates, otherwise the runner is still
      // inside an aborted transaction and every later target fails with
      // "current transaction is aborted". The rollback itself can fail if the
      // connection is what broke, which is the common case here and must not
      // replace the real error.
      await runner.rollbackTransaction().catch(() => undefined);

      throw error;
    }
  }

  /**
   * Appends a run to the history.
   *
   * Public because three callers record runs: the processor for a queued job, the
   * admin route for a dry run, and anyone running the job from a terminal. Keeping
   * it here means the row is written one way, and the `trigger` on it is the only
   * record of who asked.
   *
   * Throws on failure rather than swallowing, so the caller can tell a completed
   * cleanup from an unrecorded one. The two are different: the rows are gone
   * either way, and only one of them can be retried.
   */
  async record(
    result: RetentionRunResult,
    trigger: RetentionTrigger,
  ): Promise<MaintenanceLog> {
    const entry = this.logs.create({
      startedAt: new Date(result.startedAt),
      finishedAt: new Date(
        new Date(result.startedAt).getTime() + result.durationMs,
      ),
      durationMs: result.durationMs,
      dryRun: result.dryRun,
      totalDeleted: result.totalDeleted,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      trigger,
      pending: [...result.pending],
      failedTargets: [...result.failed],
      targets: [...result.targets],
    });

    return this.logs.save(entry);
  }

  /**
   * Reads the history, newest first, one page at a time.
   *
   * **Cursor paged, and no `COUNT(*) OVER()`.** The window function was there to
   * report a total in the same round trip, which is free but not free: a count has
   * to read every matching row, so the "cheap" query was O(history) whatever the
   * page size. The table grows without bound — nothing prunes it — so the total
   * became more expensive the longer the service ran, on the route an operator
   * opens when something has already gone wrong.
   *
   * `hasMore` costs one row past the limit instead. What an operator needs from
   * this screen is "is there more, and show me the next one", and both are
   * answered by the page itself.
   */
  async history(
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResultDto<MaintenanceLog>> {
    const criteria = buildCriteria(query, RETENTION_QUERY_SPEC);

    return readPaginatedResult({
      query: this.logs.createQueryBuilder('run'),
      criteria,
      alias: 'run',
    });
  }

  /** The most recent run, or null when nothing has ever run. */
  async latest(): Promise<MaintenanceLog | null> {
    // `find` with a limit rather than `findOne`. TypeORM refuses a `findOne`
    // that carries no `where`, throwing "You must provide selection conditions
    // in order to find a single row" the first time this runs against a
    // non-empty table. A repository mock never reached that, which is why it
    // passed every test and failed on the first real call.
    const [entry] = await this.logs.find({
      order: { startedAt: 'DESC' },
      take: 1,
    });

    return entry ?? null;
  }

  private log(result: RetentionRunResult): void {
    const summary = result.targets
      .map((entry) =>
        entry.error === undefined
          ? `${entry.id}=${entry.deleted}`
          : `${entry.id}=failed(${entry.error})`,
      )
      .join(' ');

    const message =
      `${result.dryRun ? 'Dry run' : 'Retention run'} finished in ${result.durationMs}ms, ` +
      `${result.totalDeleted} rows: ${summary}`;

    if (result.cancelled) {
      // Not a warning. The run was asked to stop and it stopped; the tables it
      // did not reach are the next run's work, exactly as they are after a
      // timeout.
      this.logger.log(
        `${message} Stopped because it was cancelled; not reached: ${result.pending.join(', ')}`,
      );

      return;
    }

    if (result.timedOut) {
      this.logger.warn(
        `${message} Stopped on the run timeout; not reached: ${result.pending.join(', ')}`,
      );
      return;
    }

    if (result.failed.length > 0) {
      this.logger.warn(message);
      return;
    }

    this.logger.log(message);
  }
}
