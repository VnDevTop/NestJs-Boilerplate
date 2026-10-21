import { describe, expect, it } from 'vitest';

import { UnknownFieldError, UnsupportedFieldError } from '../errors.js';
import { SearchFieldRegistry, type SearchField } from '../field-registry.js';
import { parseSearchQuery } from '../parser.js';
import { translateToFacet } from './facet.js';

const fields: Record<string, SearchField> = {
  email: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 1,
    column: 'email',
  },
  role: {
    type: 'keyword',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.3,
    column: 'role',
  },
  isActive: {
    type: 'boolean',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0,
    column: 'isActive',
  },
  password: {
    type: 'text',
    searchable: false,
    filterable: false,
    sortable: false,
    weight: 0,
    column: 'password',
  },
};

const registry = new SearchFieldRegistry(fields, {
  defaultField: 'email',
  documentColumn: 'searchVector',
});

function facet(query: string, field: string, options = {}) {
  return translateToFacet(parseSearchQuery(query), registry, field, {
    table: 'users',
    ...options,
  });
}

describe('a facet', () => {
  it('counts the matching rows, grouped by the field', () => {
    const { sql } = facet('email:ada', 'role');

    expect(sql).toContain('SELECT "role" AS "value"');
    expect(sql).toContain('count(*)::int');
    expect(sql).toContain('GROUP BY "role"');
  });

  it('counts the same rows the results do', () => {
    const { sql } = facet('email:ada', 'role');

    // The facet is only true if it counted the rows the page is showing, so it
    // carries the very same filter.
    expect(sql).toContain('"searchVector" @@');
    expect(sql).toContain('WHERE');
  });

  it('binds the values rather than interpolating them', () => {
    const { sql, parameters } = facet('email:ada', 'role');

    expect(sql).not.toContain('ada');
    expect(Object.values(parameters)).toContain('ada');
  });

  it('names the table it counts', () => {
    const { sql } = facet('email:ada', 'role');

    expect(sql).toContain('FROM "users"');
  });

  it('aliases the table when there is one', () => {
    const { sql } = facet('email:ada', 'role', { alias: 'user' });

    expect(sql).toContain('FROM "users" "user"');
    expect(sql).toContain('"user"."role"');
  });

  it('orders the counts by how many there are', () => {
    const { sql } = facet('email:ada', 'role');

    expect(sql).toContain('ORDER BY "count" DESC');
  });

  it('refuses a table name that is not an identifier', () => {
    expect(() =>
      facet('email:ada', 'role', { table: 'users"; DROP TABLE users --' }),
    ).toThrow(/not a table name/);
  });

  it('refuses a field it does not have', () => {
    expect(() => facet('email:ada', 'nope')).toThrow(UnknownFieldError);
  });

  it('refuses a field that cannot be grouped by', () => {
    // A password is not a group: every row would be its own group.
    expect(() => facet('email:ada', 'password')).toThrow(UnsupportedFieldError);
  });
});
