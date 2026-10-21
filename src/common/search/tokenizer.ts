import { SearchParseError } from './errors.js';

/**
 * The kinds of token the search grammar is written in.
 *
 * **The tokenizer does not know what a word means.** `AND` is a word, `email`
 * is a word, and `mail*` is a word; whether any of them is a keyword, a term
 * or a field name depends on where it appears, and only the parser knows that.
 * A tokenizer that decided on its own would have to guess, and the guess would
 * be wrong for `field:AND` — a search for the word "and" in a field, which is a
 * term and not an operator.
 */
export type TokenType =
  /** A bare run of characters: a term, a keyword or a field name. */
  | 'word'
  /** A quoted sequence of terms. */
  | 'phrase'
  /** A field name, with its colon consumed. */
  | 'field'
  | 'lparen'
  | 'rparen'
  /** A whole range: `[a TO b]` or `{a TO b}`. */
  | 'range'
  /** One of `>`, `<`, `>=`, `<=`. */
  | 'comparison'
  /** `*:*` — the match-all. */
  | 'matchAll'
  /** The end of the input. */
  | 'eof';

export interface Token {
  readonly type: TokenType;
  /** The text the token carries, unescaped. */
  readonly value: string;
  /** Where it starts in the source, for the error message. */
  readonly position: number;
}

/**
 * The characters that end a word.
 *
 * `>` and `<` are here because they are the comparison operators and a term
 * containing one is not a term anybody has meant to write. A term that needs
 * them escapes them.
 */
const isTerminator = (char: string): boolean =>
  char === '(' ||
  char === ')' ||
  char === '"' ||
  char === '[' ||
  char === '}' ||
  char === '>' ||
  char === '<';

const isWhitespace = (char: string): boolean =>
  char === ' ' ||
  char === '\t' ||
  char === '\n' ||
  char === '\r' ||
  char === '\f' ||
  char === '\v';

/**
 * Turns a query into its tokens.
 *
 * **Escapes are resolved here.** A backslash makes the next character literal,
 * so `a\:b` is one term and `a\:b` is not a field named `a` with the value
 * `b`. The token's text is the unescaped text, because every consumer of it
 * wants the character rather than the way it was written.
 *
 * **The tokens carry their position**, because a parse error that says "at
 * position 14" is actionable and one that says "invalid query" is not.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: char, position: index });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: char, position: index });
      index += 1;
      continue;
    }

    if (char === '"') {
      const phrase = readPhrase(source, index);

      tokens.push({
        type: 'phrase',
        value: phrase.text,
        position: index,
      });
      index = phrase.end;
      continue;
    }

    if (char === '[' || char === '{') {
      const range = readRange(source, index);

      tokens.push({
        type: 'range',
        // The brackets are kept, because they are what says whether the bounds
        // are inclusive. The inner text is the parser's business.
        value: source.slice(index, range.end),
        position: index,
      });
      index = range.end;
      continue;
    }

    if (char === '>' || char === '<') {
      const comparison = readComparison(source, index);

      tokens.push({
        type: 'comparison',
        value: comparison.text,
        position: index,
      });
      index = comparison.end;
      continue;
    }

    if (char === ':') {
      // A colon with nothing in front of it. The tokenizer cannot tell whether
      // the word before it was a field name, because it does not decide what a
      // word means — but a leading colon is never a term either.
      throw new SearchParseError(
        'A colon must follow a field name',
        index,
        source,
      );
    }

    const word = readWord(source, index);

    // The word is a field name when a colon follows it.
    if (source[word.end] === ':') {
      // `*:*` is the match-all, and it is the one place a name is not a name.
      if (word.text === '*' && source[word.end + 1] === '*') {
        tokens.push({ type: 'matchAll', value: '*:*', position: index });
        index = word.end + 2;
        continue;
      }

      tokens.push({ type: 'field', value: word.text, position: index });
      index = word.end + 1;
      continue;
    }

    tokens.push({ type: 'word', value: word.text, position: index });
    index = word.end;
  }

  tokens.push({ type: 'eof', value: '', position: source.length });

  return tokens;
}

/**
 * Reads a run of characters up to the next terminator, resolving escapes.
 *
 * **A colon ends a word**, because a colon is what separates a field name from
 * its value. An *escaped* colon does not: `a\:b` is one term, and the scan
 * consumes the escaped colon as part of it.
 */
function readWord(
  source: string,
  start: number,
): { text: string; end: number } {
  let index = start;
  let text = '';

  while (index < source.length) {
    const char = source[index];

    if (isWhitespace(char) || isTerminator(char) || char === ':') {
      break;
    }

    if (char === '\\') {
      const next = source[index + 1];

      if (next === undefined) {
        throw new SearchParseError(
          'A trailing backslash escapes nothing',
          index,
          source,
        );
      }

      text += next;
      index += 2;
      continue;
    }

    text += char;
    index += 1;
  }

  return { text, end: index };
}

/** Reads a quoted phrase. The quotes are not part of it. */
function readPhrase(
  source: string,
  start: number,
): { text: string; end: number } {
  let index = start + 1;
  let text = '';

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      const next = source[index + 1];

      if (next === undefined) {
        throw new SearchParseError(
          'A trailing backslash escapes nothing',
          index,
          source,
        );
      }

      text += next;
      index += 2;
      continue;
    }

    if (char === '"') {
      return { text, end: index + 1 };
    }

    text += char;
    index += 1;
  }

  throw new SearchParseError('The phrase is not closed', start, source);
}

/**
 * Reads a range: `[a TO b]` or `{a TO b}`.
 *
 * **The whole bracket is one token.** `TO` inside it is the separator and not
 * the keyword, and a range whose bounds are themselves ranges is not a thing
 * anybody writes. Letting the tokenizer take the whole bracket means the
 * grammar for a range is written once, in the parser, rather than spread over
 * both.
 */
function readRange(
  source: string,
  start: number,
): { text: string; end: number } {
  const opening = source[start];
  const closing = opening === '[' ? ']' : '}';

  let index = start + 1;
  let text = '';

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      const next = source[index + 1];

      if (next === undefined) {
        throw new SearchParseError(
          'A trailing backslash escapes nothing',
          index,
          source,
        );
      }

      text += next;
      index += 2;
      continue;
    }

    if (char === closing) {
      return { text, end: index + 1 };
    }

    if (char === ']' || char === '}') {
      throw new SearchParseError(
        'A range cannot contain the other kind of bracket',
        index,
        source,
      );
    }

    text += char;
    index += 1;
  }

  throw new SearchParseError('The range is not closed', start, source);
}

/** Reads a comparison: `>`, `<`, `>=` or `<=`. */
function readComparison(
  source: string,
  start: number,
): { text: string; end: number } {
  const char = source[start];

  if (source[start + 1] === '=') {
    return { text: `${char}=`, end: start + 2 };
  }

  return { text: char, end: start + 1 };
}
