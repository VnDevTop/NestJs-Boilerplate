import { UnsupportedFieldError } from '../errors.js';
import type { SearchField, SearchFieldRegistry } from '../field-registry.js';
import type { SearchQuery } from '../ast.js';

/**
 * A question about one row, answered with a yes or a no.
 *
 * **The in-memory translator is the reference for what a query means.** It is
 * the translator that can be tested without a database, and the one a
 * translator's behaviour is compared against — the Postgres path has to agree
 * with it about which rows match, or one of them is answering a different
 * question.
 */
export type SearchPredicate = (row: Record<string, unknown>) => boolean;

/**
 * Turns a parsed query into a question about one row.
 *
 * **A row is read by its column**, because the column is the name the values
 * live under — in this codebase the column and the entity's property are the
 * same name, and a derived field that is not a column is Phase 31's addition
 * to the descriptor.
 *
 * **A boost does not change the answer.** A boost and a weight change the
 * order of the results, not which rows match; the ranking is Phase 29's
 * business, and a predicate has no order to change.
 */
export function translateToPredicate(
  query: SearchQuery,
  registry: SearchFieldRegistry,
): SearchPredicate {
  return build(query, registry);
}

function build(
  query: SearchQuery,
  registry: SearchFieldRegistry,
): SearchPredicate {
  switch (query.type) {
    case 'matchAll':
      return () => true;

    case 'boolean': {
      if (query.operator === 'not') {
        const operand = build(query.operand, registry);

        return (row) => !operand(row);
      }

      const left = build(query.left, registry);
      const right = build(query.right, registry);

      return query.operator === 'and'
        ? (row) => left(row) && right(row)
        : (row) => left(row) || right(row);
    }

    case 'boost':
      // The weight is a ranking concern, and a predicate has no ranking.
      return build(query.query, registry);

    case 'field':
      return termPredicate(query.field, query.value, query.fuzzy, registry);

    case 'phrase':
      return phrasePredicate(query.field, query.terms, registry);

    case 'wildcard':
      return wildcardPredicate(query.field, query.pattern, registry);

    case 'exists':
      return existsPredicate(query.field, registry);

    case 'range':
      return rangePredicate(query, registry);
  }
}

/**
 * A term.
 *
 * **How it is compared depends on the field's type.** A text field is a
 * substring, case-insensitively; a keyword is the whole value, exactly; a
 * number is a number.
 */
function termPredicate(
  name: string | null,
  value: string,
  fuzzy: number | undefined,
  registry: SearchFieldRegistry,
): SearchPredicate {
  const field = fieldForTerm(name, registry);

  if (fuzzy !== undefined) {
    if (field.type !== 'text' && field.type !== 'keyword') {
      throw new UnsupportedFieldError(
        name ?? registry.defaultField,
        'a number, a date and a boolean have no words to be near',
      );
    }

    const distance = fuzzy;

    return (row) => {
      const haystack = wordsOf(textOf(row, field));

      return haystack.some((word) => levenshtein(word, value) <= distance);
    };
  }

  switch (field.type) {
    case 'text':
      return (row) =>
        textOf(row, field).toLowerCase().includes(value.toLowerCase());

    case 'keyword':
    case 'uuid':
      return (row) => textOf(row, field) === value;

    case 'number':
      return (row) => numberOf(row, field) === Number(value);

    case 'date':
      return (row) => dateOf(row, field).getTime() === dateValue(value);

    case 'boolean':
      return (row) => booleanOf(row, field) === booleanValue(value);
  }
}

/**
 * A phrase: the words, in order, next to each other.
 *
 * **On a field that is not text, a phrase of one word is that word.** A
 * keyword is one value, a date is one value, and a quoted value is how a value
 * with a colon or a space in it is written — so a single-word phrase is an
 * equality there, exactly as a term is. More than one word is refused: "the
 * words of a number" is not a question.
 */
function phrasePredicate(
  name: string | null,
  terms: readonly string[],
  registry: SearchFieldRegistry,
): SearchPredicate {
  const field = registry.resolve(name);

  if (field.type !== 'text') {
    if (terms.length > 1) {
      throw new UnsupportedFieldError(
        name ?? registry.defaultField,
        'a phrase is words in a row, and this field is not text',
      );
    }

    const single = terms[0];

    return single === undefined
      ? () => true
      : termPredicate(name, single, undefined, registry);
  }

  if (!field.searchable) {
    throw new UnsupportedFieldError(
      name ?? registry.defaultField,
      'is not searchable',
    );
  }

  const phrase = terms.join(' ').toLowerCase();

  return (row) => textOf(row, field).toLowerCase().includes(phrase);
}

/**
 * A wildcard: a pattern, where `*` is any run and `?` is any one character.
 *
 * **The whole value has to match.** A wildcard that matched anywhere in the
 * value would make `*a*` match every address, and a query that matches
 * everything is a query that returns the table.
 */
function wildcardPredicate(
  name: string | null,
  pattern: string,
  registry: SearchFieldRegistry,
): SearchPredicate {
  const field = registry.searchableField(name);

  if (field.type !== 'text' && field.type !== 'keyword') {
    throw new UnsupportedFieldError(
      name ?? registry.defaultField,
      'a number, a date and a boolean have no pattern to match',
    );
  }

  const expression = wildcardToRegExp(pattern, field.type === 'keyword');

  return (row) => expression.test(textOf(row, field));
}

