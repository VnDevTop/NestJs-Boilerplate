import { registerAs } from '@nestjs/config';

/**
 * Session lifetime settings.
 *
 * Loaded with `ConfigModule.forFeature()` in `AuthModule`, for the same reason
 * `passwordPolicy` and `accountSecurity` live there: the rule belongs next to
 * the endpoint that enforces it, and this one is enforced in exactly one place.
 *
 * **What a refresh token already bounds, and what it does not.**
 * `JWT_REFRESH_EXPIRES_IN` is a *sliding* window. Every rotation issues a fresh
 * token with a fresh expiry, so a client that refreshes before it lapses keeps
 * one session alive indefinitely — there is no count of rotations anywhere that
 * would stop it. This namespace is where a bound that rotation cannot slide past
 * goes.
 */
export interface SessionConfig {
  /**
   * Hard ceiling on how long one session may live, in seconds.
   *
   * Counted from the session's first token, not from the one being presented, so
   * the clock does not move as the session is used. Checked when a refresh token
   * is exchanged, which is the only moment a session is extended — between
   * refreshes the access token expires on its own in minutes.
   *
   * Zero disables it. `JWT_REFRESH_EXPIRES_IN` still applies either way, and it is
   * almost always the shorter of the two, which is why a value much beyond seven
   * days buys nothing without this setting.
   */
  absoluteTtlSeconds: number;
}

export const sessionConfig = registerAs('session', (): SessionConfig => ({
  absoluteTtlSeconds: Number(
    process.env.SESSION_ABSOLUTE_TTL_SECONDS ?? 30 * 24 * 60 * 60,
  ),
}));

export const SESSION = sessionConfig.KEY;
