import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Module,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, finalize, tap, throwError } from 'rxjs';

import { TracingService } from './tracing.service.js';

/**
 * One span per request, and it is the root of everything below.
 *
 * A span per request is what makes `traceId` on a log line mean anything: without
 * one, the id belongs to whatever span happened to be active when the line was
 * written, which in a plain Nest handler is none. With one, every log line, query
 * and job under that request shares an id.
 *
 * **Attributes are the ones an operator filters on** when a request is slow and
 * they need to find the ten that look like it. Nothing user-supplied beyond the
 * method and the route pattern — `/users/:id` is one series, `/users/8f1c…` is
 * one series per user, which is a cardinality bomb in a store with a different
 * retention policy to the database.
 *
 * `finalize` rather than `tap` for the end, because a handler that throws, one
 * that completes, and one that is cancelled downstream all have to close the span
 * and only `finalize` runs for all three. A span that is opened and not closed on
 * the error path is a leak that shows up as a trace that never finishes.
 */
@Injectable()
export class HttpTracingInterceptor implements NestInterceptor {
  constructor(private readonly tracing: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      route?: { path?: string };
      url: string;
    }>();
    const response = http.getResponse<{ statusCode: number }>();

    const span = this.tracing.startSpan('http.request', {
      'http.request.method': request.method,
      'http.route': request.route?.path ?? request.url.split('?')[0] ?? '',
    });

    return next.handle().pipe(
      tap(() => {
        if (!span.isRecording()) {
          return;
        }

        span.setAttribute('http.response.status_code', response.statusCode);

        // A 4xx or 5xx on an otherwise successful span is invisible: OpenTelemetry
        // only marks a span failed when it is told, and a returned `HttpException`
        // is a return. Without this the dashboard says everything is fine while
        // every request is being rejected.
        if (response.statusCode >= 400) {
          span.setStatus({
            code: this.tracing.errorCode(),
            message: `HTTP ${response.statusCode}`,
          });
        }
      }),
      catchError((error: unknown) => {
        span.recordException(error);

        return throwError(() => error);
      }),
      finalize(() => span.end()),
    );
  }
}

@Module({
  providers: [TracingService, HttpTracingInterceptor],
  exports: [TracingService, HttpTracingInterceptor],
})
export class TracingModule {}
