import { describe, expect, it } from 'vitest';

import { SearchParseError } from './errors.js';
import { tokenize } from './tokenizer.js';

/**
 * The token stream.
 *
 * **The tokenizer does not decide what a word means.** `AND`, `email` and
 * `mail*` are all the same kind of token, and only the parser knows which is
 * which — because only the parser knows whether it is reading an operand or a
 * value. A tokenizer that decided on its own would have to guess, and the guess
 * would be wrong for `field:AND`.
 */
describe('tokenize', () => {
  it('reads a word', () => {
    expect(tokenize('ada')).toEqual([
      { type: 'word', value: 'ada', position: 0 },
      { type: 'eof', value: '', position: 3 },
    ]);
  });

  it('reads a field name with its colon', () => {
    expect(tokenize('email:ada')).toEqual([
      { type: 'field', value: 'email', position: 0 },
      { type: 'word', value: 'ada', position: 6 },
      { type: 'eof', value: '', position: 9 },
    ]);
  });

  it('reads a phrase with its quotes consumed', () => {
    expect(tokenize('"ada lovelace"')).toEqual([
      { type: 'phrase', value: 'ada lovelace', position: 0 },
      { type: 'eof', value: '', position: 14 },
    ]);
  });

  it('reads a range with its brackets kept', () => {
    // The brackets are what say whether the bounds are inclusive, so the token
    // keeps them and the parser reads them.
    expect(tokenize('age:[1 TO 2]')).toEqual([
      { type: 'field', value: 'age', position: 0 },
      { type: 'range', value: '[1 TO 2]', position: 4 },
      { type: 'eof', value: '', position: 12 },
    ]);
  });

  it('reads a comparison', () => {
    expect(tokenize('age:>=10')).toEqual([
      { type: 'field', value: 'age', position: 0 },
      { type: 'comparison', value: '>=', position: 4 },
      { type: 'word', value: '10', position: 6 },
      { type: 'eof', value: '', position: 8 },
    ]);
  });

  it('reads the match-all', () => {
    expect(tokenize('*:*')).toEqual([
      { type: 'matchAll', value: '*:*', position: 0 },
      { type: 'eof', value: '', position: 3 },
    ]);
  });

  it('leaves a star alone when it is not the match-all', () => {
    // `field:*` is "the field has a value", and `*` on its own is a wildcard.
    // Only the two together are the match-all.
    expect(tokenize('email:*')[0]).toEqual({
      type: 'field',
      value: 'email',
      position: 0,
    });
    expect(tokenize('*')[0]).toEqual({
      type: 'word',
      value: '*',
      position: 0,
    });
  });

  it('does not decide that a word is a keyword', () => {
    // The keywords are uppercase, but whether a word is one depends on where it
    // appears. The tokenizer says "word" and the parser decides.
    expect(tokenize('AND')[0]).toEqual({
      type: 'word',
      value: 'AND',
      position: 0,
    });
  });

  it('resolves an escape', () => {
    expect(tokenize('a\\:b')).toEqual([
      { type: 'word', value: 'a:b', position: 0 },
      { type: 'eof', value: '', position: 4 },
    ]);
  });

  it('does not read an escaped colon as a field', () => {
    expect(tokenize('a\\:b')[0].type).toBe('word');
  });

  it('keeps an escaped space inside the word', () => {
    expect(tokenize('a\\ b')[0]).toEqual({
      type: 'word',
      value: 'a b',
      position: 0,
    });
  });

  it('reads the wildcards, the edit distance and the boost as part of the word', () => {
    // They are part of the term's text, and the parser is what gives them
    // meaning — so the tokenizer does not have to know about them at all.
    expect(tokenize('wild*~2^3')[0]).toEqual({
      type: 'word',
      value: 'wild*~2^3',
      position: 0,
    });
  });

  it('skips whitespace', () => {
    expect(tokenize('  a\tb\n').map((token) => token.type)).toEqual([
      'word',
      'word',
      'eof',
    ]);
  });

  it('says where every token started', () => {
    // A parse error that points at a character is actionable; one that says
    // "invalid query" is not.
    const tokens = tokenize('a b:c');

    expect(tokens.map((token) => token.position)).toEqual([0, 2, 4, 5]);
  });

  it('ends with an end-of-input token', () => {
    expect(tokenize('')).toEqual([{ type: 'eof', value: '', position: 0 }]);
  });
});

describe('what the tokenizer refuses', () => {
  it('refuses a phrase that is not closed', () => {
    expect(() => tokenize('"ada')).toThrow(SearchParseError);
    expect(() => tokenize('"ada')).toThrow(/not closed/);
  });

  it('refuses a range that is not closed', () => {
    expect(() => tokenize('[1 TO 2')).toThrow(/not closed/);
  });

  it('refuses a range holding the other kind of bracket', () => {
    expect(() => tokenize('[1 TO 2}')).toThrow(/other kind of bracket/);
  });

  it('refuses a trailing backslash', () => {
    expect(() => tokenize('a\\')).toThrow(/backslash/);
  });

  it('refuses a colon with nothing in front of it', () => {
    // The tokenizer cannot tell whether the word before a colon was a field
    // name — it does not decide what a word means — but a leading colon is
    // never a term either.
    expect(() => tokenize(':ada')).toThrow(/colon/);
  });
});
