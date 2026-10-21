import type { RangeQuery, SearchQuery } from './ast.js';
import { SearchParseError } from './errors.js';
import { tokenize, type Token } from './tokenizer.js';

/**
 * The default operator between two adjacent terms.
 *
 * **AND, not OR.**
 *
 * Lucene's classic parser defaults to OR, and a query language that defaults to
 * OR is right for a document-retrieval engine: a document matching any of the
 * words is a candidate, and the ranking decides. This is a filter over a table
 * that a person is typing into, and there the failure mode is the opposite — a
 * query that widens with every word returns the whole table, and the operator
 * has been given the work of the filter.
 *
 * `OR` is available explicitly, so nothing is lost; and `AND` is the default
 * because the alternative is a search box that answers a different question from
 * the one it was asked.
 */
const DEFAULT_OPERATOR = 'and';

/** The edit distance `term~` means, when no number is given. Lucene's default. */
const DEFAULT_FUZZY_DISTANCE = 2;

/** The largest edit distance that means anything. Lucene's own limit. */
const MAX_FUZZY_DISTANCE = 2;

/** A field name: a letter, then letters, digits and underscores. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The keywords. Uppercase only, so `and` can be a term. */
const KEYWORDS = new Set(['AND', 'OR', 'NOT']);

/**
 * Parses a search query into the tree the translators consume.
 *
 * **Recursive descent, one method per precedence level.** The levels are the
 * grammar, written top to bottom:
 *
 * ```text
 * or      := and ( OR and )*
 * and     := not ( AND? not )*
 * not     := NOT not | primary
 * primary := '(' or ')' | field-value | term | phrase
 * ```
 *
 * The precedence is `NOT` binding tightest, then `AND`, then `OR` — so
 * `a OR b AND c` is `a OR (b AND c)`, and a reader who has used any search
 * engine already knows that.
 *
 * **The parser knows no entity.** A field is a name in the tree; which column it
 * lands on, whether it may be searched at all and what it weighs are the field
 * registry's business, and the registry is Phase 28. Nothing here validates a
 * field against a list, because there is no list here to validate against.
 *
 * **Every failure is a `SearchParseError`.** A malformed query is a client
 * mistake, and a client mistake must be a 400 that says which part was wrong
 * and where — not a `TypeError` from inside the parser, which is a 500 for a
 * request that was merely wrong.
 */
export function parseSearchQuery(source: string): SearchQuery {
  return new SearchParser(source).parse();
}

class SearchParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  parse(): SearchQuery {
    // An empty query matches everything. A search box the user has not typed in
    // yet is asking for the list, not for an error.
    if (this.peek().type === 'eof') {
      return { type: 'matchAll' };
    }

    const query = this.parseOr();

    const token = this.peek();

    if (token.type !== 'eof') {
      throw this.unexpected(token);
    }

