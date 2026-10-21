import { describe, expect, it } from 'vitest';

import { UnknownFieldError, UnsupportedFieldError } from './errors.js';
import { SearchFieldRegistry, type SearchField } from './field-registry.js';

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
    weight: 0.5,
    column: 'role',
  },
  age: {
    type: 'number',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0.2,
    column: 'age',
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

function registry(
  overrides: Record<string, SearchField> = {},
  defaultField = 'email',
): SearchFieldRegistry {
  return new SearchFieldRegistry({ ...fields, ...overrides }, { defaultField });
}

describe('SearchFieldRegistry', () => {
  it('answers with the descriptor of a field', () => {
    expect(registry().field('email')).toMatchObject({
      type: 'text',
      column: 'email',
    });
  });

  it('lists the fields it has, in the order they were declared', () => {
    expect(registry().names()).toEqual(['email', 'role', 'age', 'password']);
  });

  it('lists the columns it may put into SQL', () => {
    expect(registry().columns()).toEqual(['email', 'role', 'age', 'password']);
  });

  it('knows whether it has a field', () => {
    expect(registry().has('email')).toBe(true);
    expect(registry().has('nope')).toBe(false);
  });

  /**
   * The allow-list, and the reason it is one.
   *
   * **A field name is the client's input.** The only way it can reach SQL is by
   * being looked up here first, so an undeclared name has to be an error — and
   * the error has to list the names that do exist, because a client that typed
   * `emial` needs to be told that `email` is the name.
   */
  it('refuses a field it does not have, and lists the ones it does', () => {
    try {
      registry().field('emial');

      expect.unreachable('the field should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFieldError);
      expect((error as UnknownFieldError).field).toBe('emial');
      expect((error as UnknownFieldError).valid).toContain('email');
      expect((error as Error).message).toContain('email');
    }
  });

  it('never drops an unknown field silently', () => {
    // A dropped field is a filter the client believes is applied and is not,
    // and the result is a page of rows the client did not ask for.
    expect(() => registry().field('emial')).toThrow(UnknownFieldError);
  });

  it('resolves the default field when a query names none', () => {
    expect(registry().resolve(null)).toMatchObject({ column: 'email' });
  });

  it('refuses a field that is not searchable, for a match', () => {
    expect(() => registry().searchableField('age')).toThrow(
      UnsupportedFieldError,
    );
    expect(() => registry().searchableField('age')).toThrow(/not searchable/);
  });

  it('refuses a field that is not filterable, for a range', () => {
    expect(() => registry().filterableField('password')).toThrow(
      UnsupportedFieldError,
    );
  });

  it('allows a searchable field to be filtered', () => {
    expect(registry().filterableField('email')).toMatchObject({
      column: 'email',
    });
  });

  /**
   * The checks that catch a typo in a field map.
   *
   * **A field map is written once and read by every query**, so a typo in it
   * would otherwise be found by whichever client happened to search that field
   * first — which is the worst way to find it.
   */
  it('refuses a field name that is not an identifier', () => {
    expect(
      () =>
        new SearchFieldRegistry(
          { 'not a name': fields.email as SearchField },
          { defaultField: 'email' },
        ),
    ).toThrow(/not a field name/);
  });

  it('refuses a column that is not an identifier', () => {
    // The column is interpolated into SQL, so this is the check that keeps a
    // field map from being able to hand a client the database.
    expect(
      () =>
        new SearchFieldRegistry(
          {
            email: { ...fields.email, column: 'email" ; DROP TABLE users --' },
          },
          { defaultField: 'email' },
        ),
    ).toThrow(/not a column name/);
  });

  it('refuses a weight outside the range', () => {
    expect(
      () =>
        new SearchFieldRegistry(
          { email: { ...fields.email, weight: 10 } },
          { defaultField: 'email' },
        ),
    ).toThrow(/between 0 and 1/);
  });

  it('refuses a default field it does not have', () => {
    expect(() => registry({}, 'nope')).toThrow(/not one of the declared/);
  });

  it('is frozen, so a caller cannot add a field at runtime', () => {
    const subject = registry();

    expect(() => {
      (
        subject as unknown as {
          fields: Record<string, SearchField | undefined>;
        }
      ).fields['sneaky'] = fields.email;
    }).toThrow();
  });
});
