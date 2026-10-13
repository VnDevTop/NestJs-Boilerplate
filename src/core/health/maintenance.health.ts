import { Injectable, Logger } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import { MetricsService } from '../metrics/index.js';
import { RetentionService } from '../../modules/maintenance/retention.service.js';
import type { MaintenanceLog } from '../../modules/maintenance/entities/index.js';

/**
 * After this many hours without a completed run, the job is late.
 *
 * The plan asks for an alert at 26 hours, and that number is this one: the
 * retention job runs at 03:17 daily, so 26 hours is "one full cycle missed plus
 * most of the next". A shorter window would fire on a run that was merely late
 * because the scheduler was busy restarting, and a longer one would let a nightly
 * job stay broken over a weekend.
 */
export const MAINTENANCE_ALERT_AFTER_HOURS = 26;

/**
 * Reports the last maintenance run, and whether it happened recently enough.
 *
 * **A missed retention job is invisible from every other signal in this
 * application.** Nothing fails, nothing errors, and every request answers. What
 * changes is that the tables the policy prunes keep growing, quietly, until one of
 * them is large enough that something else breaks — and by then the cause is days
 * old and nothing recorded it. This is the only place that says "the job you
 * scheduled did not run".
 *
 * **It reports the *last* run, not the last successful one.** A failed run is
 * still the most recent thing that happened and is the more useful answer: the
 * operator's question is usually "did it run", and a run that failed while
 * deleting nothing is a worse answer to hide than to show. `status` carries which
 * it was.
 *
 * **It never blocks readiness.** A retention job that has not run is a housekeeping
 * failure. Taking every instance out of rotation over it would stop the
 * application doing the thing the retention job is protecting.
 */
@Injectable()
export class MaintenanceHealthIndicator {
  private readonly logger = new Logger(MaintenanceHealthIndicator.name);

  constructor(
    private readonly maintenance: RetentionService,
    private readonly metrics: MetricsService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    try {
      const last = await this.maintenance.latest();

      if (last === null) {
        // Never run. `degraded` rather than `up`, because an enabled retention job
        // that has never run is a configuration problem somebody needs to see, and
        // a deployment that only just started is indistinguishable from one whose
        // scheduler has been broken since it booted.
        return {
          maintenance: {
            status: 'degraded',
            lastRun: null,
            reason: 'the retention job has never completed a run',
          },
        };
      }

      const ageHours = (Date.now() - last.finishedAt.getTime()) / 3_600_000;
      const late = ageHours > MAINTENANCE_ALERT_AFTER_HOURS;

      // The gauge `MaintenanceOverdue` reads. The alert cannot work off this
      // endpoint — Prometheus does not poll health endpoints — so the number has to
      // reach a metric somewhere, and this is the only place it is computed.
      this.metrics.maintenanceAgeHours(ageHours);

      // The payload is assembled as an object and the reason is only added when
      // there is one, rather than assigned `undefined`. A key that is present but
      // null is a key an operator's tooling has to learn to skip, and one that is
      // present and undefined is worse.
      const reason = this.reasonFor(last, ageHours);

      const result: HealthIndicatorResult = {
        maintenance: {
          status: late || last.timedOut ? 'degraded' : 'up',
          finishedAt: last.finishedAt.toISOString(),
          ageHours: Math.round(ageHours),
          durationMs: last.durationMs,
          deleted: last.totalDeleted,
          timedOut: last.timedOut,
          // `dryRun` is here because a green run against production data is not the
          // same as a green run that deleted anything, and an operator reading
          // "deleted: 0" on a job whose whole purpose is deleting needs to be able
          // to tell "nothing to delete" from "this was a rehearsal".
          dryRun: last.dryRun,
          failedTargets: last.failedTargets,
          pending: last.pending,
          late,
          ...(reason === undefined ? {} : { reason }),
        },
      };

      if (result.maintenance?.status === 'degraded') {
        this.logger.warn(
          `Retention job is late: last finished ${Math.round(ageHours)}h ago` +
            (last.failedTargets.length > 0
              ? `, ${last.failedTargets.length} target(s) failed`
              : ''),
        );
      }

      return result;
    } catch (error) {
      this.logger.warn(
        `Could not read the last maintenance run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        maintenance: {
          status: 'degraded',
          reason: 'the maintenance history could not be read',
        },
      };
    }
  }

  /**
   * The one line an operator reads first.
   *
   * `null` when there is nothing wrong, so a healthy payload does not carry a
   * reassuring sentence to be read past — a field that is always populated is a
   * field that stops being read.
   */
  private reasonFor(
    last: MaintenanceLog,
    ageHours: number,
  ): string | undefined {
    if (last.timedOut) {
      return `the run timed out after ${Math.round(last.durationMs / 1000)}s`;
    }

    if (last.failedTargets.length > 0) {
      return `${last.failedTargets.length} target(s) failed: ${last.failedTargets.join(', ')}`;
    }

    if (last.pending.length > 0) {
      return `the run stopped before reaching: ${last.pending.join(', ')}`;
    }

    if (ageHours > MAINTENANCE_ALERT_AFTER_HOURS) {
      return `no run has finished in ${Math.round(ageHours)} hours`;
    }

    return undefined;
  }
}