    return query;
  }

  /** `or := and ( OR and )*` */
  private parseOr(): SearchQuery {
    let left = this.parseAnd();

    while (this.isKeyword('OR')) {
      this.advance();

      const right = this.parseAnd();

      left = { type: 'boolean', operator: 'or', left, right };
    }

    return left;
  }

  /**
   * `and := not ( AND? not )*`
   *
   * **The operator is optional**, and the default is AND. An explicit `AND`
   * and an implicit one produce the same tree, so there is nothing to tell them
   * apart later — a client that wants OR writes `OR`.
   */
  private parseAnd(): SearchQuery {
    let left = this.parseNot();

    for (;;) {
      if (this.isKeyword('AND')) {
        this.advance();
      } else if (!this.startsOperand()) {
        return left;
      }

      const right = this.parseNot();

      left = { type: 'boolean', operator: DEFAULT_OPERATOR, left, right };
    }
  }

  /** `not := NOT not | primary` */
  private parseNot(): SearchQuery {
    if (this.isKeyword('NOT')) {
      this.advance();

      const operand = this.parseNot();

      return { type: 'boolean', operator: 'not', operand };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): SearchQuery {
    const token = this.peek();

    switch (token.type) {
      case 'lparen': {
        this.advance();

        const inner = this.parseOr();

        this.expect('rparen', 'a group must be closed');

        return inner;
      }

      case 'field':
        return this.parseFieldClause();

      case 'word': {
        this.advance();

        return this.termQuery(null, token);
      }

      case 'phrase': {
        this.advance();

        return this.phraseQuery(null, token);
      }

      case 'matchAll': {
        this.advance();

        return { type: 'matchAll' };
      }

      default:
        throw this.unexpected(token);
    }
  }

  /**
   * A field and its value: `field:term`, `field:"phrase"`, `field:[a TO b]`,
   * `field:>5`, `field:*`.
   */
  private parseFieldClause(): SearchQuery {
    const fieldToken = this.peek();

    this.advance();

    const field = this.validateFieldName(fieldToken.value, fieldToken);
    const token = this.peek();

    switch (token.type) {
      case 'word': {
        this.advance();

        // `field:*` is the field having a value. The bare `*` is the one term
        // that cannot be a term.
        if (token.value === '*') {
          return { type: 'exists', field };
        }

        return this.termQuery(field, token);
      }

      case 'phrase': {
        this.advance();

        return this.phraseQuery(field, token);
      }

      case 'range': {
        this.advance();

        return this.rangeQuery(field, token);
      }

      case 'comparison': {
        this.advance();

        return this.comparisonRange(field, token);
      }

      case 'lparen':
        throw new SearchParseError(
          'A field value cannot be a group: a nested query is not supported',
          token.position,
          this.source,
        );

      default:
        throw new SearchParseError(
          'A field must be followed by a value',
          token.position,
          this.source,
        );
    }
  }

  /**
   * A term, with its optional edit distance and boost.
   *
   * **A `*` or `?` makes it a wildcard**, and a wildcard cannot also be fuzzy:
   * "roughly this shape" and "roughly this shape, with the wildcards" are two
   * different questions and a translator cannot answer both at once.
   */
  private termQuery(field: string | null, token: Token): SearchQuery {
    const parts = splitTerm(token.value, token, this.source);

    if (parts.value.includes('*') || parts.value.includes('?')) {
      if (parts.fuzzy !== undefined) {
        throw new SearchParseError(
          'A wildcard cannot also be fuzzy',
          token.position,
          this.source,
        );
      }

      const wildcard: SearchQuery = {
        type: 'wildcard',
        field,
        pattern: parts.value,
      };

      return parts.boost === undefined
        ? wildcard
        : { type: 'boost', query: wildcard, boost: parts.boost };
    }

    this.refuseRegex(parts.value, token);

    const term: SearchQuery =
      parts.fuzzy === undefined
        ? { type: 'field', field, value: parts.value }
        : { type: 'field', field, value: parts.value, fuzzy: parts.fuzzy };

    return parts.boost === undefined
      ? term
      : { type: 'boost', query: term, boost: parts.boost };
  }

  /**
   * A quoted sequence.
   *
   * **Everything inside the quotes is literal.** A `*` in a phrase is a star,
   * not a wildcard — which is also how a term that has to contain a literal star
   * is written, since a star in a term is always a wildcard.
   */
  private phraseQuery(field: string | null, token: Token): SearchQuery {
    const terms = token.value.split(/\s+/).filter((term) => term !== '');

    if (terms.length === 0) {
      throw new SearchParseError(
        'A phrase must contain at least one term',
        token.position,
        this.source,
      );
    }

    return { type: 'phrase', field, terms };
  }

  /** `[a TO b]`, `{a TO b}`. */
  private rangeQuery(field: string | null, token: Token): RangeQuery {
    const inclusive = token.value.startsWith('[');
    const inner = token.value.slice(1, -1);
    const bounds = splitRange(inner, token, this.source);

    return {
      type: 'range',
      field,
      lower: bounds.lower,
      upper: bounds.upper,
      inclusiveLower: inclusive,
      inclusiveUpper: inclusive,
    };
  }

  /** `field:>5`, `field:<=10`. One bound, and the other side open. */
  private comparisonRange(field: string | null, token: Token): RangeQuery {
    const valueToken = this.peek();

    if (valueToken.type !== 'word') {
      throw new SearchParseError(
        'A comparison must be followed by a value',
        valueToken.position,
        this.source,
      );
    }

    this.advance();

    const parts = splitTerm(valueToken.value, valueToken, this.source);

    if (parts.fuzzy !== undefined || parts.boost !== undefined) {
      throw new SearchParseError(
        'A range bound is a value, not a fuzzy term or a boost',
        valueToken.position,
        this.source,
      );
    }

    switch (token.value) {
      case '>':
        return {
          type: 'range',
          field,
          lower: parts.value,
          upper: null,
          inclusiveLower: false,
          inclusiveUpper: true,
        };

      case '>=':
        return {
          type: 'range',
          field,
          lower: parts.value,
          upper: null,
          inclusiveLower: true,
          inclusiveUpper: true,
        };

      case '<':
        return {
          type: 'range',
          field,
          lower: null,
          upper: parts.value,
          inclusiveLower: true,
          inclusiveUpper: false,
        };

      default:
        return {
          type: 'range',
          field,
          lower: null,
          upper: parts.value,
          inclusiveLower: true,
          inclusiveUpper: true,
        };
    }
  }

  /**
   * A field name, checked.
   *
   * **A name beginning with an underscore is refused.** In Lucene and
   * Elasticsearch a leading underscore names a pseudo-field — `_id`, `_score`,
   * `_source` — or a script, and a translator cannot produce one: it is either
   * metadata the target does not have or an expression the target would have to
   * evaluate. Refusing it here is the difference between "the search does not
   * support that" and "the search silently returned nothing".
   *
   * **The name is an identifier.** Anything else is not a field name, and a
   * name that is not an identifier is how a script would try to hide.
   */
  private validateFieldName(name: string, token: Token): string {
    if (name.startsWith('_')) {
      throw new SearchParseError(
        `"${name}" is a pseudo-field or a script, and neither can be translated`,
        token.position,
        this.source,
      );
    }

    if (!FIELD_NAME.test(name)) {
      throw new SearchParseError(
        `"${name}" is not a field name`,
        token.position,
        this.source,
      );
    }

    return name;
  }

  /**
   * Refuses a term that is a regular expression.
   *
   * **The check is the shape Lucene's own parser uses**: a term that opens and
   * closes with a slash, and whose body holds no other slash, is a regex in
   * Lucene's syntax. `/api/v1` and `/api/v1/` are not — they hold a slash in
   * the body — and stay ordinary terms.
   *
   * The point is not that a regex is hard. It is that a regex is a *different
   * question* from a term, and treating one as the other answers a question the
   * user did not ask. Saying so is better than searching for the literal text
   * `/foo/` and finding nothing.
   */
  private refuseRegex(value: string, token: Token): void {
    if (
      value.length > 2 &&
      value.startsWith('/') &&
      value.endsWith('/') &&
      !value.slice(1, -1).includes('/')
    ) {
      throw new SearchParseError(
        'Regular expressions are not supported; use a wildcard or a phrase',
        token.position,
        this.source,
      );
    }
  }

  /** The token at the cursor. */
  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): void {
    this.index += 1;
  }

  private isKeyword(keyword: string): boolean {
    const token = this.peek();

    return token.type === 'word' && token.value === keyword;
  }

  /** True when the token at the cursor can start an operand. */
  private startsOperand(): boolean {
    const token = this.peek();

    switch (token.type) {
      case 'word':
        // A keyword is not an operand — except `NOT`, which starts one.
        return !KEYWORDS.has(token.value) || token.value === 'NOT';
      case 'phrase':
      case 'field':
      case 'lparen':
      case 'matchAll':
        return true;
      default:
        return false;
    }
  }

  private expect(type: Token['type'], message: string): Token {
    const token = this.peek();

    if (token.type !== type) {
      throw new SearchParseError(message, token.position, this.source);
    }

    this.advance();

    return token;
  }

  /** The error for a token that cannot be there. */
  private unexpected(token: Token): SearchParseError {
    switch (token.type) {
      case 'rparen':
        return new SearchParseError(
          'A closing parenthesis with nothing to close',
          token.position,
          this.source,
        );

      case 'comparison':
        return new SearchParseError(
          'A comparison must follow a field name',
          token.position,
          this.source,
        );

      case 'range':
        return new SearchParseError(
          'A range must follow a field name',
          token.position,
          this.source,
        );

      default:
        return new SearchParseError(
          `Unexpected "${token.value}"`,
          token.position,
          this.source,
        );
    }
  }
}

