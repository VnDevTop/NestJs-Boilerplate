import { describe, expect, it, vi } from 'vitest';

import {
  MAINTENANCE_ALERT_AFTER_HOURS,
  MaintenanceHealthIndicator,
} from './maintenance.health.js';
import { MetricsService } from '../metrics/index.js';
import type { MaintenanceLog } from '../../modules/maintenance/entities/index.js';

/**
 * A missed retention job is invisible from every other signal in this
 * application. Nothing fails, nothing errors, every request answers — the tables
 * the policy prunes just keep growing until something else breaks, and by then
 * the cause is days old with nothing recorded it.
 *
 * So these tests are about one question: does this indicator notice, and does
 * noticing take the application down? It must not. A housekeeping failure is not a
 * reason to pull every instance out of rotation.
 */

function log(overrides: Partial<MaintenanceLog> = {}): MaintenanceLog {
  const finishedAt = overrides.finishedAt ?? new Date(Date.now() - 3_600_000);

  return {
    id: 'm1',
    startedAt: new Date(finishedAt.getTime() - 60_000),
    finishedAt,
    durationMs: 60_000,
    dryRun: false,
    totalDeleted: 42,
    timedOut: false,
    trigger: 'cron',
    pending: [],
    failedTargets: [],
    targets: [],
    createdAt: finishedAt,
    ...overrides,
  } as MaintenanceLog;
}

function harness(last: MaintenanceLog | null | Error) {
  const latest = vi.fn(async () => {
    if (last instanceof Error) {
      throw last;
    }

    return last;
  });

  return {
    // A real service: the gauge it sets is a no-op without `prom-client`, and
    // this is the state the suite runs in.
    indicator: new MaintenanceHealthIndicator(
      { latest } as never,
      new MetricsService(),
    ),
    latest,
  };
}

describe('a recent successful run', () => {
  it('is up', async () => {
    const h = harness(log());

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ status: 'up' });
  });

  it('reports what it deleted, so "up" is not the same as "did nothing"', async () => {
    const h = harness(log({ totalDeleted: 42 }));

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ deleted: 42 });
  });

  it('says the run was a rehearsal when it was one', async () => {
    // A green run that deleted nothing is not the same as a green run that had
    // nothing to delete, and an operator reading "deleted: 0" on the job whose
    // whole purpose is deleting needs to tell those apart.
    const h = harness(log({ dryRun: true, totalDeleted: 0 }));

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ dryRun: true, deleted: 0 });
  });

  it('carries no reason, because a field that is always populated stops being read', async () => {
    const h = harness(log());

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).not.toHaveProperty('reason');
  });
});

describe('a run that has not happened', () => {
  it('is degraded, not up', async () => {
    // An enabled retention job that has never run is a configuration problem. A
    // deployment that only just started is indistinguishable from one whose
    // scheduler has been broken since it booted, and one of those two is a problem
    // somebody needs to see.
    const h = harness(null);

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({
      status: 'degraded',
      lastRun: null,
    });
  });

  it("is past 26 hours, which is the plan's threshold", async () => {
    const h = harness(
      log({ finishedAt: new Date(Date.now() - 26 * 3_600_000 - 60_000) }),
    );

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({
      status: 'degraded',
      late: true,
    });
  });

  it('is not late one minute before the threshold', async () => {
    // The boundary is asserted from both sides: an off-by-one either pages at 25h
    // 59m or misses a real 26-hour gap.
    const h = harness(
      log({
        finishedAt: new Date(
          Date.now() - MAINTENANCE_ALERT_AFTER_HOURS * 3_600_000 + 60_000,
        ),
      }),
    );

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ status: 'up', late: false });
  });

  it('says how many hours, because "late" without a number is not actionable', async () => {
    const h = harness(
      log({ finishedAt: new Date(Date.now() - 40 * 3_600_000) }),
    );

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ ageHours: 40 });
    expect(result.maintenance?.reason).toContain('40 hours');
  });
});

describe('a run that did not finish properly', () => {
  it('reports a timeout as degraded', async () => {
    const h = harness(log({ timedOut: true }));

    const result = await h.indicator.isHealthy();

    expect(result.maintenance).toMatchObject({ status: 'degraded' });
  });

  it('names the targets that failed, which is the actionable half', async () => {
    const h = harness(
      log({ failedTargets: ['audit-logs', 'notification-logs'] }),
    );

    const result = await h.indicator.isHealthy();

    expect(result.maintenance?.reason).toContain('audit-logs');
  });

  it('names the targets it never reached', async () => {
    // A run that stopped early has a different problem from one whose targets
    // failed, and both look like "the job did not run" otherwise.
    const h = harness(log({ pending: ['refresh-tokens', 'user-devices'] }));

    const result = await h.indicator.isHealthy();

    expect(result.maintenance?.reason).toContain('refresh-tokens');
  });
});

describe('when the history cannot be read', () => {
  it('is degraded rather than throwing out of the probe', async () => {
    // This runs inside a health probe. A throw here becomes a failed readiness,
    // which is an outage caused by the thing meant to detect one.
    const h = harness(new Error('relation does not exist'));

    await expect(h.indicator.isHealthy()).resolves.toMatchObject({
      maintenance: { status: 'degraded' },
    });
  });
});

describe('what it does not do', () => {
  it('never blocks readiness', async () => {
    // Asserted through the status rather than by calling the endpoint: a `degraded`
    // that terminated would be an `error` in Terminus and a 503.
    const h = harness(null);

    const result = await h.indicator.isHealthy();

    expect(result.maintenance?.status).not.toBe('down');
  });
});
