import { describe, expect, it } from 'vitest';

import {
  defineQuerySpec,
  type FilterKeys,
} from '../../../common/query/index.js';
import { ListUsersQueryDto } from './list-users-query.dto.js';
import { USER_QUERY_SPEC } from './user-query.js';

/**
 * The compile-time guarantee, checked at runtime.
 *
 * `defineQuerySpec<ListUsersQueryDto>` makes the filter keys exactly the DTO's
 * filterable properties. TypeScript enforces it — a filter the DTO does not
 * declare, or a DTO property no filter declares, is a compile error. This file
 * cannot prove a compile error, so it proves the *runtime* half of the same
 * fact: the spec's keys and the DTO's keys are the same set, and the sort map's
 * keys are the columns the route offers.
 */

/** The DTO's own properties, minus the paging ones and the derived getter. */
function filterableProperties(): string[] {
  return Object.keys(new ListUsersQueryDto()).filter(
    (key) =>
      !['limit', 'cursor', 'sort', 'order', 'effectiveLimit'].includes(key),
  );
}

describe('the user query spec', () => {
  it('declares a filter for every filterable property of the DTO', () => {
    // A property here that no filter declares is a parameter the client can send
    // and the route ignores — a client told a lie with nothing saying so.
    expect(Object.keys(USER_QUERY_SPEC.filters).sort()).toEqual(
      filterableProperties().sort(),
    );
  });

  it('declares a filter for no property the DTO does not have', () => {
    // A filter the DTO does not declare could never arrive: the global
    // validation pipe strips a parameter the DTO does not name. It would be a
    // filter that can never fire.
    for (const field of Object.keys(USER_QUERY_SPEC.filters)) {
      expect(filterableProperties()).toContain(field);
    }
  });

  it('sorts by columns that are never null', () => {
    // A cursor carries its boundary as a string, and `null` would have to be
    // encoded as something the decoder reads as malformed.
    for (const column of Object.values(USER_QUERY_SPEC.sort)) {
      expect(column).not.toBe('lockedAt');
      expect(column).not.toBe('lastLoginAt');
      expect(column).not.toBe('emailVerifiedAt');
      expect(column).not.toBe('deletedAt');
    }
  });

  it('defaults to a sort it actually offers', () => {
    expect(Object.keys(USER_QUERY_SPEC.sort)).toContain(
      USER_QUERY_SPEC.defaultSort,
    );
  });

  it('offers no sort field that is also a filter for a different column', () => {
    // The two maps are separate objects, and a field in both must mean the same
    // column in both. A mismatch would sort by one column and filter by
    // another, which reads as a bug in the query rather than in the spec.
    for (const [field, column] of Object.entries(USER_QUERY_SPEC.sort)) {
      const filter = (
        USER_QUERY_SPEC.filters as Record<string, { column: string }>
      )[field];

      if (filter) {
        expect(filter.column).toBe(column);
      }
    }
  });
});

describe('defineQuerySpec', () => {
  it('keeps the spec it was given', () => {
    const spec = defineQuerySpec<{ role?: string }>({
      filters: { role: { column: 'role', operator: 'eq' } },
      sort: { createdAt: 'createdAt' },
      defaultSort: 'createdAt',
    });

    expect(spec.filters.role).toEqual({ column: 'role', operator: 'eq' });
    expect(spec.defaultSort).toBe('createdAt');
  });

  it('names the DTO properties a spec may filter on', () => {
    // The exclusion is by name, so a DTO that adds a paging property does not
    // have to be told about it here.
    type Keys = FilterKeys<{
      limit: number;
      cursor?: string;
      sort?: string;
      order?: string;
      effectiveLimit: number;
      role?: string;
    }>;

    const keys: Keys[] = ['role'];

    expect(keys).toEqual(['role']);
  });
});
