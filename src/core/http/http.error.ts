/**
 * Header name used to propagate the incoming request id to outbound calls.
 *
 * A third party that receives an outbound call with this header can quote it
 * back when reporting a failure, so operator and vendor logs can be correlated.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Error taxonomy for outbound HTTP calls.
 *
 * Every call site that talks to a third party classifies its failures into one
 * of these three categories, so retry logic lives in one place rather than
 * being invented per call site:
 *
 * - `retryable` — transient network or server failures (5xx, ECONNREFUSED,
 *   ETIMEDOUT). Retrying makes sense.
 * - `permanent` — client errors (4xx) that will not change on retry. Do not
 *   retry; log and move on.
 * - `throttled` — rate-limit responses (429). Retry after the delay the
 *   server asks for, if any.
 */
export enum HttpErrorType {
  Retryable = 'retryable',
  Permanent = 'permanent',
  Throttled = 'throttled',
}

/**
 * Base error for classified outbound HTTP failures.
 */
export class HttpError extends Error {
  readonly type: HttpErrorType;
  readonly status?: number;

  constructor(message: string, type: HttpErrorType, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.type = type;
    this.status = status;
  }
}

/**
 * Transient failure worth retrying.
 */
export class HttpRetryableError extends HttpError {
  constructor(message: string, status?: number) {
    super(message, HttpErrorType.Retryable, status);
    this.name = 'HttpRetryableError';
  }
}

/**
 * Client error that will not change on retry.
 */
export class HttpPermanentError extends HttpError {
  constructor(message: string, status?: number) {
    super(message, HttpErrorType.Permanent, status);
    this.name = 'HttpPermanentError';
  }
}

/**
 * Rate-limited response; retry after the server's delay if provided.
 */
export class HttpThrottledError extends HttpError {
  constructor(message: string, status?: number, retryAfter?: number) {
    super(message, HttpErrorType.Throttled, status);
    this.name = 'HttpThrottledError';
    this.retryAfter = retryAfter;
  }

  readonly retryAfter?: number;
}

/**
 * Classifies an axios error into the taxonomy, defaulting to retryable for
 * network failures and permanent for 4xx client errors.
 */
export function classifyHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof Error) {
    // Axios network failures carry a code.
    const code = (error as { code?: string }).code;
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET'
    ) {
      return new HttpRetryableError(error.message);
    }

    // Axios response errors carry a status.
    const status = (error as { status?: number }).status;
    if (status !== undefined) {
      if (status === 429) {
        return new HttpThrottledError(error.message, status);
      }
      if (status >= 400 && status < 500) {
        return new HttpPermanentError(error.message, status);
      }
      if (status >= 500) {
        return new HttpRetryableError(error.message, status);
      }
    }

    return new HttpRetryableError(error.message);
  }

  return new HttpRetryableError(String(error));
}
