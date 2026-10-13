import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MetricsService } from '../metrics/index.js';
import { QueueHealthIndicator } from '../health/queue.health.js';
import { MaintenanceHealthIndicator } from '../health/maintenance.health.js';

import {
  ALERT_RULES,
  DEAD_LETTER_FOR,
  DEAD_LETTER_THRESHOLD,
  MAIL_FAILURE_RATIO,
  MAIL_FAILURE_WINDOW,
  MAINTENANCE_FOR,
  MAINTENANCE_LATE_HOURS,
  alertNames,
} from './alert.policy.js';

/**
 * A Prometheus rule file is hand-maintained YAML with no compiler anywhere near
 * it, and a drifted alert is worse than no alert in one specific way: **it stays
 * green while the thing it watches is on fire**, and people stop believing the
 * alerts that do fire. That is how a monitoring system gets turned off.
 *
 * So the thresholds live in TypeScript and this test parses the YAML and fails
 * when the two disagree. The same arrangement as `migrations.spec.ts` for DDL and
 * `sessions-version-guard.spec.ts` for revocation writes.
 *
 * The parser is deliberately minimal — a line reader and two small extractors —
 * because adding a YAML dependency to check a file this size would be a larger
 * change than the thing being checked.
 */

const YAML = readFileSync(
  new URL('../../../ops/prometheus/alerts.yml', import.meta.url).pathname,
  'utf8',
);

