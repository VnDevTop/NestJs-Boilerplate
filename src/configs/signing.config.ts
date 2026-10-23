import { registerAs } from '@nestjs/config';

/**
 * Clock skew tolerance (in milliseconds).
 * Allows the receiver's clock to differ slightly from the sender's.
 */
const CLOCK_SKEW = 120_000; // 2 minutes

/** Maximum age (in milliseconds) for a signed payload.
 *  Older payloads are rejected to prevent replay attacks. */
const MAX_AGE = 600_000; // 10 minutes

export interface SigningConfig {
  clockSkew: number;
  maxAge: number;
}

export const signingConfig = registerAs('signing', (): SigningConfig => ({
  clockSkew: Number(process.env.SIGNING_CLOCK_SKEW ?? CLOCK_SKEW),
  maxAge: Number(process.env.SIGNING_MAX_AGE ?? MAX_AGE),
}));
