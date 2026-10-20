import { describe, expect, it } from 'vitest';

import { SearchParseError } from './errors.js';
import { parseSearchQuery } from './parser.js';

/**
 * The grammar, as a test.
 *
 * **Every supported form is asserted against the tree it produces**, because the
 * tree is the contract: a translator in Phase 28 and another in Phase 71 read
 * it, and a change to the shape is a change to both of them. A test that
 * asserted on the token stream would pin the tokenizer instead, and the tree is
 * the thing that has to stay stable.
 */
describe('a term', () => {
  it('is a field query against the default field when it names no field', () => {
    expect(parseSearchQuery('ada')).toEqual({
      type: 'field',
      field: null,
      value: 'ada',
    });
  });

  it('is a field query against the field it names', () => {
    expect(parseSearchQuery('email:ada')).toEqual({
      type: 'field',
      field: 'email',
      value: 'ada',
    });
  });

  it('keeps the text as it was written', () => {
    // No lowercasing, no stemming, no normalisation. What a term *means* is the
    // translator's business, and a parser that folded case would have taken a
    // decision away from it.
    expect(parseSearchQuery('Ada.Lovelace')).toMatchObject({
      value: 'Ada.Lovelace',
    });
  });

  it('resolves an escaped colon, so the term keeps it', () => {
    expect(parseSearchQuery('a\\:b')).toMatchObject({
      type: 'field',
      field: null,
      value: 'a:b',
    });
  });

  it('does not read an escaped colon as a field', () => {
    // The one thing an escape has to buy: the difference between a term with a
    // colon in it and a field with a value.
    expect(parseSearchQuery('a\\:b')).not.toMatchObject({ field: 'a' });
  });
});

describe('a phrase', () => {
  it('is the terms in it, in order', () => {
    expect(parseSearchQuery('"ada lovelace"')).toEqual({
      type: 'phrase',
      field: null,
      terms: ['ada', 'lovelace'],
    });
  });

  it('can name a field', () => {
    expect(parseSearchQuery('email:"ada lovelace"')).toEqual({
      type: 'phrase',
      field: 'email',
      terms: ['ada', 'lovelace'],
    });
  });

  it('treats a star inside it as a literal', () => {
    // A wildcard in a term is always a wildcard, so a phrase is how a literal
    // one is written.
    expect(parseSearchQuery('"a*b"')).toEqual({
      type: 'phrase',
      field: null,
      terms: ['a*b'],
    });
  });
});

describe('the boolean operators', () => {
  it('combines two clauses with AND', () => {
    expect(parseSearchQuery('a AND b')).toEqual({
      type: 'boolean',
      operator: 'and',
      left: { type: 'field', field: null, value: 'a' },
      right: { type: 'field', field: null, value: 'b' },
    });
  });

  it('combines two clauses with OR', () => {
    expect(parseSearchQuery('a OR b')).toMatchObject({ operator: 'or' });
  });

  it('negates a clause with NOT', () => {
    expect(parseSearchQuery('NOT a')).toEqual({
      type: 'boolean',
      operator: 'not',
      operand: { type: 'field', field: null, value: 'a' },
    });
  });

  it('combines two adjacent clauses with AND when nothing says otherwise', () => {
    // The default operator. A query that widens with every word returns the
    // table, and the operator has been given the work of the filter.
    expect(parseSearchQuery('a b')).toMatchObject({ operator: 'and' });
  });

  it('reads the word "and" as a term when it is lowercase', () => {
    // The keywords are uppercase, so a search for the word "and" is a search and
    // not an operator.
    expect(parseSearchQuery('and')).toEqual({
      type: 'field',
      field: null,
      value: 'and',
    });
  });

  it('reads AND as a term when it is a field value', () => {
    expect(parseSearchQuery('title:AND')).toEqual({
      type: 'field',
      field: 'title',
      value: 'AND',
    });
  });
});

