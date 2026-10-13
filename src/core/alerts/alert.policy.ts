/**
 * The thresholds the alert rules fire on.
 *
 * **This is the single source of truth.** `ops/prometheus/alerts.yml` is written
 * against these numbers and `alert.policy.spec.ts` parses that file and fails
 * when the two disagree — the same arrangement as `migrations.spec.ts` for DDL
 * and `sessions-version-guard.spec.ts` for revocation writes, because a Prometheus
 * rule file is hand-maintained YAML with no compiler anywhere near it.
 *
 * A drifted alert is worse than no alert in one specific way: it stays green while
 * the thing it watches is on fire, and everyone stops believing the alerts that do
 * fire. That is how a monitoring system gets turned off.
 *
 * ## Why the thresholds are what they are
 *
 * Every rule carries a `for:` window as well as a threshold, because a threshold
 * alone fires on the ordinary. A deployment restarting briefly stops answering, a
 * cron lands on the hour, a deploy doubles the request rate for ninety seconds —
 * a rule that fires on those is a rule people learn to ignore, and a rule people
 * learn to ignore is not a rule.
 */

export interface AlertRule {
  /** Prometheus alert name, also the `alert:` field. */
  name: string;
  /** One line saying what it means, not what to do. */
  summary: string;
  /** How long the condition must hold before firing. */
  for: string;
  /** The PromQL expression, without the vector selectors around it. */
  expression: string;
  /** What an operator should check first. */
  runbook: string;
}

/** The mail failure ratio that counts as an incident. */
export const MAIL_FAILURE_RATIO = 0.1;

/**
 * Five minutes of averaging.
 *
 * The window has to cover several retry cycles. A provider that refuses once
 * produces a 100% failure ratio for exactly one send, and an alert with no window
 * fires on it. Five minutes at any real send rate is enough sends for the ratio to
 * mean something.
 */
export const MAIL_FAILURE_WINDOW = '5m';

/** A fifth of all mail failing. */
export const MAIL_FAILURE_THRESHOLD = MAIL_FAILURE_RATIO;

/** One dead-lettered job is an incident; it is a job that will never run. */
export const DEAD_LETTER_THRESHOLD = 1;

/**
 * One hour.
 *
 * A job that exhausts its retries is not going to retry again. Waiting an hour
 * before saying so means a small incident is only noticed on somebody's next
 * coffee break, and the recovery action — reading the entry, replaying the job —
 * has a context attached by then.
 */
export const DEAD_LETTER_FOR = '1h';

/**
 * Twenty-six hours, and the number is the plan's.
 *
 * The retention job runs daily at 03:17, so 26 hours is one full cycle missed plus
 * most of the next. Shorter fires on a run that was merely late because the
 * scheduler was restarting; longer lets a nightly job stay broken over a weekend.
 */
export const MAINTENANCE_LATE_HOURS = 26;

/**
 * Five minutes of grace past the threshold.
 *
 * The health indicator reports `degraded` at the threshold; this waits a little
 * past it so the alert and the endpoint do not disagree about the same instant.
 */
export const MAINTENANCE_FOR = '5m';

/**
 * Every rule, in the order an operator reads them at 3am: the thing a customer
 * noticed, then the thing that will not fix itself, then the thing that was never
 * noticed at all.
 */
export const ALERT_RULES: readonly AlertRule[] = [
  {
    name: 'MailFailing',
    summary: 'A large share of outbound mail is being refused or failing.',
    for: '5m',
    expression:
      `sum(rate(mail_failures_total[${MAIL_FAILURE_WINDOW}])) ` +
      '/ clamp_min(sum(rate(mail_sent_total[' +
      `${MAIL_FAILURE_WINDOW}])) + ` +
      `sum(rate(mail_failures_total[${MAIL_FAILURE_WINDOW}])), 1) ` +
      `> ${MAIL_FAILURE_RATIO}`,
    runbook: 'runbook.md#mail-is-failing',
  },
  {
    name: 'JobsDeadLettered',
    summary: 'Jobs have exhausted their retries and will not run again.',
    for: DEAD_LETTER_FOR,
    expression: `dead_lettered_total > ${DEAD_LETTER_THRESHOLD}`,
    runbook: 'runbook.md#jobs-are-dead-lettering',
  },
  {
    name: 'MaintenanceOverdue',
    summary: 'The nightly retention job has not finished in over a day.',
    for: MAINTENANCE_FOR,
    expression: `maintenance_age_hours > ${MAINTENANCE_LATE_HOURS}`,
    runbook: 'runbook.md#the-retention-job-has-not-run',
  },
];

/** Names, for a test that asserts the YAML declares exactly these. */
export function alertNames(): string[] {
  return ALERT_RULES.map((rule) => rule.name);
}
