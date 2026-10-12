import type { RetentionAges } from '../../configs/retention.config.js';

/**
 * The retention policy, as data.
 *
 * Every rule lives here as one entry per table, so the service that runs it
 * contains no knowledge of any specific table, column or timestamp comparison.
 * Adding a table is adding an entry, not editing a switch statement, and each
 * entry is testable without a database.
 *
 * The list is deliberately shorter than the plan. Only tables that exist are
 * listed: `mail_logs`, login-attempt bookkeeping and `audit_logs` arrive in later
 * phases, and a rule that names a missing table would fail every night at 3am
 * until someone noticed. They are named in `DEFERRED_TARGETS` so the gap is visible
 * rather than forgotten.
 */

/**
 * The floor for every age, independent of configuration.
 *
 * `env.validation.ts` already rejects an age below one day, but this constant
 * is checked again at the point of use. Validation protects the deployment that
 * reads the config; this protects the code path that deletes rows, from a config
 * object assembled in a test or defaulted by a future refactor. One misread env
 * var must not be able to delete today's data.
 */
export const MINIMUM_AGE_DAYS = 1;

/**
 * How a row becomes eligible for deletion.
 *
 * A function rather than a string enum on purpose: the predicate is the part
 * that can silently delete the wrong rows, so it is written next to the table it
 * belongs to and asserted directly in tests instead of being assembled from a
 * lookup table at runtime.
 */
export type RetentionPredicate = (cutoff: Date) => string;

export interface RetentionTarget {
  /** Stable identifier, used in logs, the run history and the admin API. */
  readonly id: string;
  /** Physical table name. Quoted by the service, never interpolated raw. */
  readonly table: string;
  /** What the rule means, in the words the plan used. */
  readonly description: string;
  /** Config key holding the age, or null when the rule has no age at all. */
  readonly ageKey: keyof RetentionAges | null;
  /** Days the age resolves to. Zero for immediate rules, never negative. */
  readonly ageDays: number;
  readonly buildPredicate: RetentionPredicate;
  /**
   * Tables emptied as a side effect of deleting a row here. Reporting only: the
   * database does the work, and counting it separately would double-count the
   * rows deleted by its own target on the next run.
   */
  readonly cascades: readonly string[];
}

/** Days a rule waits before acting, floored so no target can reach zero. */
export function resolveAgeDays(
  ageKey: keyof RetentionAges | null,
  ages: RetentionAges,
): number {
  if (ageKey === null) {
    return 0;
  }

  const requested = ages[ageKey];

  return Number.isFinite(requested) && requested > MINIMUM_AGE_DAYS
    ? Math.floor(requested)
    : MINIMUM_AGE_DAYS;
}

/**
 * The instant a target acts from: now minus its age. Rows older than this are
 * eligible. A rule with no age returns `now`, which no row can be older than, so
 * an immediate rule has to express its condition without a cutoff instead.
 */
export function resolveCutoff(ageDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
}