/** The `expr:` body of one alert, with the YAML block scalar unwrapped. */
function expressionOf(alert: string): string {
  const lines = YAML.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- alert: ${alert}`);

  expect(start, `${alert} is not declared in alerts.yml`).toBeGreaterThan(-1);

  const exprStart = lines.findIndex(
    (line, index) => index > start && line.trim() === 'expr: |',
  );

  if (exprStart === -1) {
    // A single-line expression rather than a block scalar.
    const inline = lines.findIndex(
      (line, index) => index > start && line.trim().startsWith('expr:'),
    );

    return (lines[inline] ?? '').trim().replace(/^expr:\s*/, '');
  }

  const body: string[] = [];

  for (let index = exprStart + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    // A new key at the alert's own indentation ends the block.
    if (/^ {6}\S/.test(line)) {
      break;
    }

    body.push(line.trim());
  }

  return body.join(' ').replace(/\\s+/g, ' ').trim();
}

function forDurationOf(alert: string): string {
  const expression = new RegExp(
    `- alert: ${alert}[\\s\\S]*?\\n\\s+for: ([^\\n]+)`,
  ).exec(YAML);

  return expression?.[1]?.trim() ?? '';
}

describe('the rules file', () => {
  it('declares exactly the rules the policy defines, and no others', () => {
    // A rule in the YAML with no constant behind it will drift; a constant with no
    // rule will never fire, and both look identical until the day they matter.
    const declared = [...YAML.matchAll(/^\s+- alert: (\w+)$/gm)].map(
      (match) => match[1] as string,
    );

    expect(declared.sort()).toEqual(alertNames().sort());
  });

  it('names every rule the policy defines', () => {
    for (const name of alertNames()) {
      expect(YAML, name).toContain(`- alert: ${name}`);
    }
  });
});

describe('the mail failure rate', () => {
  it('uses the same threshold as the policy', () => {
    expect(expressionOf('MailFailing')).toContain(`> ${MAIL_FAILURE_RATIO}`);
  });

  it('averages over the same window, because a ratio over one send is meaningless', () => {
    expect(expressionOf('MailFailing')).toContain(
      `mail_failures_total[${MAIL_FAILURE_WINDOW}]`,
    );
  });

  it('divides failures by all sends rather than by a fixed number', () => {
    // A quiet deployment is not alerted, and a busy one is not diluted by a
    // denominator larger than its traffic.
    expect(expressionOf('MailFailing')).toContain('mail_sent_total');
  });

  it('clamps the denominator, so a deployment that has sent nothing stays quiet', () => {
    // Without this, a rate of 0 over 0 divides by zero and the alert fires on the
    // way up from zero — which is every fresh deployment.
    expect(expressionOf('MailFailing')).toContain('clamp_min');
  });

  it('waits five minutes, so one refused message is not an incident', () => {
    expect(forDurationOf('MailFailing')).toBe('5m');
  });
});

describe('the dead-letter list', () => {
  it('fires on one entry, because that job will never run', () => {
    expect(expressionOf('JobsDeadLettered')).toContain(
      `> ${DEAD_LETTER_THRESHOLD}`,
    );
  });

  it('waits an hour before paging', () => {
    expect(forDurationOf('JobsDeadLettered')).toBe(DEAD_LETTER_FOR);
  });
});

describe('the maintenance job', () => {
  it('fires at the same hour count as the health indicator', () => {
    // Two places with two numbers is how an alert and an endpoint disagree about
    // the same instant, and the operator is left deciding which one to believe.
    expect(expressionOf('MaintenanceOverdue')).toContain(
      `> ${MAINTENANCE_LATE_HOURS}`,
    );
  });

  it('waits the same grace period, for the same reason', () => {
    expect(forDurationOf('MaintenanceOverdue')).toBe(MAINTENANCE_FOR);
  });
});

describe('the metrics the rules depend on', () => {
  /**
   * An alert on a metric nothing emits is green forever, and it is green in the
   * specific way that teaches people not to believe the other alerts. So each of
   * these asserts that the number the rule reads is actually produced somewhere.
   */
  it('`dead_lettered_total` is set by the queue health check', async () => {
    const set: number[] = [];
    const metrics = {
      deadLettered: (total: number) => set.push(total),
      queueBacklog: () => undefined,
    } as unknown as MetricsService;

    const indicator = new QueueHealthIndicator(
      {
        driver: 'bullmq',
        depth: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
      } as never,
      { size: async () => 3 } as never,
      { getClient: async () => ({}) as never } as never,
      metrics,
    );

    await indicator.isHealthy();

    expect(set).toEqual([3]);
  });

  it('`maintenance_age_hours` is set by the maintenance health check', async () => {
    const set: number[] = [];
    const metrics = {
      maintenanceAgeHours: (hours: number) => set.push(hours),
    } as unknown as MetricsService;

    const finishedAt = new Date(Date.now() - 30 * 3_600_000);

    const indicator = new MaintenanceHealthIndicator(
      {
        latest: async () => ({
          finishedAt,
          timedOut: false,
          failedTargets: [],
          pending: [],
          durationMs: 1_000,
          totalDeleted: 0,
          dryRun: false,
        }),
      } as never,
      metrics,
    );

    await indicator.isHealthy();

    expect(set).toHaveLength(1);
    expect(set[0]).toBeGreaterThan(29);
  });

  it('`mail_sent_total` and `mail_failures_total` are incremented by MailService', () => {
    // Grepped rather than called: the assertion is that the names the rule reads
    // are the names the service records, and the two live in different files.
    const service = readFileSync(
      new URL('../../modules/mail/mail.service.ts', import.meta.url).pathname,
      'utf8',
    );

    expect(service).toContain('this.metrics.mailSent(');
    expect(service).toContain('this.metrics.mailFailed(');
  });
});

describe('the thresholds themselves', () => {
  it('alerts on a tenth of mail failing, not half', () => {
    // Half is the number that arrives after the incident. A tenth catches a
    // provider that started refusing a segment of recipients, which is the common
    // shape and the one that is easy to miss on a dashboard.
    expect(MAIL_FAILURE_RATIO).toBe(0.1);
  });

  it('alerts after 26 hours, which is one full cycle missed plus most of the next', () => {
    expect(MAINTENANCE_LATE_HOURS).toBe(26);
  });
});

describe('the rules as a whole', () => {
  it('every rule has a wait, because a threshold alone fires on the ordinary', () => {
    // A restart, a cron landing on the hour, a deploy doubling traffic for ninety
    // seconds: a rule that fires on those is a rule people learn to ignore.
    for (const rule of ALERT_RULES) {
      expect(rule.for, rule.name).toMatch(/^\d+[smh]$/);
    }
  });

  it('every rule points at a runbook section', () => {
    // An alert that says what happened and not what to check is a ticket somebody
    // has to research from scratch at 3am.
    for (const rule of ALERT_RULES) {
      expect(rule.runbook, rule.name).toMatch(/^runbook\.md#/);
      expect(YAML, rule.name).toContain(rule.runbook);
    }
  });

  it('every rule says what it means, not what to do', () => {
    // "Restart the app" in an alert annotation is an instruction somebody follows
    // before understanding the problem. The runbook is where the actions live.
    for (const rule of ALERT_RULES) {
      expect(rule.summary.length, rule.name).toBeGreaterThan(20);
    }
  });

  it('every rule carries a severity, so a ticket and a page are distinguishable', () => {
    expect(YAML).toContain('severity: page');
    expect(YAML).toContain('severity: ticket');
  });
});
