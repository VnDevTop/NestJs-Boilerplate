/**
 * Prefix on a stored recovery code digest, naming the derivation.
 *
 * Read back on verify, so an older `sha256$` value from a previous deployment
 * still works and ages out as codes are spent rather than needing a migration.
 */
export const HASH_PREFIX = 'scrypt';

/** The pre-scrypt format. Verified, never written. */
export const LEGACY_RECOVERY_HASH_PREFIX = 'sha256';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const TOTP_ALGORITHM = 'SHA1';

export const TOTP_MAX_FAILED_ATTEMPTS = 5;
export const TOTP_LOCK_MINUTES = 15;

export const TWO_FACTOR_CHALLENGE_TTL = '5m';