describe('precedence', () => {
  it('binds NOT tighter than AND', () => {
    expect(parseSearchQuery('a AND NOT b')).toEqual({
      type: 'boolean',
      operator: 'and',
      left: { type: 'field', field: null, value: 'a' },
      right: {
        type: 'boolean',
        operator: 'not',
        operand: { type: 'field', field: null, value: 'b' },
      },
    });
  });

  it('binds AND tighter than OR', () => {
    // `a OR b AND c` is `a OR (b AND c)`, the way it reads.
    expect(parseSearchQuery('a OR b AND c')).toEqual({
      type: 'boolean',
      operator: 'or',
      left: { type: 'field', field: null, value: 'a' },
      right: {
        type: 'boolean',
        operator: 'and',
        left: { type: 'field', field: null, value: 'b' },
        right: { type: 'field', field: null, value: 'c' },
      },
    });
  });

  it('binds a group tighter than everything else', () => {
    expect(parseSearchQuery('(a OR b) AND c')).toMatchObject({
      operator: 'and',
      left: { operator: 'or' },
      right: { value: 'c' },
    });
  });

  it('lets a group be a whole query on its own', () => {
    expect(parseSearchQuery('(a)')).toMatchObject({ value: 'a' });
  });

  it('nests a group inside a group', () => {
    expect(parseSearchQuery('((a OR b) AND (c OR d))')).toMatchObject({
      operator: 'and',
      left: { operator: 'or' },
      right: { operator: 'or' },
    });
  });
});

describe('a range', () => {
  it('is inclusive with square brackets', () => {
    expect(parseSearchQuery('createdAt:[2026-01-01 TO 2026-12-31]')).toEqual({
      type: 'range',
      field: 'createdAt',
      lower: '2026-01-01',
      upper: '2026-12-31',
      inclusiveLower: true,
      inclusiveUpper: true,
    });
  });

  it('is exclusive with curly braces', () => {
    expect(
      parseSearchQuery('createdAt:{2026-01-01 TO 2026-12-31}'),
    ).toMatchObject({ inclusiveLower: false, inclusiveUpper: false });
  });

  it('is open on a side whose bound is a star', () => {
    expect(parseSearchQuery('age:[* TO 10]')).toMatchObject({
      lower: null,
      upper: '10',
    });
  });

  it('is one-sided with a comparison', () => {
    expect(parseSearchQuery('age:>10')).toMatchObject({
      type: 'range',
      field: 'age',
      lower: '10',
      upper: null,
      inclusiveLower: false,
    });
  });

  it('is one-sided and inclusive with >=', () => {
    expect(parseSearchQuery('age:>=10')).toMatchObject({
      lower: '10',
      inclusiveLower: true,
    });
  });

  it('is one-sided and exclusive with <', () => {
    expect(parseSearchQuery('age:<10')).toMatchObject({
      lower: null,
      upper: '10',
      inclusiveUpper: false,
    });
  });

  it('keeps the bounds as text, because the column decides what they mean', () => {
    // A range is over a date, a number or a keyword, and which one it is
    // depends on the field — so the parser does not convert.
    expect(
      parseSearchQuery('createdAt:[2026-01-01 TO 2026-12-31]'),
    ).toMatchObject({ lower: '2026-01-01' });
  });
});

describe('a wildcard', () => {
  it('keeps the star in the pattern', () => {
    expect(parseSearchQuery('wild*')).toEqual({
      type: 'wildcard',
      field: null,
      pattern: 'wild*',
    });
  });

  it('keeps the question mark in the pattern', () => {
    expect(parseSearchQuery('f?y')).toMatchObject({ pattern: 'f?y' });
  });

  it('can name a field', () => {
    expect(parseSearchQuery('email:wild*')).toMatchObject({
      type: 'wildcard',
      field: 'email',
      pattern: 'wild*',
    });
  });
});

describe('a fuzzy term', () => {
  it('is a term with the default edit distance', () => {
    expect(parseSearchQuery('ada~')).toEqual({
      type: 'field',
      field: null,
      value: 'ada',
      fuzzy: 2,
    });
  });

  it('is a term with the edit distance it names', () => {
    expect(parseSearchQuery('ada~1')).toMatchObject({ fuzzy: 1 });
  });

  it('is a term with a field', () => {
    expect(parseSearchQuery('email:ada~1')).toMatchObject({
      field: 'email',
      fuzzy: 1,
    });
  });
});