/** A term split into its value, its edit distance and its boost. */
interface TermParts {
  value: string;
  fuzzy?: number;
  boost?: number;
}

/**
 * Splits `term`, `term~`, `term~2`, `term^3` and `term~2^3` into their parts.
 *
 * **The suffixes are found in the order they are written.** `~` introduces the
 * edit distance and `^` the boost, and Lucene writes them in that order, so the
 * first of the two ends the value.
 */
function splitTerm(text: string, token: Token, source: string): TermParts {
  const fuzzyIndex = text.indexOf('~');
  const boostIndex = text.indexOf('^');

  if (fuzzyIndex >= 0 && (boostIndex < 0 || fuzzyIndex < boostIndex)) {
    const rest = text.slice(fuzzyIndex + 1);
    const boostInRest = rest.indexOf('^');
    const distance = boostInRest >= 0 ? rest.slice(0, boostInRest) : rest;

    return {
      value: text.slice(0, fuzzyIndex),
      fuzzy: parseFuzzyDistance(distance, token, source),
      ...(boostInRest >= 0
        ? { boost: parseBoost(rest.slice(boostInRest + 1), token, source) }
        : {}),
    };
  }

  if (boostIndex >= 0) {
    return {
      value: text.slice(0, boostIndex),
      boost: parseBoost(text.slice(boostIndex + 1), token, source),
    };
  }

  return { value: text };
}

