import { describe, expect, it } from 'vitest';

import { UnknownFieldError, UnsupportedFieldError } from '../errors.js';
import { SearchFieldRegistry, type SearchField } from '../field-registry.js';
import { parseSearchQuery } from '../parser.js';
import { levenshtein, translateToPredicate } from './in-memory.js';

/**
 * The reference semantics.
 *
 * **This is the translator a Postgres translator is compared against.** It
 * answers "which rows match" with nothing but JavaScript, so the answer can
 * be checked by hand — and a translator that disagrees with it about which rows
 * match is answering a different question.
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
    // Matchable by a term — `age:36` is an equality on a number — and by a
    // range. Whether a number should be matchable at all is the field map's
    // decision, and this one says yes.
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
    searchable: false,
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

/** The rows the questions are asked about. */
const ada = {
  email: 'ada@example.test',
  role: 'admin',
  age: 36,
  createdAt: new Date('2026-01-15T00:00:00.000Z'),
  isActive: true,
  password: 'secret',
};

const grace = {
  email: 'grace@example.test',
  role: 'user',
  age: 45,
  createdAt: new Date('2025-06-01T00:00:00.000Z'),
  isActive: false,
  password: 'secret',
};

/** Whether a row matches a query. */
function matches(query: string, row: Record<string, unknown>): boolean {
  return translateToPredicate(parseSearchQuery(query), registry)(row);
}

describe('a term', () => {
  it('matches a substring of a text field, case-insensitively', () => {
    expect(matches('ada', ada)).toBe(true);
    expect(matches('ADA', ada)).toBe(true);
    expect(matches('example', ada)).toBe(true);
    expect(matches('grace', ada)).toBe(false);
  });

  it('matches a keyword exactly', () => {
    // A keyword is one value from a closed set, so "adm" is not "admin".
    expect(matches('role:admin', ada)).toBe(true);
    expect(matches('role:adm', ada)).toBe(false);
  });

  it('matches a number as a number', () => {
    expect(matches('age:36', ada)).toBe(true);
    expect(matches('age:37', ada)).toBe(false);
  });

  it('refuses a field that is not searchable', () => {
    // A password hash is not searchable, and a query that quietly matched
    // nothing would look like "no such user".
    expect(() => matches('password:x', ada)).toThrow(UnsupportedFieldError);
  });

  it('refuses a field it does not have', () => {
    expect(() => matches('emial:ada', ada)).toThrow(UnknownFieldError);
  });
});

describe('a phrase', () => {
  it('matches the words next to each other', () => {
    const named = { ...ada, email: 'ada lovelace@example.test' };

    expect(matches('"ada lovelace"', named)).toBe(true);
    expect(matches('"lovelace ada"', named)).toBe(false);
  });

  it('refuses a keyword, which is one value rather than words', () => {
    expect(() => matches('role:"admin user"', ada)).toThrow(
      UnsupportedFieldError,
    );
  });
});

describe('a wildcard', () => {
  it('matches a pattern', () => {
    expect(matches('email:ada*', ada)).toBe(true);
    expect(matches('email:*@example.test', ada)).toBe(true);
    expect(matches('email:gr?ce*', grace)).toBe(true);
    expect(matches('email:ada*', grace)).toBe(false);
  });

  it('matches the whole value, not a part of it', () => {
    // A wildcard that matched anywhere in the value would make `ada*` match
    // `xada@example.test`, and a query that matches more than it says returns
    // rows nobody asked for.
    expect(matches('email:ada*', { ...ada, email: 'xada@example.test' })).toBe(
      false,
    );
  });

  it('treats a dot in the pattern as a dot', () => {
    // The user's own wildcard is the only one that is a wildcard.
    expect(matches('email:ada@example.test', ada)).toBe(true);
    expect(matches('email:adaXexampleXtest', ada)).toBe(false);
  });
});

describe('an exists', () => {
  it('matches a row that has a value', () => {
    expect(matches('email:*', ada)).toBe(true);
  });

  it('matches a row whose value is empty', () => {
    // "Has a value" and "has a value that is not the empty string" are
    // different questions, and the second is the one an operator means.
    expect(matches('email:*', { ...ada, email: '' })).toBe(false);
  });
});

describe('a range', () => {
  it('compares numbers, inclusively', () => {
    expect(matches('age:[30 TO 40]', ada)).toBe(true);
    expect(matches('age:[30 TO 40]', grace)).toBe(false);
  });

  it('compares numbers, exclusively', () => {
    // The boundary is the difference: 36 is inside (30, 40) either way, and
    // outside [36, 40] with the square bracket closed.
    expect(matches('age:{36 TO 40}', ada)).toBe(false);
    expect(matches('age:[36 TO 40]', ada)).toBe(true);
  });

  it('compares one side only', () => {
    expect(matches('age:>40', ada)).toBe(false);
    expect(matches('age:>40', grace)).toBe(true);
    expect(matches('age:<=36', ada)).toBe(true);
  });

  it('compares dates as dates', () => {
    expect(
      matches('createdAt:[2026-01-01T00:00:00Z TO 2026-12-31T00:00:00Z]', ada),
    ).toBe(true);
    expect(
      matches(
        'createdAt:[2026-01-01T00:00:00Z TO 2026-12-31T00:00:00Z]',
        grace,
      ),
    ).toBe(false);
  });

  it('refuses a boolean, which has no range', () => {
    expect(() => matches('isActive:[true TO false]', ada)).toThrow(
      UnsupportedFieldError,
    );
  });
});

describe('the boolean operators', () => {
  it('needs both sides for AND', () => {
    expect(matches('ada AND role:admin', ada)).toBe(true);
    expect(matches('ada AND role:user', ada)).toBe(false);
  });

  it('needs either side for OR', () => {
    expect(matches('role:admin OR role:user', ada)).toBe(true);
    expect(matches('role:user OR role:nobody', ada)).toBe(false);
  });

  it('excludes for NOT', () => {
    expect(matches('NOT role:admin', ada)).toBe(false);
    expect(matches('NOT role:user', ada)).toBe(true);
  });
});

describe('a boost', () => {
  it('does not change which rows match', () => {
    // A boost changes the order of the results. A predicate has no order to
    // change, and a boost that changed the match set would be a different
    // question.
    expect(matches('role:admin^3', ada)).toBe(matches('role:admin', ada));
  });
});

describe('a fuzzy term', () => {
  it('matches a word within the edit distance', () => {
    expect(matches('adq~1', ada)).toBe(true);
    expect(matches('adqqqq~1', ada)).toBe(false);
  });

  it('uses the distance it was given', () => {
    expect(matches('adq~1', ada)).toBe(true);
    expect(matches('adq~0', ada)).toBe(false);
  });
});

describe('the edit distance', () => {
  it('is zero for the same word', () => {
    expect(levenshtein('ada', 'ada')).toBe(0);
  });

  it('is one for a single edit', () => {
    expect(levenshtein('ada', 'adq')).toBe(1);
  });

  it('is the length when one word is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts a substitution as one edit, not two', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('the empty query', () => {
  it('matches everything', () => {
    // A search box the user has not typed in yet is asking for the list.
    expect(matches('', ada)).toBe(true);
  });
});
