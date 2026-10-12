import { registerAs } from '@nestjs/config';

/**
 * Permanent account lockout settings.
 *
 * Loaded with `ConfigModule.forFeature()` in `AuthModule`, for the same reason
 * `passwordPolicy` lives there: the rule belongs next to the endpoints that
 * enforce it.
 *
 * **These are Phase 19's second lockout, not a replacement for the first.**
 * `LoginLockoutService` from Phase 17a blocks in redis for a few minutes and
 * forgets. This one writes `users.lockedAt` and stays. The two answer different
 * questions: the temporary one slows an attack off, the permanent one ends a
 * sustained one.
 */
export interface AccountSecurityConfig {
  /**
   * Failed sign-ins, counted by `LoginLockoutService`, that lock an account
   * permanently.
   *
   * Well above the temporary threshold on purpose. At the same number the
   * permanent lock would fire on the attempt that also starts a temporary block,
   * and a block that starts and ends is an outage, not a lockout. A value at or
   * below the temporary threshold is treated as disabled, because at that point
   * the feature is just the Phase 17a lockout with extra steps.
   */
  permanentLockThreshold: number;
  /**
   * How long the failure count has to stay fresh for the above to apply.
   *
   * The count itself carries a one hour ttl, so this is not the window the count
   * lives in — it is how recent the *worst* attempt must be. A user who failed
   * five times last month and five times today is not the same as one who failed
   * ten times today.
   */
  permanentLockWindowHours: number;
  /** Hours an unlock link stays usable. */
  unlockTokenTtlHours: number;
}

export const accountSecurityConfig = registerAs(
  'accountSecurity',
  (): AccountSecurityConfig => ({
    permanentLockThreshold: Number(
      process.env.ACCOUNT_PERMANENT_LOCK_THRESHOLD ?? 20,
    ),
    permanentLockWindowHours: Number(
      process.env.ACCOUNT_PERMANENT_LOCK_WINDOW_HOURS ?? 24,
    ),
    unlockTokenTtlHours: Number(
      process.env.ACCOUNT_UNLOCK_TOKEN_TTL_HOURS ?? 24,
    ),
  }),
);

export const ACCOUNT_SECURITY = accountSecurityConfig.KEY;