/**
 * The edit distance, from `~` or `~N`.
 *
 * **Zero to two.** Lucene's own limit, and a distance of three is a match
 * against almost anything — which is a query that returns the table and looks
 * like a filter.
 */
function parseFuzzyDistance(
  text: string,
  token: Token,
  source: string,
): number {
  if (text === '') {
    return DEFAULT_FUZZY_DISTANCE;
  }

  if (!/^\d+$/.test(text)) {
    throw new SearchParseError(
      'The edit distance must be a number',
      token.position,
      source,
    );
  }

  const distance = Number(text);

  if (distance > MAX_FUZZY_DISTANCE) {
    throw new SearchParseError(
      `The edit distance must be at most ${MAX_FUZZY_DISTANCE}`,
      token.position,
      source,
    );
  }

  return distance;
}

/**
 * The boost, from `^N`.
 *
 * **Positive, and never zero.** A boost of zero means "never match", which is
 * not a weighting — it is a contradiction, and a search that returns nothing
 * because of it looks like a bug rather than an instruction.
 */
function parseBoost(text: string, token: Token, source: string): number {
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new SearchParseError(
      'The boost must be a positive number',
      token.position,
      source,
    );
  }

  const boost = Number(text);

  if (boost <= 0) {
    throw new SearchParseError(
      'The boost must be greater than zero',
      token.position,
      source,
    );
  }

  return boost;
}

/**
 * The bounds of a range, from `a TO b`.
 *
 * **`TO` is the separator, in uppercase.** `TO` is a word like any other, and
 * a bound that is the word "to" is written `"to"` — in a phrase, where
 * everything is literal.
 *
 * **`*` is an open bound.** `[* TO 10]` is everything up to ten, and the
 * missing side is null rather than a wildcard the translator would have to
 * interpret.
 */
function splitRange(
  text: string,
  token: Token,
  source: string,
): { lower: string | null; upper: string | null } {
  const separator = /^(.*?)\s+TO\s+(.*)$/.exec(text);

  if (!separator) {
    throw new SearchParseError(
      'A range needs TO between its bounds',
      token.position,
      source,
    );
  }

  const lower = separator[1].trim();
  const upper = separator[2].trim();

  return {
    lower: lower === '*' ? null : lower,
    upper: upper === '*' ? null : upper,
  };
}
