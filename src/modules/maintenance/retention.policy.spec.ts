import { describe, expect, it } from 'vitest';

import { DEFAULT_AGES as DEFAULT_TEST_AGES } from '../../configs/retention.config.js';
import {
  DEFERRED_TARGETS,
  MINIMUM_AGE_DAYS,
  RETENTION_TARGETS,
  buildRetentionPolicy,
  resolveAgeDays,
  resolveCutoff,
} from './retention.policy.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');

function target(id: string) {
  const found = RETENTION_TARGETS.find((entry) => entry.id === id);

  if (!found) {
    throw new Error(`no target ${id}`);
  }

  return found;
}

describe('retention policy contents', () => {
  it('lists only tables that exist, so no nightly run fails on a missing table', () => {
    // mail_logs, login attempts and audit_logs are named in the plan but have no
    // table yet. If one were added here, every run would error at 3am on a table
    // that was never created.
    expect(RETENTION_TARGETS.map((t) => t.table).sort()).toEqual([
      'account_unlock_tokens',
      'email_verification_tokens',
      'notification_logs',
      'password_reset_tokens',
      'refresh_tokens',
      'user_devices',
      'users',
    ]);
  });

  it('keeps the deferred tables visible instead of forgetting them', () => {
    // `notification-logs` left this list in Phase 18, when its entity arrived. It is
    // named in the assertion rather than derived, so an entry that quietly reappears
    // is a failure rather than a no-op.
    expect(DEFERRED_TARGETS.map((t) => t.id)).toEqual([
      'mail-logs',
      'login-attempts',
      'audit-logs',
    ]);
  });

  it('cleans the notification log on its own age, since Phase 18 created the table', () => {
    // The log grows on every event on every channel, so it is the one table in this
    // list that a deployment without it would notice as unbounded growth.
    expect(target('notification-logs').ageKey).toBe('notificationLogs');
    expect(target('notification-logs').description).toContain('notification');
  });

  it('gives every target a unique id, since the id is what the admin API returns', () => {
    const ids = RETENTION_TARGETS.map((t) => t.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never lists two targets on the same table', () => {
    const tables = RETENTION_TARGETS.map((t) => t.table);

    expect(new Set(tables).size).toBe(tables.length);
  });

  it('records that deleting a user takes its children with it', () => {
    // Counted for reporting only. Verified against the real constraints in the
    // Phase 16 step 1 commit; if a cascade is ever dropped, this count lies.
    expect(target('users').cascades).toContain('refresh_tokens');
    expect(target('users').cascades).toContain('two_factor_secrets');
  });
});

describe('the minimum age guard', () => {
  it('floors an age at one day even when the config asks for zero', () => {
    expect(
      resolveAgeDays('refreshTokens', {
        ...DEFAULT_TEST_AGES,
        refreshTokens: 0,
      }),
    ).toBe(MINIMUM_AGE_DAYS);
  });

  it('floors a negative age instead of deleting everything that exists', () => {
    // The dangerous direction. A negative age puts the cutoff in the future, so
    // every row in the table matches.
    expect(
      resolveAgeDays('softDeletedUsers', {
        ...DEFAULT_TEST_AGES,
        softDeletedUsers: -1,
      }),
    ).toBe(MINIMUM_AGE_DAYS);
  });

  it('floors a fractional age rather than truncating it to zero', () => {
    expect(
      resolveAgeDays('mailLogs', { ...DEFAULT_TEST_AGES, mailLogs: 0.5 }),
    ).toBe(MINIMUM_AGE_DAYS);
  });

  it('rejects a non-numeric age rather than letting NaN through', () => {
    // NaN would make every comparison false and silently delete nothing, which
    // is a failure nobody notices because the logs still say the run succeeded.
    expect(
      resolveAgeDays('refreshTokens', {
        ...DEFAULT_TEST_AGES,
        refreshTokens: Number.NaN,
      }),
    ).toBe(MINIMUM_AGE_DAYS);
  });

  it('passes a valid age through untouched', () => {
    expect(
      resolveAgeDays('refreshTokens', {
        ...DEFAULT_TEST_AGES,
        refreshTokens: 7,
      }),
    ).toBe(7);
  });

  it('reports zero days for a rule that has no age, so it is not floored', () => {
    // The device rule is immediate by design. Flooring it to one day would
    // silently change the policy the plan describes.
    expect(resolveAgeDays(null, DEFAULT_TEST_AGES)).toBe(0);
  });

  it('leaves every target at or above the floor when built from a hostile config', () => {
    const hostile = {
      ...DEFAULT_TEST_AGES,
      softDeletedUsers: 0,
      refreshTokens: -99,
      emailVerificationTokens: Number.NaN,
    };
    const policy = buildRetentionPolicy(hostile);

    for (const entry of policy) {
      if (entry.ageKey !== null) {
        expect(entry.ageDays).toBeGreaterThanOrEqual(MINIMUM_AGE_DAYS);
      }
    }
  });
});

describe('resolveCutoff', () => {
  it('moves the cutoff back by whole days', () => {
    expect(resolveCutoff(7, NOW).toISOString()).toBe(
      '2026-09-26T12:00:00.000Z',
    );
  });

  it('puts the cutoff at now for an immediate rule', () => {
    expect(resolveCutoff(0, NOW).toISOString()).toBe(NOW.toISOString());
  });
});

describe('the users rule', () => {
  it('only matches rows that were actually soft deleted', () => {
    // Without the IS NOT NULL check, every live user would match, because
    // `NULL < cutoff` is NULL, and a NULL row is not selected -- but dropping the
    // clause would make the intent invisible and the predicate unsafe to reuse.
    expect(target('users').buildPredicate(resolveCutoff(30, NOW))).toContain(
      '"deletedAt" IS NOT NULL',
    );
  });

  it('carries the cutoff into the comparison', () => {
    expect(target('users').buildPredicate(resolveCutoff(30, NOW))).toContain(
      '"deletedAt" < \'2026-09-03T12:00:00.000Z\'',
    );
  });
});

describe('the email verification token rule', () => {
  it('waits for expiry rather than for creation', () => {
    const sql = target('email-verification-tokens').buildPredicate(
      resolveCutoff(7, NOW),
    );

    expect(sql).toContain('"expiresAt" <');
    expect(sql).not.toContain('"createdAt" <');
  });

  it('does not require the token to have been used', () => {
    // An issued-but-never-used token is exactly what should be collected once it
    // expires. Requiring usedAt would let abandoned signups accumulate forever.
    expect(
      target('email-verification-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).not.toContain('"usedAt"');
  });
});

describe('the password reset token rule', () => {
  it('collects a token that was used, even if it has not expired yet', () => {
    // This is the branch that actually fires in practice: a used token has
    // served its purpose but may still be inside its expiry window.
    expect(
      target('password-reset-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).toContain('"usedAt" IS NOT NULL');
  });

  it('collects an expired token that was never used', () => {
    expect(
      target('password-reset-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).toContain('"expiresAt" <');
  });

  it('joins the two branches, rather than requiring both', () => {
    // Requiring both would keep an expired-but-unused token forever.
    expect(
      target('password-reset-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).toContain(') OR (');
  });
});

describe('the refresh token rule', () => {
  it('collects a revoked token once the grace period passes', () => {
    expect(
      target('refresh-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).toContain('"revokedAt" IS NOT NULL');
  });

  it('collects an expired token that was never revoked', () => {
    expect(
      target('refresh-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).toContain('"expiresAt" <');
  });

  it('never collects a live token, whatever its age', () => {
    // The dangerous mistake is dropping the IS NOT NULL guard and letting
    // `"revokedAt" < cutoff` stand alone. That still would not match a live
    // token, because `NULL < cutoff` is NULL rather than true, but it stops
    // meaning "revoked and long enough ago" and starts depending on three-valued
    // logic to stay safe. Asserted as guard-immediately-before-comparison so the
    // two halves cannot drift apart.
    const sql = target('refresh-tokens').buildPredicate(resolveCutoff(7, NOW));

    expect(sql).toContain('"revokedAt" IS NOT NULL AND "revokedAt" <');
    expect(sql).toContain('"expiresAt" <');
  });

  it('does not compare createdAt, so a token cannot be collected before it expires', () => {
    expect(
      target('refresh-tokens').buildPredicate(resolveCutoff(7, NOW)),
    ).not.toContain('"createdAt"');
  });
});

describe('the user device rule', () => {
  const sql = target('user-devices').buildPredicate(resolveCutoff(0, NOW));

  it('keeps a device that still holds a live token', () => {
    expect(sql).toContain('rt."revokedAt" IS NULL');
    expect(sql).toContain('rt."expiresAt" > now()');
  });

  it('links the token to the device by device id', () => {
    expect(sql).toContain('rt."deviceId" = d."id"');
  });

  it('aliases the device row so the subquery can refer to it', () => {
    // The service emits `DELETE FROM "user_devices" d WHERE ...`, so `d` has to
    // exist. Without the alias this reads as a valid rule and matches nothing.
    expect(sql).toContain('d."id"');
  });

  it('has no cutoff, because it is immediate', () => {
    expect(sql).not.toContain(NOW.toISOString());
  });

  it('ignores the cutoff it is handed', () => {
    // A 30-day-old cutoff must not widen this rule; that is the device rule's
    // own age key's business, and it has none.
    expect(target('user-devices').buildPredicate(resolveCutoff(999, NOW))).toBe(
      sql,
    );
  });

  it('declares no age key, which is how it stays immediate', () => {
    expect(target('user-devices').ageKey).toBeNull();
  });

  it('still cascades with the user delete, which is the other way devices go', () => {
    expect(target('users').cascades).toContain('user_devices');
  });
});

describe('buildRetentionPolicy', () => {
  it('does not mutate the exported template', () => {
    // RETENTION_TARGETS is module level. Resolving ages onto it would make one
    // run's configuration leak into the next run's defaults.
    buildRetentionPolicy({ ...DEFAULT_TEST_AGES, refreshTokens: 99 });

    expect(
      RETENTION_TARGETS.find((t) => t.id === 'refresh-tokens')?.ageDays,
    ).toBe(0);
  });

  it('resolves each age from the config by its key', () => {
    const policy = buildRetentionPolicy(DEFAULT_TEST_AGES);

    expect(policy.find((t) => t.id === 'users')?.ageDays).toBe(30);
    expect(policy.find((t) => t.id === 'refresh-tokens')?.ageDays).toBe(7);
    expect(policy.find((t) => t.id === 'password-reset-tokens')?.ageDays).toBe(
      7,
    );
    expect(policy.find((t) => t.id === 'user-devices')?.ageDays).toBe(0);
  });

  it('preserves the predicates it did not touch', () => {
    const policy = buildRetentionPolicy(DEFAULT_TEST_AGES);

    expect(policy.map((t) => t.buildPredicate)).toEqual(
      RETENTION_TARGETS.map((t) => t.buildPredicate),
    );
  });

  it('produces a cutoff that reaches back exactly the configured age', () => {
    const policy = buildRetentionPolicy(DEFAULT_TEST_AGES);
    const users = policy.find((t) => t.id === 'users');

    expect(
      users?.buildPredicate(resolveCutoff(users?.ageDays ?? 0, NOW)),
    ).toContain('2026-09-03T12:00:00.000Z');
  });
});
