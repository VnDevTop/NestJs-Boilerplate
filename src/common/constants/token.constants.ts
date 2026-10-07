/**
 * Password reset and email verification token settings.
 *
 * The byte counts are entropy, not length: 32 bytes is 256 bits, so the token
 * cannot be guessed and does not need to be long enough for a human to type,
 * because the user pastes a link rather than reading a code.
 */

export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

/**
 * A verification token lives longer than a reset token, because losing an
 * address on a signup is a dead end for the user while a reset link is a
 * request they can repeat.
 */
export const EMAIL_VERIFICATION_TOKEN_BYTES = 32;
export const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 24;

/**
 * Limits on the routes that send mail.
 *
 * Two buckets per route, because the two attack shapes are different. The
 * per-address one stops an attacker who has someone's address from draining that
 * mailbox; the per-ip one stops an attacker spraying many addresses from one
 * host, which a per-address limit cannot see.
 */
export const MAIL_THROTTLE = {
  /** Per requested address: at most this many mails per hour. */
  perEmailPerHour: 3,
  /** Per client address: at most this many requests per hour across addresses. */
  perIpPerHour: 10,
  /** One hour, in milliseconds. */
  windowMs: 60 * 60 * 1000,
} as const;

/** The throttler name the per-address bucket is declared under. */
export const MAIL_EMAIL_BUCKET = 'mail-email';

/** Both buckets for an endpoint that sends mail: per client, then per address. */
export const mailThrottleOptions = () => ({
  default: { limit: MAIL_THROTTLE.perIpPerHour, ttl: MAIL_THROTTLE.windowMs },
  [MAIL_EMAIL_BUCKET]: {
    limit: MAIL_THROTTLE.perEmailPerHour,
    ttl: MAIL_THROTTLE.windowMs,
  },
});

/**
 * Limits for the routes that accept a credential.
 *
 * Two buckets per route, keyed differently for the same reason as the mail
 * buckets: a per-client limit cannot see an attacker with many addresses, and a
 * per-address limit cannot see an attacker spraying accounts from one host.
 * Both have to pass, so neither attack works.
 *
 * The per-address limit is the tighter of the two on login. That is deliberate
 * and it is not the same as the mail bucket's reasoning: here the target is the
 * password rather than the mailbox, and an attacker guessing one account wants
 * few attempts against that account, not many attempts against many.
 *
 * Five minutes rather than an hour because a block that lasts an hour on a login
 * nobody can get through is indistinguishable from a broken application.
 */
export const AUTH_THROTTLE = {
  /** Per client address: attempts per window from one host. */
  perIp: 20,
  /** Per submitted address: attempts per window against one account. */
  perEmail: 10,
  /** Per client address on refresh: a rotation storm is a bug or an attack. */
  refreshPerIp: 60,
  /** Five minutes, in milliseconds. */
  windowMs: 5 * 60 * 1000,
  /** One minute, in milliseconds, for refresh. */
  refreshWindowMs: 60 * 1000,
} as const;

/** The throttler name the per-address login bucket is declared under. */
export const LOGIN_EMAIL_BUCKET = 'login-email';

/** The throttler name the per-client login bucket is declared under. */
export const LOGIN_IP_BUCKET = 'login-ip';

/** The throttler name the refresh bucket is declared under. */
export const REFRESH_BUCKET = 'refresh';