export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  {
    id: 'users',
    table: 'users',
    description:
      'soft-deleted users, hard deleted once the grace period passes',
    ageKey: 'softDeletedUsers',
    ageDays: 0,
    buildPredicate: (cutoff) =>
      `"deletedAt" IS NOT NULL AND "deletedAt" < '${cutoff.toISOString()}'`,
    cascades: [
      'email_verification_tokens',
      'password_reset_tokens',
      'refresh_tokens',
      'user_devices',
      'two_factor_secrets',
      // An unlock token is a way into an account, so a restored account must not
      // inherit the links that were mailed to whoever locked it.
      'account_unlock_tokens',
    ],
  },
  {
    id: 'email-verification-tokens',
    table: 'email_verification_tokens',
    description: 'verification tokens, once expired plus a grace period',
    ageKey: 'emailVerificationTokens',
    ageDays: 0,
    buildPredicate: (cutoff) => `"expiresAt" < '${cutoff.toISOString()}'`,
    cascades: [],
  },
  {
    id: 'password-reset-tokens',
    table: 'password_reset_tokens',
    description: 'reset tokens, once used or expired plus a grace period',
    ageKey: 'passwordResetTokens',
    ageDays: 0,
    // Two independent ways to become worthless, so the rule is a disjunction:
    // requiring both would let an expired-but-unused token survive forever.
    buildPredicate: (cutoff) =>
      `("usedAt" IS NOT NULL AND "usedAt" < '${cutoff.toISOString()}') OR ("expiresAt" < '${cutoff.toISOString()}')`,
    cascades: [],
  },
  {
    id: 'refresh-tokens',
    table: 'refresh_tokens',
    description: 'refresh tokens, once revoked or expired plus a grace period',
    ageKey: 'refreshTokens',
    ageDays: 0,
    buildPredicate: (cutoff) =>
      `("revokedAt" IS NOT NULL AND "revokedAt" < '${cutoff.toISOString()}') OR ("expiresAt" < '${cutoff.toISOString()}')`,
    cascades: [],
  },
  {
    // Added by Phase 18, alongside the entity. It is the one deferred target that
    // arrived, so it moves out of `DEFERRED_TARGETS` and into the policy.
    id: 'notification-logs',
    table: 'notification_logs',
    description:
      'notification delivery records, once past the retention window',
    ageKey: 'notificationLogs',
    ageDays: 0,
    // Keyed on the insert time rather than on the event, because a row is evidence
    // that an attempt happened and its value is "how recently did we hear from these
    // channels". An old row for a channel that started failing yesterday is the row
    // an operator wants, and a predicate on the event's own date would keep exactly
    // the wrong ones.
    buildPredicate: (cutoff) => `"createdAt" < '${cutoff.toISOString()}'`,
    cascades: [],
  },
  {
    // Phase 19. It moved out of `DEFERRED_TARGETS` when the entity arrived.
    //
    // A year, not the week everything else gets. `RETENTION_AUDIT_LOGS_DAYS`
    // defaults to 365 and the plan's own comment says why: an audit trail kept for
    // a month is not an audit trail. This is the largest table the job will ever
    // hold, and the one where deleting a row destroys evidence rather than clearing
    // clutter — which is why the default is deliberately conservative and the table
    // is worth sizing for before raising anything else.
    id: 'audit-logs',
    table: 'audit_logs',
    description: 'audit entries, once past the retention window',
    ageKey: 'auditLogs',
    ageDays: 0,
    // On the insert time and nothing else. Every row is equally valuable whatever it
    // recorded, so there is no predicate that would keep the interesting ones — and
    // a rule that tried would be a rule about which actions somebody thought were
    // worth keeping, which is not a decision this table should encode.
    buildPredicate: (cutoff) => `"createdAt" < '${cutoff.toISOString()}'`,
    cascades: [],
  },
  {
    // Phase 19. Same disjunction as the reset tokens above: a token is worthless
    // once it is spent *or* once it is expired, and requiring both would leave an
    // expired-but-unused unlock link in the table forever.
    id: 'account-unlock-tokens',
    table: 'account_unlock_tokens',
    description: 'unlock tokens, once used or expired plus a grace period',
    // The reset tokens' age, reused rather than given its own variable. An unlock
    // link has exactly the same lifetime profile as a reset link — issued, expires,
    // spent — so a second knob would be one more thing to set inconsistently with
    // the first.
    ageKey: 'passwordResetTokens',
    ageDays: 0,
    buildPredicate: (cutoff) =>
      `("usedAt" IS NOT NULL AND "usedAt" < '${cutoff.toISOString()}') OR ("expiresAt" < '${cutoff.toISOString()}')`,
    cascades: [],
  },
  {
    id: 'user-devices',
    table: 'user_devices',
    description: 'devices with no live refresh token, immediately',
    ageKey: null,
    ageDays: 0,
    // Immediate, so no cutoff. A device still holding an unrevoked, unexpired
    // token is somebody's live session and is kept; everything else can no
    // longer authenticate and is only read by the device list.
    //
    // The rule does discard the ipAddress and userAgent of past logins along
    // with the row. On live data it returned 2 rows out of 40, so the trade is
    // deliberately cheap, but it is a trade rather than a free win.
    //
    // `refresh_tokens.deviceId` carries no foreign key, so deleting a device
    // that tokens still point at is not blocked by the database.
    buildPredicate: () =>
      'NOT EXISTS (SELECT 1 FROM "refresh_tokens" rt WHERE rt."deviceId" = d."id" AND rt."revokedAt" IS NULL AND rt."expiresAt" > now())',
    cascades: [],
  },
];

/**
 * Tables named in the plan whose phase has not landed yet. Kept as data so the
 * gap is reviewable, and so enabling one later is moving a line rather than
 * rediscovering the intent.
 */
export const DEFERRED_TARGETS: readonly {
  readonly id: string;
  readonly reason: string;
}[] = [
  { id: 'mail-logs', reason: 'the mail log table arrives with its own phase' },
  {
    id: 'login-attempts',
    reason: 'login-attempt bookkeeping is not stored in its own table',
  },
];

/**
 * Resolves the policy against a configuration. Called once per run so a config
 * change takes effect without a rebuild, and so tests can pass their own ages.
 */
export function buildRetentionPolicy(
  ages: RetentionAges,
): readonly RetentionTarget[] {
  return RETENTION_TARGETS.map((target) => ({
    ...target,
    ageDays: resolveAgeDays(target.ageKey, ages),
  }));
}
