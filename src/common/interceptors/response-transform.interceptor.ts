import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { PaginatedResultDto } from '../pagination/index.js';
import { ApiSuccessResponse } from '../interfaces/index.js';

@Injectable()
export class ResponseTransformInterceptor<TData> implements NestInterceptor<
  TData,
  ApiSuccessResponse<TData>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<TData>,
  ): Observable<ApiSuccessResponse<TData>> {
    return next.handle().pipe(
      map((data) => {
        // A file is the response body, not a value inside one. Enveloping it
        // would replace the stream with a JSON description of a stream, so the
        // route that sets `Content-Type: text/csv` would answer with JSON and
        // no file at all.
        if (data instanceof StreamableFile) {
          return data as unknown as ApiSuccessResponse<TData>;
        }

        // A page, lifted into the envelope. `data` becomes the array the route
        // always returned, so a client reading `data` needs no change, and `meta`
        // sits beside it rather than one level down inside a body it has to know
        // the shape of. Anything that is not a page is passed through untouched —
        // the interceptor has no opinion about the other routes.
        if (data instanceof PaginatedResultDto) {
          return {
            success: true as const,
            data: data.items as unknown as TData,
            meta: data.meta,
            timestamp: new Date().toISOString(),
          };
        }

        return {
          success: true as const,
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
