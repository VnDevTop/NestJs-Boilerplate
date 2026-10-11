import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * The client asked for an idempotent route without saying which request it was
 * retrying.
 *
 * A 400 rather than a 428 or a 422, because it is a malformed request: the header
 * is part of the request's shape and it is missing. The message names the header,
 * since a client that does not know it exists has no other way to find out.
 */
export class IdempotencyKeyRequiredError extends HttpException {
  constructor() {
    super(
      'This endpoint requires an Idempotency-Key header. Send a unique value ' +
        'with the request and reuse it when retrying.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Another request with the same key is still running.
 *
 * A 409, and not a wait. The alternative is to hold a connection open for work the
 * client cannot see and cannot cancel, and a client that times out waiting for a
 * 409-free answer will retry — which is the situation this whole feature exists to
 * survive. Answering now tells it the honest thing: it is too early, and the
 * answer is not available yet.
 *
 * The retry is safe. The key is the same one the running request holds, so when
 * that one finishes the retry gets its recorded answer rather than a second copy.
 */
export class IdempotencyInFlightError extends ConflictException {
  constructor() {
    super(
      'A request with this Idempotency-Key is still being processed. Retry ' +
        'with the same key once it completes.',
    );
  }
}