describe('a boost', () => {
  it('wraps the clause it boosts', () => {
    expect(parseSearchQuery('ada^3')).toEqual({
      type: 'boost',
      boost: 3,
      query: { type: 'field', field: null, value: 'ada' },
    });
  });

  it('can boost a fuzzy term', () => {
    expect(parseSearchQuery('ada~2^3')).toEqual({
      type: 'boost',
      boost: 3,
      query: { type: 'field', field: null, value: 'ada', fuzzy: 2 },
    });
  });

  it('can boost a field clause', () => {
    expect(parseSearchQuery('email:ada^2')).toMatchObject({
      type: 'boost',
      query: { field: 'email' },
    });
  });

  it('accepts a fraction', () => {
    expect(parseSearchQuery('ada^1.5')).toMatchObject({ boost: 1.5 });
  });
});

describe('the match-all', () => {
  it('is an empty query', () => {
    // A search box the user has not typed in yet is asking for the list, not
    // for an error.
    expect(parseSearchQuery('')).toEqual({ type: 'matchAll' });
  });

  it('is a query of whitespace', () => {
    expect(parseSearchQuery('   ')).toEqual({ type: 'matchAll' });
  });

  it('is the conventional spelling', () => {
    expect(parseSearchQuery('*:*')).toEqual({ type: 'matchAll' });
  });
});

describe('the field exists', () => {
  it('is a field with a star', () => {
    expect(parseSearchQuery('email:*')).toEqual({
      type: 'exists',
      field: 'email',
    });
  });
});

/**
 * The three things the plan refuses, and why.
 *
 * **Not because they are hard.** Because a translator that has to produce a
 * regular expression, a script or a nested query cannot be proved to produce
 * the thing the user asked for — and a search that answers a different question
 * is worse than one that says it cannot.
 */
describe('what is refused', () => {
  it('refuses a regular expression, rather than searching for it literally', () => {
    // `/foo/` is a regex in Lucene's syntax. Treating it as a term would search
    // for the text "/foo/" and find nothing, which is a different answer from
    // the one that was asked for.
    expect(() => parseSearchQuery('/foo/')).toThrow(SearchParseError);
    expect(() => parseSearchQuery('/foo/')).toThrow(/Regular expressions/);
  });

  it('leaves a path alone, because a path is not a regular expression', () => {
    // Lucene's own rule: the regex delimiter cannot appear inside the pattern,
    // so a term with a second slash in it is not a regex.
    expect(parseSearchQuery('/api/v1')).toMatchObject({ value: '/api/v1' });
    expect(parseSearchQuery('/api/v1/')).toMatchObject({ value: '/api/v1/' });
  });

  it('refuses a script or a pseudo-field', () => {
    // A name beginning with an underscore names a pseudo-field or a script in
    // Lucene and Elasticsearch, and a translator cannot produce one.
    expect(() => parseSearchQuery('_script:foo')).toThrow(SearchParseError);
    expect(() => parseSearchQuery('_script:foo')).toThrow(/pseudo-field/);
  });

  it('refuses a nested query', () => {
    // A group inside a field value is a query inside a query.
    expect(() => parseSearchQuery('title:(a OR b)')).toThrow(SearchParseError);
    expect(() => parseSearchQuery('title:(a OR b)')).toThrow(/nested query/);
  });
});

