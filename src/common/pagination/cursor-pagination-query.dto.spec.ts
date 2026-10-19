import { plainToInstance } from 'class-transformer';

import { describe, expect, it } from 'vitest';

import { CursorPaginationQueryDto } from './cursor-pagination-query.dto.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../constants/index.js';

describe('CursorPaginationQueryDto', () => {
  it('defaults to twenty rows and newest first', () => {
    const dto = plainToInstance(CursorPaginationQueryDto, {});

    expect(dto.effectiveLimit).toBe(DEFAULT_LIMIT);
    expect(dto.sort).toBeUndefined();
    expect(dto.order).toBeUndefined();
  });

  it('clamps rather than refusing a client that asks for too much', () => {
    // A 400 here would teach a client that the route is fragile, when the request
    // is merely careless. The clamp is the enforcement; the validator is advisory.
    const dto = plainToInstance(CursorPaginationQueryDto, { limit: '100000' });

    expect(dto.effectiveLimit).toBe(MAX_LIMIT);
  });

  it('refuses a limit that is not a number at all', () => {
    const dto = plainToInstance(CursorPaginationQueryDto, { limit: 'lots' });

    // `NaN` fails `@IsInt`, and the fallback keeps it from reaching a query even
    // when the validation pipe is not in the way — a unit test, or a service
    // calling another in-process.
    expect(dto.effectiveLimit).toBe(DEFAULT_LIMIT);
  });

  it('truncates a fractional limit instead of asking for a fractional row count', () => {
    const dto = plainToInstance(CursorPaginationQueryDto, { limit: '10.7' });

    expect(dto.effectiveLimit).toBe(10);
  });

  it('lower-cases the sort direction so ?order=ASC works', () => {
    const dto = plainToInstance(CursorPaginationQueryDto, { order: 'ASC' });

    expect(dto.order).toBe('asc');
  });

  it('leaves an absent cursor absent rather than an empty string', () => {
    const dto = plainToInstance(CursorPaginationQueryDto, {});

    // `''` and `undefined` mean the same thing to the decoder, but only one of
    // them survives a round trip through a log line or a cache key.
    expect(dto.cursor).toBeUndefined();
  });
});
