import { Injectable, Logger } from '@nestjs/common';

import type {
  Job,
  JobContext,
  JobResult,
} from '../../queue/queue.interface.js';
import { NotificationService } from '../../notification/notification.service.js';
import { TenantRegistry } from '../../tenancy/tenant-registry.service.js';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service.js';
import type { TenantContextValue } from '../../tenancy/tenant-registry.service.js';
import { RetentionTrigger } from '../entities/retention-trigger.enum.js';
import {
  RetentionService,
  type RetentionRunResult,
} from '../retention.service.js';

/** The one job name this processor answers to. */
export const RETENTION_JOB = 'maintenance.run-retention';

/**
 * What a retention job carries.
 *
 * `dryRun` is per job rather than only per deployment because the operator has to
 * be able to rehearse against production data without changing configuration and
 * restarting. `trigger` is carried so the log records who asked, which is the
 * whole reason the column exists.
 */
export interface RetentionJobPayload {
  dryRun?: boolean;
  trigger?: RetentionTrigger;
}

/**
 * Runs the retention policy as a queue job, and records what happened.
 *
 * Both dispatchers call this, the same as `MailProcessor`, which is what makes
 * the in-process path a real fallback rather than a second implementation.
 *
 * The context is what makes the run watchable and stoppable: the run reports
 * what it is doing through it, and asks it whether it should carry on. A run
 * without one — the admin route's dry run, a run from a terminal — still
 * works; it just cannot be watched or stopped.
 */
@Injectable()
export class RetentionProcessor {
  private readonly logger = new Logger(RetentionProcessor.name);

  constructor(
    private readonly retentionService: RetentionService,
    private readonly notifications: NotificationService,
    private readonly tenants: TenantRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** True for the job name this processor handles, so routing stays in one place. */
  static handles(name: string): boolean {
    return name === RETENTION_JOB;
  }

  async process(
    job: Job<RetentionJobPayload>,
    context?: JobContext,
  ): Promise<JobResult> {
    const payload = this.validate(job.payload);

    if (payload === null) {
      // Retrying a malformed payload can only produce the same malformed payload.
      return {
        ok: false,
        error: `Malformed ${RETENTION_JOB} payload`,
        retryable: false,
      };
    }

    // **One run per tenant.** Retention removes rows by age, and a row that is
    // expired for one tenant is another tenant's live one. A single run over
    // every table would clean them together, so the job visits each tenant in
    // turn and each visit is scoped to that tenant.
    const tenants = await this.tenants.active();

    if (tenants.length === 0) {
      return { ok: true };
    }

    for (const tenant of tenants) {
      const outcome = await this.runForTenant(tenant, payload, context);

      if (!outcome.ok) {
        return outcome;
      }
    }

    return { ok: true };
  }

  /**
   * Runs the policy for one tenant, in that tenant's context.
   */
  private async runForTenant(
    tenant: TenantContextValue,
    payload: RetentionJobPayload,
    context?: JobContext,
  ): Promise<JobResult> {
    let result: RetentionRunResult;

    try {
      result = await this.tenantContext.run(tenant, () =>
        this.retentionService.run({
          dryRun: payload.dryRun,
          shouldStop: context ? () => context.isCancelled() : undefined,
          onProgress: context
            ? (progress) =>
                context.report({
                  processed: progress.processed,
                  total: progress.total,
                  current: progress.current,
                })
            : undefined,
        }),
      );
    } catch (error) {
      // The service catches per target, so a throw here came from outside the
      // loop: no connection, or a pool that would not hand one out. No log row is
      // written, because the insert needs the same connection that just failed.
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Retention job threw before recording a run: ${message}`,
      );

      return { ok: false, error: message, retryable: true };
    }

    try {
      await this.retentionService.record(
        result,
        payload.trigger ?? RetentionTrigger.Cron,
      );
    } catch (error) {
      // The rows are already gone; only the record of it is missing. Retryable
      // because the next attempt re-runs an idempotent cleanup and tries the
      // insert again, which costs nothing but time.
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Retention run deleted ${result.totalDeleted} rows but could not be recorded: ${message}`,
      );

      return {
        ok: false,
        error: `run completed, log insert failed: ${message}`,
        retryable: true,
      };
    }

    await this.reportAnomaly(result);

    return this.toJobResult(result);
  }

  /**
   * Tells an operator when a run did not finish cleanly.
   *
   * **Only for a run that stopped early or lost a target.** A run that deleted rows
   * across every table is not news, and a notification for it would be the first
   * thing an operator learns to ignore — which costs them the one notification that
   * mattered.
   *
   * **Direct, not enqueued.** This code is already running inside a queue job, so
   * there is no request to keep off the critical path, and enqueueing would mean a
   * notification about a broken queue depends on the broken queue. It is also why
   * `MaintenanceModule` can import `NotificationModule` while `NotificationEventsModule`
   * sits above the queue: both point the same way.
   *
   * Swallowed. A webhook that times out must not turn a completed cleanup into a
   * failed job, which would retry the whole idempotent run to deliver a message.
   */
  private async reportAnomaly(result: RetentionRunResult): Promise<void> {
    if (!result.timedOut && result.failed.length === 0) {
      return;
    }

    try {
      await this.notifications.notify('maintenance.retention.anomaly', {
        reason: result.timedOut
          ? 'the run hit its timeout and stopped before finishing'
          : `${result.failed.length} target(s) failed`,
        pending: [...result.pending],
        failed: [...result.failed],
        durationMs: result.durationMs,
      });
    } catch (error) {
      this.logger.error(
        `Could not report a retention anomaly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Turns a run outcome into a job outcome.
   *
   * A run that finished is a success even when individual targets failed. Those
   * failures are recorded, visible in the admin history, and would answer
   * identically to a retry: a renamed column is still renamed five seconds later,
   * so retrying only spends the budget and delays the dead-letter entry that
   * would tell an operator which table to look at.
   *
   * A timeout is the opposite. The run stopped with tables still unclean, so it is
   * reported as a failure and left retryable: the run is idempotent, so finishing
   * the remaining tables costs nothing but the time the lost connection was not
   * using anyway.
   *
   * A cancelled run is neither. It was asked to stop and it stopped at a point
   * where stopping was safe, so it is not a failure and not a success either:
   * the work is unfinished, and the remaining tables are the next run's job.
   */
  private toJobResult(result: RetentionRunResult): JobResult {
    if (result.cancelled) {
      return {
        ok: false,
        cancelled: true,
        error: 'the run was cancelled before it finished',
        // Not retryable, and not dead-lettered either: the dispatcher checks
        // `cancelled` before either of those, because retrying would do the
        // work nobody asked for.
        retryable: false,
      };
    }

    if (result.timedOut) {
      return {
        ok: false,
        error: `run timed out with ${result.pending.length} targets not reached`,
        retryable: true,
      };
    }

    return { ok: true };
  }

  private validate(payload: unknown): RetentionJobPayload | null {
    if (payload === null || payload === undefined) {
      return {};
    }

    if (typeof payload !== 'object') {
      return null;
    }

    const { dryRun, trigger } = payload as Partial<RetentionJobPayload>;

    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      return null;
    }

    if (
      trigger !== undefined &&
      !Object.values(RetentionTrigger).includes(trigger)
    ) {
      return null;
    }

    return { dryRun, trigger };
  }
}
