import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
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
