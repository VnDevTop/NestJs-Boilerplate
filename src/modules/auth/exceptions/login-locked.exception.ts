import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A 429 for an account that is temporarily blocked after failed sign-ins.
 *
 * Carries the wait so `HttpExceptionFilter` can set `Retry-After`. The number is
 * not in the response body: telling a caller exactly how long its guess has left
 * hands an attacker a progress bar, and the header is enough for a client to
 * wait and retry on its own.
 *
 * The message deliberately does not say the account exists. A 429 that only ever
 * appeared for real accounts would answer the enumeration question that
 * `enumeration.spec.ts` works to keep closed.
 */
export class LoginLockedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      'Too many failed sign-in attempts. Try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
