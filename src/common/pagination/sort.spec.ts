import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { resolveSort, type SortFieldMap } from './sort.js';

/**
 * A stand-in for a route's sortable columns.
 *
 * Two entries, so the tests can tell "the allow-list was consulted" apart from
 * "anything was accepted".
 */
const FIELDS = {
  createdAt: 'createdAt',
  email: 'email',
} as const satisfies SortFieldMap<'createdAt' | 'email'>;

describe('resolveSort', () => {
  it('falls back to the route default when no field is asked for', () => {
    expect(resolveSort(undefined, undefined, FIELDS, 'createdAt')).toEqual({
      field: 'createdAt',
      column: 'createdAt',
      direction: 'DESC',
    });
  });

  it('resolves a declared field to its column', () => {
    expect(resolveSort('email', 'asc', FIELDS, 'createdAt')).toEqual({
      field: 'email',
      column: 'email',
      direction: 'ASC',
    });
  });

  it('accepts a direction in any case', () => {
    expect(resolveSort('email', 'ASC', FIELDS, 'createdAt').direction).toBe(
      'ASC',
    );
    expect(
      resolveSort('email', '  Desc  ', FIELDS, 'createdAt').direction,
    ).toBe('DESC');
  });

  it('refuses an undeclared field and names the ones that are valid', () => {
    // Silently dropping it would answer a different question than the one asked: a
    // client sorting by an unknown column would get a valid page in some other
    // order and believe it got what it asked for.
    expect(() =>
      resolveSort('password', undefined, FIELDS, 'createdAt'),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveSort('password', undefined, FIELDS, 'createdAt'),
    ).toThrow(/createdAt, email/);
  });

  it('refuses an injection attempt in the field name', () => {
    // Sorting by a client-supplied name is injection under a different spelling —
    // an identifier cannot be a bound parameter, so anything interpolated is a
    // hole. `hasOwnProperty` is what closes it: a prototype key such as
    // `constructor` must not resolve to a function and become a column name.
    expect(() =>
      resolveSort('email; DROP TABLE users--', undefined, FIELDS, 'createdAt'),
    ).toThrow(BadRequestException);

    expect(() =>
      resolveSort('constructor', undefined, FIELDS, 'createdAt'),
    ).toThrow(BadRequestException);

    expect(() =>
      resolveSort('__proto__', undefined, FIELDS, 'createdAt'),
    ).toThrow(BadRequestException);
  });

  it('refuses a direction it does not recognise', () => {
    expect(() => resolveSort('email', 'sideways', FIELDS, 'createdAt')).toThrow(
      /asc.*desc/i,
    );
  });

  it('never returns a column the route did not declare', () => {
    const resolved = resolveSort('email', 'desc', FIELDS, 'createdAt');

    expect(Object.keys(FIELDS)).toContain(resolved.column);
  });
});