/** The field has a value. */
function existsPredicate(
  name: string,
  registry: SearchFieldRegistry,
): SearchPredicate {
  const field = registry.filterableField(name);

  return (row) => {
    const value = row[field.column];

    return value !== null && value !== undefined && value !== '';
  };
}

/**
 * A range.
 *
 * **The bounds are read as the field's type.** A number range compares
 * numbers and a date range compares timestamps; comparing them as strings would
 * make `10` and `9` order the wrong way round.
 */
function rangePredicate(
  query: Extract<SearchQuery, { type: 'range' }>,
  registry: SearchFieldRegistry,
): SearchPredicate {
  const field = registry.filterableField(query.field);

  switch (field.type) {
    case 'number': {
      const lower = query.lower === null ? null : Number(query.lower);
      const upper = query.upper === null ? null : Number(query.upper);

      return (row) => {
        const value = numberOf(row, field);

        if (lower !== null) {
          const ok = query.inclusiveLower ? value >= lower : value > lower;

          if (!ok) {
            return false;
          }
        }

        if (upper !== null) {
          const ok = query.inclusiveUpper ? value <= upper : value < upper;

          if (!ok) {
            return false;
          }
        }

        return true;
      };
    }

    case 'date': {
      const lower = query.lower === null ? null : dateValue(query.lower);
      const upper = query.upper === null ? null : dateValue(query.upper);

      return (row) => {
        const value = dateOf(row, field).getTime();

        if (lower !== null) {
          const ok = query.inclusiveLower ? value >= lower : value > lower;

          if (!ok) {
            return false;
          }
        }

        if (upper !== null) {
          const ok = query.inclusiveUpper ? value <= upper : value < upper;

          if (!ok) {
            return false;
          }
        }

        return true;
      };
    }

    case 'text':
    case 'keyword':
    case 'uuid': {
      const lower = query.lower;
      const upper = query.upper;

      return (row) => {
        const value = textOf(row, field);

        if (lower !== null) {
          const ok = query.inclusiveLower ? value >= lower : value > lower;

          if (!ok) {
            return false;
          }
        }

        if (upper !== null) {
          const ok = query.inclusiveUpper ? value <= upper : value < upper;

          if (!ok) {
            return false;
          }
        }

        return true;
      };
    }

    case 'boolean':
      throw new UnsupportedFieldError(
        query.field ?? registry.defaultField,
        'a boolean has no range',
      );
  }
}

/**
 * The field a term is compared against.
 *
 * **The type decides whether a term is a match or a comparison.** A text field
 * is matched as a substring, so it has to be searchable; every other type is
 * compared for equality, so it has to be filterable. One rule, and the flag
 * that matters follows from the type rather than being a second thing to get
 * right.
 */
function fieldForTerm(
  name: string | null,
  registry: SearchFieldRegistry,
): SearchField {
  const field = registry.resolve(name);

  return field.type === 'text'
    ? registry.searchableField(name)
    : registry.filterableField(name);
}

/** The value of a text-ish field, as a string. */
function textOf(row: Record<string, unknown>, field: SearchField): string {
  const value = row[field.column];

  return value === null || value === undefined ? '' : String(value);
}

/** The value of a number field. */
function numberOf(row: Record<string, unknown>, field: SearchField): number {
  const value = Number(row[field.column]);

  return Number.isFinite(value) ? value : Number.NaN;
}

/** The value of a date field, as a timestamp. */
function dateOf(row: Record<string, unknown>, field: SearchField): Date {
  const value = row[field.column];

  if (value instanceof Date) {
    return value;
  }

  return new Date(String(value ?? ''));
}

/** The value of a boolean field. */
function booleanOf(row: Record<string, unknown>, field: SearchField): boolean {
  return row[field.column] === true;
}

/** A date value, as a timestamp. */
function dateValue(value: string): number {
  return new Date(value).getTime();
}

/** A boolean value. */
function booleanValue(value: string): boolean {
  return value.toLowerCase() === 'true';
}

/** The words of a value, for a fuzzy match. */
function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/**
 * The edit distance between two words.
 *
 * **Two rows, one cell.** The classic implementation, and the reason it is here
 * rather than in a package: the search language's `~` means *exactly* this
 * distance, and a package that computed a different thing — a similarity, a
 * normalised score — would answer a different question.
 */
export function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from<number>({ length: right.length + 1 });

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;

      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }

    previous = current;
    current = Array.from<number>({ length: right.length + 1 });
  }

  return previous[right.length] ?? 0;
}

/**
 * A wildcard pattern as a regular expression.
 *
 * **The pattern is escaped, so its own wildcards are the only wildcards.** A
 * user who typed `a.b` meant a dot and not "any character", and a search that
 * treats it as a wildcard is a search that matches rows nobody asked for.
 */
function wildcardToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let source = '';

  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
      continue;
    }

    if (character === '?') {
      source += '.';
      continue;
    }

    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`, caseSensitive ? '' : 'iu');
}
