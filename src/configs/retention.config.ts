import { registerAs } from '@nestjs/config';

/**
 * Data retention settings.
 *
 * Not exported from `configs/index.ts` and not in the `load` array of
 * `app.module.ts`: loaded with `ConfigModule.forFeature()` inside
 * `MaintenanceModule`, so an app that never enables the job carries none of it.
 *
 * Every age is configurable, but the defaults are the policy: a soft-deleted
 * user is hard deleted after 30 days, dead tokens after 7, and the log tables
 * that grow on every request after 30. The values a mistake hurts most are the
 * short ones, so the validation rejects an age below one day.
 */

export interface RetentionConfig {
  /**
   * Whether the scheduled job runs. On by default.
   *
   * Retention only ever removes rows that are already past their age, so an app
   * that never configures it loses nothing it could still use, and a table that
   * nobody prunes grows until something breaks. Defaulting to off would make every
   * deployment a deployment that leaks, and the people least likely to read the
   * docs are exactly the ones who would never turn it on. Set
   * `RETENTION_ENABLED=false` to stop it; the admin route stays available either
   * way.
   */
  enabled: boolean;
  /**
   * Reports what would be deleted and deletes nothing. The first production run
   * should be rehearsed with this on.
   */
  dryRun: boolean;
  /** Cron expression, off-peak by default so it does not compete with traffic. */
  schedule: string;
  /**
   * Rows per delete statement. Large enough to finish quickly, small enough
   * that a batch does not hold a lock long enough to show up as latency.
   */
  batchSize: number;
  /** Pause between batches, in milliseconds, so the database can breathe. */
  batchDelay: number;
  /** How long one run may take before it gives up and tries again tomorrow. */
  runTimeout: number;
  ages: RetentionAges;
}

export interface RetentionAges {
  /** Days after a user is soft deleted before the row is hard deleted. */
  softDeletedUsers: number;
  /** Grace days after a verification token expires before it is removed. */
  emailVerificationTokens: number;
  /** Grace days after a reset token is used or expires before it is removed. */
  passwordResetTokens: number;
  /** Days after a refresh token is revoked or expired before it is removed. */
  refreshTokens: number;
  /** Days before a mail log row is removed. */
  mailLogs: number;
  /** Days before a notification log row is removed. */
  notificationLogs: number;
  /** Days before a login-attempt bookkeeping row is removed. */
  loginAttempts: number;
  /**
   * Days before an audit log row is removed. Longer than the others on purpose:
   * an audit trail kept for a month is not an audit trail.
   */
  auditLogs: number;
  /**
   * Days before a superseded mail template version is removed.
   *
   * Reuses the audit window rather than adding a knob of its own. The two tables
   * answer the same question — "what did this say, and who changed it" — and a
   * template history that outlived the audit trail would be keeping wording nobody
   * can attribute.
   */
  mailTemplateVersions: number;
}

export const DEFAULT_AGES: RetentionAges = {
  softDeletedUsers: 30,
  emailVerificationTokens: 7,
  passwordResetTokens: 7,
  refreshTokens: 7,
  mailLogs: 30,
  notificationLogs: 30,
  loginAttempts: 7,
  auditLogs: 365,
  mailTemplateVersions: 365,
};

const days = (value: string | undefined, key: keyof RetentionAges): number =>
  Number(value ?? DEFAULT_AGES[key]);

const flag = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === 'true';

export const retentionConfig = registerAs('retention', (): RetentionConfig => ({
  enabled: flag(process.env.RETENTION_ENABLED, true),
  dryRun: flag(process.env.RETENTION_DRY_RUN),
  // 03:17 rather than 03:00, so it does not land on the same minute as every
  // other scheduled job in the fleet.
  schedule: process.env.RETENTION_SCHEDULE ?? '17 3 * * *',
  batchSize: Number(process.env.RETENTION_BATCH_SIZE ?? 5_000),
  batchDelay: Number(process.env.RETENTION_BATCH_DELAY ?? 100),
  runTimeout: Number(process.env.RETENTION_RUN_TIMEOUT ?? 3_600_000),
  ages: {
    softDeletedUsers: days(
      process.env.RETENTION_USERS_DAYS,
      'softDeletedUsers',
    ),
    emailVerificationTokens: days(
      process.env.RETENTION_EMAIL_TOKENS_DAYS,
      'emailVerificationTokens',
    ),
    passwordResetTokens: days(
      process.env.RETENTION_RESET_TOKENS_DAYS,
      'passwordResetTokens',
    ),
    refreshTokens: days(
      process.env.RETENTION_REFRESH_TOKENS_DAYS,
      'refreshTokens',
    ),
    mailLogs: days(process.env.RETENTION_MAIL_LOGS_DAYS, 'mailLogs'),
    notificationLogs: days(
      process.env.RETENTION_NOTIFICATION_LOGS_DAYS,
      'notificationLogs',
    ),
    loginAttempts: days(
      process.env.RETENTION_LOGIN_ATTEMPTS_DAYS,
      'loginAttempts',
    ),
    auditLogs: days(process.env.RETENTION_AUDIT_LOGS_DAYS, 'auditLogs'),
    mailTemplateVersions: days(
      process.env.RETENTION_MAIL_TEMPLATE_VERSIONS_DAYS,
      'mailTemplateVersions',
    ),
  },
}));
