import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { buildCriteria, buildFromSource } from './build-criteria.js';
import type { QuerySpec } from './query-spec.js';

const SPEC = {
  filters: {
    role: { column: 'role', operator: 'eq' },
    isActive: { column: 'isActive', operator: 'eq' },
    email: { column: 'email', operator: 'ilike' },
    tags: { column: 'tags', operator: 'in', list: true },
  },
  sort: {
    createdAt: 'createdAt',
    email: 'email',
  },
  defaultSort: 'createdAt',
} as const satisfies QuerySpec;

describe('buildFromSource', () => {
  it('resolves each filter to its column and operator', () => {
    const criteria = buildFromSource({ filters: { role: 'admin' } }, SPEC);

    expect(criteria.filters).toEqual([
      { column: 'role', operator: 'eq', value: 'admin' },
    ]);
  });

  it('omits a filter the client did not ask for', () => {
    // Not applied as a comparison against null, which would match nothing and
    // turn an unfiltered list into an empty one.
    const criteria = buildFromSource({}, SPEC);

    expect(criteria.filters).toEqual([]);
  });

  it('omits a filter whose value is null', () => {
    const criteria = buildFromSource({ filters: { role: null } }, SPEC);

    expect(criteria.filters).toEqual([]);
  });

  it('keeps a false value, because false is a filter and not an absence', () => {
    const criteria = buildFromSource({ filters: { isActive: false } }, SPEC);

    expect(criteria.filters).toEqual([
      { column: 'isActive', operator: 'eq', value: false },
    ]);
  });

  it('keeps a zero, for the same reason', () => {
    const criteria = buildFromSource({ filters: { role: 0 } }, SPEC);

    expect(criteria.filters).toEqual([
      { column: 'role', operator: 'eq', value: 0 },
    ]);
  });

  it('applies the filters in the order the spec declares them', () => {
    // Two requests naming the same fields produce the same SQL, which makes the
    // query cacheable and the statement comparable between requests.
    const criteria = buildFromSource(
      { filters: { email: 'a', role: 'admin' } },
      SPEC,
    );

    expect(criteria.filters.map((filter) => filter.column)).toEqual([
      'role',
      'email',
    ]);
  });

  it('resolves the sort to its column', () => {
    const criteria = buildFromSource({ sort: 'email' }, SPEC);

    expect(criteria.sort).toEqual({ column: 'email', direction: 'DESC' });
  });

  it('sorts ascending when asked to', () => {
    const criteria = buildFromSource({ sort: 'email', order: 'asc' }, SPEC);

    expect(criteria.sort.direction).toBe('ASC');
  });

  it('sorts descending by default, because the newest thing is usually wanted', () => {
    const criteria = buildFromSource({}, SPEC);

    expect(criteria.sort).toEqual({ column: 'createdAt', direction: 'DESC' });
  });

  it('refuses a sort field that is not sortable', () => {
    // A fallback would answer a different question than the one asked, and a
    // client sorting by a field that does not exist would receive a valid page
    // ordered by something else and believe it got what it asked for.
    expect(() => buildFromSource({ sort: 'password' }, SPEC)).toThrow(
      BadRequestException,
    );
    expect(() => buildFromSource({ sort: 'password' }, SPEC)).toThrow(
      /createdAt, email/,
    );
  });

  it('refuses a sort field that tries to be a prototype key', () => {
    // `constructor` and `__proto__` are properties of every object, so a
    // lookup that does not check own properties would find them.
    for (const field of ['constructor', '__proto__', 'toString']) {
      expect(() => buildFromSource({ sort: field }, SPEC)).toThrow(
        BadRequestException,
      );
    }
  });

  it('refuses an unknown sort direction', () => {
    expect(() => buildFromSource({ order: 'sideways' }, SPEC)).toThrow(
      /asc.*desc/i,
    );
  });

  it('refuses a sort direction that is not a string', () => {
    expect(() => buildFromSource({ order: 7 }, SPEC)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a sort field that is not a string', () => {
    expect(() => buildFromSource({ sort: 7 }, SPEC)).toThrow(
      BadRequestException,
    );
  });

  it('clamps the page size rather than refusing it', () => {
    expect(buildFromSource({ limit: 999_999 }, SPEC).limit).toBe(100);
    expect(buildFromSource({ limit: 0 }, SPEC).limit).toBe(1);
    expect(buildFromSource({ limit: -5 }, SPEC).limit).toBe(1);
  });

  it('falls back to the default page size for a nonsense one', () => {
    expect(buildFromSource({ limit: Number.NaN }, SPEC).limit).toBe(20);
  });

  it('keeps a cursor that decodes', () => {
    const cursor = buildFromSource({}, SPEC).cursor;

    expect(cursor).toBeUndefined();
  });

  it('refuses a cursor that does not decode', () => {
    // A cursor that is ignored is a silent first page, and a silent first page
    // is a client that believes it asked for page four and was given page one.
    expect(() => buildFromSource({ cursor: 'not-a-cursor' }, SPEC)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a list filter given a scalar', () => {
    expect(() => buildFromSource({ filters: { tags: 'admin' } }, SPEC)).toThrow(
      /expects a list/,
    );
  });

  it('refuses a scalar filter given a list', () => {
    expect(() =>
      buildFromSource({ filters: { role: ['admin'] } }, SPEC),
    ).toThrow(/expects a single value/);
  });

  it('refuses an object as a filter value', () => {
    // An object cannot be bound as a comparison value, and postgres would
    // reject it with a message about a type it cannot coerce.
    expect(() =>
      buildFromSource({ filters: { role: { name: 'admin' } } }, SPEC),
    ).toThrow(/expects a simple value/);
  });

  it('accepts a list for a list filter', () => {
    const criteria = buildFromSource({ filters: { tags: ['a', 'b'] } }, SPEC);

    expect(criteria.filters).toEqual([
      { column: 'tags', operator: 'in', value: ['a', 'b'] },
    ]);
  });

  it('never lets a client-supplied name reach the criteria', () => {
    // The whole safety argument: by the time a filter exists, the request-facing
    // name has been replaced by the column it means.
    const criteria = buildFromSource(
      { filters: { password: 'hunter2' } },
      SPEC,
    );

    expect(criteria.filters).toEqual([]);
  });
});

describe('buildCriteria and criteriaSourceFrom', () => {
  it('reads the filter values off a DTO', () => {
    // The seam between a class and the record the builder reads.
    const dto = { limit: 5, cursor: undefined, role: 'admin' };

    const criteria = buildCriteria(dto, SPEC);

    expect(criteria.filters).toEqual([
      { column: 'role', operator: 'eq', value: 'admin' },
    ]);
    expect(criteria.limit).toBe(5);
  });

  it('reads no filter value from the prototype chain', () => {
    // `constructor` and `__proto__` are properties of every object, so a
    // lookup that walked the prototype would hand a filter a function.
    class Dto {
      role = 'admin';
    }

    const criteria = buildCriteria(new Dto(), SPEC);

    expect(criteria.filters).toEqual([
      { column: 'role', operator: 'eq', value: 'admin' },
    ]);
    expect(criteria.filters.some((filter) => filter.value !== 'admin')).toBe(
      false,
    );
  });

  it('reads no filter value for a field the DTO does not have', () => {
    const criteria = buildCriteria({ password: 'hunter2' }, SPEC);

    expect(criteria.filters).toEqual([]);
  });

  it('does not read a paging key as a filter value', () => {
    // A spec that declared a filter named `sort` would otherwise read the sort
    // *field name* as its value — a silent wrong answer rather than an error,
    // because the value would be a perfectly ordinary string.
    const criteria = buildCriteria({ sort: 'email' }, SPEC);

    expect(criteria.filters).toEqual([]);
    expect(criteria.sort.column).toBe('email');
  });
});
