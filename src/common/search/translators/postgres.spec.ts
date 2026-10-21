import { describe, expect, it } from 'vitest';

import {
  InvalidSearchValueError,
  UnknownFieldError,
  UnsupportedFieldError,
  UnsupportedOperationError,
} from '../errors.js';
import { SearchFieldRegistry, type SearchField } from '../field-registry.js';
import { parseSearchQuery } from '../parser.js';
import { translateToSql } from './postgres.js';

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
    weight: 0.6,
    column: 'role',
  },
  age: {
    type: 'number',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.2,
    column: 'age',
  },
  createdAt: {
    type: 'date',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0.3,
    column: 'createdAt',
  },
  isActive: {
    type: 'boolean',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.1,
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

const registry = new SearchFieldRegistry(fields, { defaultField: 'email' });

/** The SQL and the parameters a query becomes. */
function translate(
  query: string,
  alias?: string,
): { sql: string; parameters: Record<string, unknown> } {
  return translateToSql(parseSearchQuery(query), registry, { alias });
}

describe('the SQL a query becomes', () => {
  it('names the column the registry declares', () => {
    expect(translate('email:ada').sql).toBe('"email" ILIKE :p0 ESCAPE \'\\\'');
  });

  it('qualifies the column with the alias when there is one', () => {
    // An unqualified column is ambiguous the moment the query joins a second
    // table, which is exactly what a future route on the same entity will do.
    expect(translate('email:ada', 'user').sql).toContain('"user"."email"');
  });

  it('refuses an alias that is not an identifier', () => {
    // The alias is interpolated into SQL, exactly like a column.
    expect(() => translate('email:ada', 'user"; DROP TABLE users --')).toThrow(
      /not a table alias/,
    );
  });

  it('matches a text term as a substring', () => {
    const { sql, parameters } = translate('email:ada');

    expect(sql).toContain('ILIKE');
    expect(parameters['p0']).toBe('%ada%');
  });

  it('compares a keyword for equality', () => {
    const { sql, parameters } = translate('role:admin');

    expect(sql).toContain('= :p0');
    expect(parameters['p0']).toBe('admin');
  });

  it('compares a number as a number', () => {
    const { parameters } = translate('age:36');

    expect(parameters['p0']).toBe(36);
  });

  it('compares a date as a date', () => {
    // Quoted, because a bare value with colons in it is not one value — the
    // quotes are how a value with a colon or a space is written.
    const { parameters } = translate('createdAt:"2026-01-01T00:00:00Z"');

    expect(parameters['p0']).toBeInstanceOf(Date);
  });

  it('compares a boolean as a boolean', () => {
    const { parameters } = translate('isActive:true');

    expect(parameters['p0']).toBe(true);
  });

  it('matches a phrase as a substring of the whole value', () => {
    const { parameters } = translate('email:"ada lovelace"');

    expect(parameters['p0']).toBe('%ada lovelace%');
  });

  it('turns a wildcard into a LIKE pattern', () => {
    const { parameters } = translate('email:ada*');

    expect(parameters['p0']).toBe('ada%');
  });

  it('tests a field for having a value', () => {
    expect(translate('email:*').sql).toBe('"email" IS NOT NULL');
  });

  it('compares a range with its bounds', () => {
    const { sql, parameters } = translate('age:[18 TO 65]');

    expect(sql).toContain('>= :p0');
    expect(sql).toContain('<= :p1');
    expect(parameters['p0']).toBe(18);
    expect(parameters['p1']).toBe(65);
  });

  it('compares an exclusive range with its bounds', () => {
    const { sql } = translate('age:{18 TO 65}');

    expect(sql).toContain('> :p0');
    expect(sql).toContain('< :p1');
  });

  it('compares one side of a range only', () => {
    const { sql, parameters } = translate('age:>18');

    expect(sql).toContain('> :p0');
    expect(sql).not.toContain('<=');
    expect(parameters['p0']).toBe(18);
  });

  it('combines the boolean operators', () => {
    expect(translate('email:a AND role:admin').sql).toContain(' AND ');
    expect(translate('email:a OR role:admin').sql).toContain(' OR ');
    expect(translate('NOT role:admin').sql).toContain('NOT (');
  });

  it('parenthesises the boolean operators', () => {
    // A binary tree has to be parenthesised to keep its grouping: without the
    // brackets, `a OR b AND c` and `a OR (b AND c)` are the same string.
    const { sql } = translate('email:a OR role:admin AND age:30');

    expect(sql.startsWith('(')).toBe(true);
    expect(sql).toContain(' OR (');
  });

  it('matches everything when the query is empty', () => {
    expect(translate('').sql).toBe('TRUE');
  });
});

/**
 * The property the phase exists for.
 *
 * **A client's input never becomes SQL text.** The column names come from the
 * registry and the values are parameters, so there is no path from a query to
 * a statement that means something else.
 */
describe('what never reaches the SQL', () => {
  const nasty = [
    "' OR 1=1 --",
    '; DROP TABLE users; --',
    "admin'--",
    "1' OR '1'='1",
  ];

  it('keeps every value in the parameters', () => {
    for (const value of nasty) {
      // Quoted, so the value stays one value: unquoted, the spaces in it would
      // split it into several terms, which is safe but is not the test.
      const { sql, parameters } = translate(`email:"${value}"`);

      // The value is in the parameters and nowhere else. A value that reached
      // the SQL as text would be a client who can read the database.
      expect(Object.values(parameters)).toContain(`%${value}%`);
      expect(sql).not.toContain(value);
    }
  });

  it('keeps a value with a quote in it from closing the statement', () => {
    const { sql } = translate(`email:"admin'--"`);

    // The single quote is a character in a parameter, not the end of a literal.
    expect(sql).not.toContain("'--");
  });

  it('keeps a value with a wildcard in it literal', () => {
    const { parameters } = translate('email:100%');

    // The user's own `%` is a literal percent sign, not a wildcard. Without the
    // escaping, `100%` would match every value that starts with "100".
    expect(parameters['p0']).toBe('%100\\%%');
  });

  it('keeps a value with an underscore in it literal', () => {
    const { parameters } = translate('email:a_b');

    expect(parameters['p0']).toBe('%a\\_b%');
  });
});

describe('what the translator refuses', () => {
  it('refuses a field it does not have', () => {
    expect(() => translate('emial:ada')).toThrow(UnknownFieldError);
  });

  it('refuses a field that is not searchable', () => {
    expect(() => translate('password:x')).toThrow(UnsupportedFieldError);
  });

  it('refuses a fuzzy term, because postgres cannot express one', () => {
    // A trigram similarity is a different function, and matching the term
    // exactly would be a different question.
    expect(() => translate('email:ada~2')).toThrow(UnsupportedOperationError);
  });

  it('refuses a value that is not a number', () => {
    expect(() => translate('age:abc')).toThrow(InvalidSearchValueError);
  });

  it('refuses a value that is not a date', () => {
    expect(() => translate('createdAt:[abc TO 2026-01-01]')).toThrow(
      InvalidSearchValueError,
    );
  });

  it('refuses a value that is not a boolean', () => {
    expect(() => translate('isActive:maybe')).toThrow(InvalidSearchValueError);
  });

  it('refuses a phrase on a field that is not text', () => {
    expect(() => translate('role:"admin user"')).toThrow(UnsupportedFieldError);
  });
});