describe('what is a mistake', () => {
  it('names the position of the problem', () => {
    try {
      parseSearchQuery('email:ada AND :b');

      expect.unreachable('the query should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      expect((error as SearchParseError).position).toBe(14);
      expect((error as SearchParseError).message).toContain('position');
    }
  });

  it('refuses a field with no value', () => {
    expect(() => parseSearchQuery('email:')).toThrow(/must be followed/);
  });

  it('refuses a colon with no field', () => {
    expect(() => parseSearchQuery(':ada')).toThrow(/colon/);
  });

  it('refuses an unclosed phrase', () => {
    expect(() => parseSearchQuery('"ada')).toThrow(/not closed/);
  });

  it('refuses an unclosed range', () => {
    expect(() => parseSearchQuery('age:[1 TO 2')).toThrow(/not closed/);
  });

  it('refuses a range with no TO', () => {
    expect(() => parseSearchQuery('age:[1 2]')).toThrow(/TO/);
  });

  it('refuses an unbalanced parenthesis', () => {
    expect(() => parseSearchQuery('(a')).toThrow(/must be closed/);
  });

  it('refuses a closing parenthesis with nothing to close', () => {
    expect(() => parseSearchQuery('a)')).toThrow(/nothing to close/);
  });

  it('refuses a trailing backslash', () => {
    expect(() => parseSearchQuery('a\\')).toThrow(/backslash/);
  });

  it('refuses an edit distance that means nothing', () => {
    // Three edits is a match against almost anything, which is a query that
    // returns the table and looks like a filter.
    expect(() => parseSearchQuery('ada~3')).toThrow(/at most 2/);
  });

  it('refuses a boost of zero', () => {
    // A boost of zero means "never match", which is a contradiction rather than
    // a weighting.
    expect(() => parseSearchQuery('ada^0')).toThrow(/greater than zero/);
  });

  it('refuses a boost that is not a number', () => {
    expect(() => parseSearchQuery('ada^x')).toThrow(/positive number/);
  });

  it('refuses a field name that is not an identifier', () => {
    expect(() => parseSearchQuery('a-b:c')).toThrow(/not a field name/);
  });

  it('refuses a wildcard that is also fuzzy', () => {
    expect(() => parseSearchQuery('wild*~2')).toThrow(/cannot also be fuzzy/);
  });
});

/**
 * The property that matters most: the parser is total.
 *
 * **Every input produces either a tree or a `SearchParseError`** — never a
 * `TypeError`, never a hang. A parser that could throw anything else would turn
 * a malformed query into a 500, and one that could loop would turn a request
 * into a denial of service.
 */
describe('the parser is total', () => {
  const garbage = [
    '',
    ' ',
    '   \t\n ',
    'a',
    '(',
    ')',
    '()',
    '(())',
    '(()',
    'a)',
    ':',
    '::',
    ':a',
    'a:',
    'a::',
    '"',
    '""',
    '"a',
    '"a"',
    '[',
    ']',
    '{}',
    '[TO]',
    '[a TO b]',
    '{a TO b}',
    '[a TO]',
    '[TO b]',
    '[a TO b',
    'a~',
    'a~1',
    'a~2',
    'a~3',
    'a~-1',
    'a^',
    'a^1',
    'a^0',
    'a^-1',
    'a^1.5',
    'a^1.5.5',
    'a*',
    '*',
    '*:*',
    '*:*:',
    '**',
    '?',
    'a?',
    'a\\',
    '\\',
    '\\:',
    'a\\:b',
    'a\\ b',
    'AND',
    'OR',
    'NOT',
    'AND OR NOT',
    'a AND',
    'AND a',
    'a OR OR b',
    'NOT NOT a',
    'field:AND',
    'field:NOT',
    'field:(a)',
    'field:[a TO b]',
    'field:>5',
    'field:<5',
    'field:*',
    'field:~',
    '_x:y',
    '__x:y',
    'a-b:c',
    'a b c d e',
    '(a AND b) OR (c AND NOT d)',
    'x:' + 'y'.repeat(500),
    '(' + 'a'.repeat(200),
  ];

  it('answers with a tree or with a parse error, and never anything else', () => {
    for (const input of garbage) {
      let outcome: 'tree' | 'parse-error' = 'tree';

      try {
        const query = parseSearchQuery(input);

        expect(typeof query.type, input).toBe('string');
      } catch (error) {
        outcome = 'parse-error';

        expect(error, input).toBeInstanceOf(SearchParseError);
      }

      expect(['tree', 'parse-error'], input).toContain(outcome);
    }
  });

  it('answers the same way every time', () => {
    // A parser that depended on the order of its own state would parse the same
    // query two ways, and a translator would have to cope with both.
    for (const input of garbage) {
      const first = attempt(input);
      const second = attempt(input);

      expect(second, input).toEqual(first);
    }
  });
});

/** What the parser did with a query, as something comparable. */
function attempt(input: string): unknown {
  try {
    return parseSearchQuery(input);
  } catch (error) {
    return {
      error: (error as SearchParseError).message,
      position: (error as SearchParseError).position,
    };
  }
}
