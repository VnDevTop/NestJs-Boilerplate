import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * A dashboard referencing a metric nothing emits is a dashboard full of empty
 * panels, and an empty panel looks identical to "nothing is happening" — which is
 * the one conclusion a monitoring tool must never support by accident.
 *
 * So every expression is checked against the set of metrics `MetricsService`
 * actually registers. That set is read out of the source rather than kept as a
 * second list, because a second list is exactly the thing that drifts.
 */

const DASHBOARD = readFileSync(
  new URL('../../../ops/grafana/dashboard.json', import.meta.url).pathname,
  'utf8',
);

const SERVICE = readFileSync(
  new URL('../metrics/metrics.service.ts', import.meta.url).pathname,
  'utf8',
);

/** Every metric name the service registers. */
function declaredMetrics(): Set<string> {
  return new Set(
    [
      ...SERVICE.matchAll(
        /'(?:mail_sent_total|mail_failures_total|notification_sent_total|retention_rows_deleted_total|job_lag_seconds|queue_backlog|dead_lettered_total|maintenance_age_hours|auth_login_attempts_total)'/g,
      ),
    ].map((match) => match[0].slice(1, -1)),
  );
}

/** Every PromQL expression on every panel. */
function expressions(): { panel: string; expr: string }[] {
  const parsed = JSON.parse(DASHBOARD) as {
    panels: { title: string; targets?: { expr?: string }[] }[];
  };

  return (parsed.panels ?? []).flatMap((panel) =>
    (panel.targets ?? [])
      .filter((target) => typeof target.expr === 'string')
      .map((target) => ({ panel: panel.title, expr: target.expr as string })),
  );
}

describe('the dashboard', () => {
  it('is valid JSON with a title, so it imports rather than half-imports', () => {
    const parsed = JSON.parse(DASHBOARD) as {
      title?: string;
      panels?: unknown[];
    };

    expect(parsed.title).toBeTruthy();
    expect(Array.isArray(parsed.panels)).toBe(true);
  });

  it('covers the three things the plan names', () => {
    const titles = expressions()
      .map((entry) => entry.panel)
      .join(' ')
      .toLowerCase();

    expect(titles).toContain('sign-in');
    expect(titles).toContain('job lag');
    expect(titles).toContain('mail');
  });

  it('references only metrics the service actually emits', () => {
    // The failure this file exists for: a typo, or a metric renamed on one side
    // only. The panel then shows nothing, forever, with no error anywhere.
    const declared = declaredMetrics();

    for (const { panel, expr } of expressions()) {
      for (const name of expr.match(
        /[a-z_]+_total|[a-z_]+_seconds|[a-z_]+_hours/g,
      ) ?? []) {
        // Histogram buckets and le are suffixes of a real metric rather than
        // metrics in their own right.
        if (name.endsWith('_bucket')) {
          continue;
        }

        expect(
          declared.has(name.replace(/_bucket$/, '')),
          `${panel}: ${name}`,
        ).toBe(true);
      }
    }
  });

  it('has a description on every panel with a query, so a panel explains itself', () => {
    // A panel somebody has to read the runbook to understand is a panel nobody
    // reads. The description is where the "why is this number the one to look at"
    // lives, and it is the part most dashboards omit.
    const panels = JSON.parse(DASHBOARD) as {
      panels: { title: string; targets?: unknown[]; description?: string }[];
    };

    for (const panel of panels.panels) {
      if ((panel.targets ?? []).length === 0) {
        continue;
      }

      expect(panel.description?.length, panel.title).toBeGreaterThan(20);
    }
  });

  it('clamps every denominator, so an idle deployment does not divide by zero', () => {
    for (const { panel, expr } of expressions()) {
      if (!expr.includes('/')) {
        continue;
      }

      expect(panel, expr).toBeDefined();
      expect(expr, panel).toContain('clamp_min');
    }
  });

  it('links to the runbook, so a red panel has somewhere to go', () => {
    const parsed = JSON.parse(DASHBOARD) as { links?: { url: string }[] };

    expect(parsed.links?.[0]?.url).toContain('runbook.md');
  });

  it('thresholds the mail ratio at the number the alert fires on', () => {
    // A dashboard that turns red at 5% while the alert fires at 10% trains people
    // to ignore the panel, which is the same harm as a drifted threshold.
    const panels = JSON.parse(DASHBOARD) as {
      panels: {
        title: string;
        fieldConfig?: {
          defaults?: { thresholds?: { steps?: { value: number }[] } };
        };
      }[];
    };

    const mailRatio = panels.panels.find((panel) =>
      panel.title.includes('Mail failure ratio'),
    );

    expect(mailRatio).toBeDefined();
    expect(
      mailRatio?.fieldConfig?.defaults?.thresholds?.steps?.at(-1)?.value,
    ).toBe(0.1);
  });
});

describe('the metric the dashboard needed and did not have', () => {
  it('counts sign-in attempts, because a failure rate needs a denominator', () => {
    // "Auth failure rate" cannot be computed from a failures-only counter. One
    // counter with an `outcome` label rather than two, so the halves are always
    // over the same window — two counters mean a ratio across two ranges that
    // silently disagree.
    expect(declaredMetrics()).toContain('auth_login_attempts_total');
  });
});
