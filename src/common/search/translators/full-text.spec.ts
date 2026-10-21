import { describe, expect, it } from 'vitest';

import {
  InvalidSearchValueError,
  UnknownFieldError,
  UnsupportedFieldError,
  UnsupportedOperationError,
} from '../errors.js';
import { SearchFieldRegistry, type SearchField } from '../field-registry.js';
import { parseSearchQuery } from '../parser.js';
import {
  buildDocumentExpression,
  TEXT_SEARCH_CONFIGURATION,
  translateToFullText,
  weightLetter,
} from './full-text.js';

/**
 * The full-text translator.
 *
 * **The property under test is that a term cannot become an expression.** The
 * tsquery is built from the tree, and the terms are parameters — so a term
 * containing `&&` is text and never an operator. Everything else here is about
 * what the translator refuses to answer.
 */
const fields: Record<string, SearchField> = {
  email: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 1,
    column: 'email',
  },
  firstName: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.6,
    column: 'firstName',
  },
  role: {
    type: 'keyword',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.3,
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
    weight: 0,
    column: 'createdAt',
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

function translate(query: string) {
  return translateToFullText(parseSearchQuery(query), registry);
}

describe('the tsquery', () => {
  it('is built from the tree, not from a string the user typed', () => {
    const { filter } = translate('email:ada');

    // The operator is ours and the term is a parameter. A tsquery string the
    // user typed would be a string the user typed.
    expect(filter).toContain('@@');
    expect(filter).toContain('plainto_tsquery');
    expect(filter).not.toContain('ada');
  });

  it('binds the term as a parameter', () => {
    const { filter, parameters } = translate('email:ada');

    expect(Object.values(parameters)).toContain('ada');
    expect(filter).toContain(':p0');
  });

  it('joins two terms with the tsquery AND', () => {
    const { rank } = translate('email:ada AND firstName:lovelace');

    expect(rank).toContain('&&');
  });

  it('joins two terms with the tsquery OR', () => {
    const { rank } = translate('email:ada OR firstName:lovelace');

    expect(rank).toContain('||');
  });

  it('negates with the tsquery NOT', () => {
    const { rank } = translate('NOT email:ada');

    expect(rank).toContain('!!');
  });

  it('uses the function that does not read its argument as an expression', () => {
    const { filter } = translate('email:ada');

    // `to_tsquery` parses its argument, so a term could add a clause. The two
    // functions that do not parse it are the only safe ones.
    expect(filter).toContain('plainto_tsquery');
    // A word boundary, so `plainto_tsquery` does not count as `to_tsquery`.
    expect(filter).not.toMatch(/\bto_tsquery\(/);
  });

  it('uses the configuration the application declared', () => {
    const { filter } = translate('email:ada');

    expect(filter).toContain(`'${TEXT_SEARCH_CONFIGURATION}'`);
  });

  it('makes a phrase a phrase', () => {
    const { filter } = translate('email:"ada lovelace"');

    expect(filter).toContain('phraseto_tsquery');
  });

  it('leaves a query with no text without a tsquery', () => {
    // An empty tsquery is a syntax error in postgres, and a query that is only
    // ranges has nothing to rank.
    const { rank } = translate('age:[18 TO 65]');

    expect(rank).toBe('0');
  });
});

describe('the filter', () => {
  it('matches the document for a text term', () => {
    const { filter } = translate('email:ada');

    expect(filter).toContain('"searchVector" @@');
  });

  it('qualifies the document with the alias when there is one', () => {
    const { filter } = translateToFullText(
      parseSearchQuery('email:ada'),
      registry,
      { alias: 'user' },
    );

    expect(filter).toContain('"user"."searchVector"');
  });

  it('compares a field that is not text', () => {
    const { filter, parameters } = translate('age:36');

    expect(filter).toContain('"age" = :p0');
    expect(parameters['p0']).toBe(36);
  });

  it('keeps the structure of a boolean', () => {
    const { filter } = translate('email:ada AND age:36');

    expect(filter).toContain(' AND ');
  });

  it('matches everything when the query is empty', () => {
    const { filter } = translate('');

    expect(filter).toBe('TRUE');
  });

  it('refuses a field it does not have', () => {
    expect(() => translate('emial:ada')).toThrow(UnknownFieldError);
  });

  it('refuses a fuzzy term, because postgres cannot express one', () => {
    expect(() => translate('email:ada~2')).toThrow(UnsupportedOperationError);
  });

  it('refuses a value that is not a number', () => {
    expect(() => translate('age:abc')).toThrow(InvalidSearchValueError);
  });

  it('refuses a phrase on a field that is not text', () => {
    expect(() => translate('role:"admin user"')).toThrow(UnsupportedFieldError);
  });
});

describe('the rank', () => {
  it('is the rank of the document against the tsquery', () => {
    const { rank } = translate('email:ada');

    expect(rank).toContain('ts_rank(');
    expect(rank).toContain('"searchVector"');
  });

  it('multiplies the score by a boost', () => {
    const { rank } = translate('email:ada^3');

    expect(rank).toContain('* 3');
  });

  it('is zero for a query with no text', () => {
    expect(translate('age:36').rank).toBe('0');
  });
});

describe('the weight bands', () => {
  it('puts the heaviest field in the first band', () => {
    expect(weightLetter(1)).toBe('A');
    expect(weightLetter(0.8)).toBe('A');
  });

  it('puts a middling field in the second', () => {
    expect(weightLetter(0.6)).toBe('B');
    expect(weightLetter(0.5)).toBe('B');
  });

  it('puts a light field in the third', () => {
    expect(weightLetter(0.3)).toBe('C');
  });

  it('puts the lightest field in the last', () => {
    expect(weightLetter(0)).toBe('D');
  });
});

describe('the document expression', () => {
  it('weights every searchable field', () => {
    const expression = buildDocumentExpression(registry);

    expect(expression).toContain(
      `setweight(to_tsvector('${TEXT_SEARCH_CONFIGURATION}', coalesce("email", '')), 'A')`,
    );
    expect(expression).toContain(
      `setweight(to_tsvector('${TEXT_SEARCH_CONFIGURATION}', coalesce("firstName", '')), 'B')`,
    );
  });

  it('leaves out the fields that are not searchable', () => {
    const expression = buildDocumentExpression(registry);

    expect(expression).not.toContain('"age"');
  });

  it('leaves out a field that is not searchable, whatever its type', () => {
    // A password hash in the document would be searchable, and a document is
    // exactly the thing a search box reads.
    const expression = buildDocumentExpression(registry);

    expect(expression).not.toContain('"password"');
  });

  it('refuses a registry with nothing to search', () => {
    const empty = new SearchFieldRegistry(
      { age: fields.age as SearchField },
      { defaultField: 'age' },
    );

    expect(() => buildDocumentExpression(empty)).toThrow(/no searchable text/);
  });
});
