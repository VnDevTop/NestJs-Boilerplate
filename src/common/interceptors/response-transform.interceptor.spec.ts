import { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { describe, expect, it } from 'vitest';

import { ResponseTransformInterceptor } from './response-transform.interceptor.js';
import { PaginatedResultDto } from '../pagination/index.js';

/**
 * Run the interceptor's `map` over a value, without building an HTTP context.
 *
 * The interceptor reads nothing from the context, so a real one would only prove
 * that `ExecutionContext` can be faked.
 */
function wrap(value: unknown) {
  const interceptor = new ResponseTransformInterceptor();
  const next = { handle: () => of(value) };

  return firstValueFrom(
    interceptor.intercept({} as ExecutionContext, next as never),
  );
}

describe('ResponseTransformInterceptor', () => {
  it('envelopes an ordinary body exactly as before', async () => {
    const result = await wrap({ id: 'u1' });

    expect(result.data).toEqual({ id: 'u1' });
    expect(result.success).toBe(true);
    expect(result.timestamp).toBeDefined();
  });

  it('leaves a non-paginated response with no meta at all', async () => {
    const result = await wrap([{ id: 'u1' }]);

    // Absent rather than null, so a client cannot read "no cursor" as "no
    // results" on a route that was never paginated.
    expect('meta' in result).toBe(false);
  });

  it('lifts a page’s meta to the top of the envelope', async () => {
    const result = await wrap(
      PaginatedResultDto.of([{ id: 'u1' }], {
        limit: 20,
        hasMore: true,
        nextCursor: 'abc',
      }),
    );

    // The items stay where a client already reads them, so `data` needs no
    // change and only the paging answer is new.
    expect(result.data).toEqual([{ id: 'u1' }]);
    expect(result.meta).toEqual({
      limit: 20,
      hasMore: true,
      nextCursor: 'abc',
    });
  });

  it('keeps a page with nothing after it honest', async () => {
    const result = await wrap(
      PaginatedResultDto.of([], {
        limit: 20,
        hasMore: false,
        nextCursor: null,
      }),
    );

    expect(result.data).toEqual([]);
    expect(result.meta?.hasMore).toBe(false);
    expect(result.meta?.nextCursor).toBeNull();
  });
});
