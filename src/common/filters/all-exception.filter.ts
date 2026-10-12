import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { ApiErrorResponse } from '../interfaces/index.js';
import { SentryService } from '../../core/sentry/index.js';
import { TracingService } from '../../core/tracing/index.js';
import { getRequestId } from '../utils/index.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    // Both default-constructed so a test that builds this filter with no
    // arguments still works, and so a deployment without `@sentry/node` or
    // `@opentelemetry/api` gets the no-op rather than a missing dependency.
    private readonly sentry: SentryService = new SentryService(),
    private readonly tracing: TracingService = new TracingService(),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const statusCode = HttpStatus.INTERNAL_SERVER_ERROR;

    this.logger.error(exception);

    // Reported here rather than in a controller: this filter is the one place
    // every unhandled exception passes through, including the ones from a queue
    // processor and a scheduled job that never touched a request at all.
    //
    // No rate limit is applied. What stops one bug producing ten thousand events
    // is Sentry's own sampling and its own grouping — not a limit invented here,
    // which would drop the events nobody wanted as reliably as the ones somebody
    // did.
    this.sentry.captureException(exception, {
      requestId: getRequestId(),
      traceId: this.tracing.currentTraceId(),
      // The route pattern, not `originalUrl` — see below.
      route: (request.route as { path?: string } | undefined)?.path ?? '',
      method: request.method,
      userId: (request as Request & { user?: { id?: string } }).user?.id,
    });

    const errorResponse: ApiErrorResponse = {
      success: false,
      statusCode,
      message: 'Internal server error',
      error: 'Internal Server Error',
      // The full url, because this is the response to the client that sent it and
      // the client already knows what it asked for. What goes to Sentry is the
      // route pattern instead — a reset link in the query string is a single-use
      // bearer credential and this response is not the place to repeat it.
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(errorResponse);
  }
}
