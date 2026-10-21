import {
  InvalidSearchValueError,
  UnsupportedFieldError,
  UnsupportedOperationError,
} from '../errors.js';
import type { SearchField, SearchFieldRegistry } from '../field-registry.js';
import type { SearchQuery } from '../ast.js';
import { escapeLikeTerm } from '../../query/apply-criteria.js';

/**
 * The text search configuration this application uses.
 *
 * **`simple`, and not `english`.** The english configuration stems and drops
 * stop words, so a search for "users" would not find "user" and a search for
 * "the" would find nothing at all. A search box over names and addresses wants
 * the words as they were typed.
 *
 * **It is a literal, and it has to be.** A generated column's expression has
 * to be immutable, and `to_tsvector(regconfig, text)` is only immutable for a
 * literal configuration — a configuration in a column would make the column
 * stable rather than immutable, and Postgres would refuse to store it.
 */
export const TEXT_SEARCH_CONFIGURATION = 'simple';

/**
 * The four weights postgres has, and the bands a field's weight falls into.
 *
 * **A field's weight is a number and postgres has four letters.** The number
 * says how much the field counts; the letter says which of the four bands it
 * lands in, because `setweight` takes a letter and `ts_rank` takes an array of
 * four numbers. The bands are postgres's own defaults — 1.0, 0.4, 0.2 and
 * 0.1 — so a field's weight of 0.5 and one of 0.6 both mean "B", and the
 * difference between them is not one postgres can express.
 */
export const SEARCH_WEIGHT_BANDS: readonly {
  readonly letter: 'A' | 'B' | 'C' | 'D';
  readonly atLeast: number;
}[] = [
  { letter: 'A', atLeast: 0.75 },
  { letter: 'B', atLeast: 0.5 },
  { letter: 'C', atLeast: 0.25 },
  { letter: 'D', atLeast: 0 },
];

/**
 * The letter a field's weight falls into.
 *
 * **The highest band that fits**, so a weight of 1 is 'A' and a weight of 0
 * is 'D'.
 */
export function weightLetter(weight: number): 'A' | 'B' | 'C' | 'D' {
  const band = SEARCH_WEIGHT_BANDS.find((entry) => weight >= entry.atLeast);

  return band?.letter ?? 'D';
}

/**
 * A query, as a filter and a rank.
 *
 * **The filter says which rows match, and the rank says which of them came
 * first.** They are separate because they answer separate questions, and
 * because the rank is the part that needs the document.
 */
export interface FullTextTranslation {
  /** The WHERE fragment. */
  readonly filter: string;
  /** The rank expression, for ordering the results. */
  readonly rank: string;
  /** The values to bind. */
  readonly parameters: Record<string, unknown>;
}

export interface FullTextOptions {
  /** The table alias the columns are qualified with. */
  readonly alias?: string;
}

/**
 * Turns a parsed query into a filter and a rank over the document.
 *
 * ## The tsquery is built from the tree
 *
 * **The terms are parameters, and the operators are ours.** A term goes in as
 * `plainto_tsquery('simple', :p0)` and a phrase as
 * `phraseto_tsquery('simple', :p0)`, and the `&&`, `||` and `!!` between them
 * are written by the translator. `plainto_tsquery` and `phraseto_tsquery` are
 * the two functions that do **not** read their argument as an expression, so a
 * term containing `&` or `|` or `!` is text and never becomes an operator.
 * `to_tsquery` would have been the obvious choice and it is the wrong one: it
 * parses its argument, so a term could add a clause to the query.
 *
 * ## The field scoping is the document's
 *
 * **One document per entity, so a field-scoped term matches the document.**
 * The document holds every searchable field's text, with each field's weight
 * baked in, and one GIN index over it answers a word search over the whole
 * entity. The cost is that `email:ada` also matches a row whose *name*
 * contains "ada" — the weights decide the order of the results, not which rows
 * match. A search that needs a field's own text needs its own column, and
 * that is one column and one index per field.
 *
 * ## The rank is postgres's
 *
 * **`ts_rank(document, tsquery)`**, with the boost multiplying it. The
 * weights are in the document, so the rank is the one postgres computes for
 * the whole match; a boost multiplies it because postgres ranks a match rather
 * than a clause.
 */
export function translateToFullText(
  query: SearchQuery,
  registry: SearchFieldRegistry,
  options: FullTextOptions = {},
): FullTextTranslation {
  const builder = new FullTextBuilder(registry, options.alias);

  return builder.translate(query);
}

class FullTextBuilder {
  readonly parameters: Record<string, unknown> = {};

  private counter = 0;
  private readonly alias: string | undefined;

  constructor(
    private readonly registry: SearchFieldRegistry,
    alias: string | undefined,
  ) {
    if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(
        `"${alias}" is not a table alias. An alias is an identifier: a letter ` +
          'or an underscore, then letters, digits and underscores.',
      );
    }

    this.alias = alias;
  }

  translate(query: SearchQuery): FullTextTranslation {
    const filter = this.filterOf(query);
    const tsquery = this.tsQueryOf(query);
    const boost = boostOf(query);
    const rank =
      tsquery === null ? '0' : `ts_rank(${this.document()}, ${tsquery})`;

    return {
      filter,
      rank: boost === 1 ? rank : `(${rank} * ${boost})`,
      parameters: this.parameters,
    };
  }

  /**
   * The filter: the whole tree, with the text clauses matched against the
   * document.
   *
   * **One walk, not two.** The text clauses and the other clauses cannot be
   * split into two parallel trees and combined afterwards, because `NOT` does
   * not distribute: `NOT (a AND b)` is not `NOT a AND NOT b`. So the structure
   * is walked once, and each clause contributes what it is.
   */
  private filterOf(node: SearchQuery): string {
    switch (node.type) {
      case 'matchAll':
        return 'TRUE';

      case 'boolean': {
        if (node.operator === 'not') {
          return `NOT (${this.filterOf(node.operand)})`;
        }

        const left = this.filterOf(node.left);
        const right = this.filterOf(node.right);

        return `(${left} ${node.operator === 'and' ? 'AND' : 'OR'} ${right})`;
      }

      case 'boost':
        // A boost changes the order of the results, not which rows match.
        return this.filterOf(node.query);

      case 'field':
        return this.termFilter(node);

      case 'phrase':
        return this.phraseFilter(node);

      case 'wildcard':
        return this.wildcardFilter(node);

      case 'exists': {
        const field = this.registry.filterableField(node.field);

        return `${this.column(field)} IS NOT NULL`;
      }

      case 'range':
        return this.rangeFilter(node);
    }
  }

  /**
   * The tsquery: the text half of the tree.
   *
   * **A clause with no text contributes nothing**, so a query that is only
   * ranges has no tsquery and no rank — and saying so is better than building
   * an empty one, which postgres refuses to parse.
   */
  private tsQueryOf(node: SearchQuery): string | null {
    switch (node.type) {
      case 'matchAll':
        return null;

      case 'boolean': {
        if (node.operator === 'not') {
          const operand = this.tsQueryOf(node.operand);

          return operand === null ? null : `!!(${operand})`;
        }

        const left = this.tsQueryOf(node.left);
        const right = this.tsQueryOf(node.right);

        if (left === null) {
          return right;
        }

        if (right === null) {
          return left;
        }

        return `(${left} ${node.operator === 'and' ? '&&' : '||'} ${right})`;
      }

      case 'boost':
        return this.tsQueryOf(node.query);

      case 'field':
        return this.isTextField(node.field)
          ? this.termTsQuery(node.value)
          : null;

      case 'phrase':
        return this.isTextField(node.field)
          ? this.phraseTsQuery(node.terms.join(' '))
          : null;

      case 'wildcard':
      case 'exists':
      case 'range':
        return null;
    }
  }

  /** A term, as a filter. */
  private termFilter(node: Extract<SearchQuery, { type: 'field' }>): string {
    const field = this.fieldForTerm(node.field);

    if (node.fuzzy !== undefined) {
      throw new UnsupportedOperationError(
        'a fuzzy term',
        'postgres has no edit distance without an extension, and a similarity ' +
          'is a different function',
      );
    }

    if (field.type === 'text') {
      return `(${this.document()} @@ ${this.termTsQuery(node.value)})`;
    }

    return this.comparisonFilter(field, node.value);
  }

  /** A phrase, as a filter. */
  private phraseFilter(node: Extract<SearchQuery, { type: 'phrase' }>): string {
    const field = this.registry.searchableField(node.field);

    if (field.type !== 'text') {
      throw new UnsupportedFieldError(
        node.field ?? this.registry.defaultField,
        'a phrase is words in a row, and this field is not text',
      );
    }

    return `(${this.document()} @@ ${this.phraseTsQuery(node.terms.join(' '))})`;
  }

  /**
   * A wildcard, as a filter.
   *
   * **A tsquery has no wildcard**, so this one is a pattern match on the
   * column — unindexed, and the price of a query the language offers and
   * postgres's full text does not.
   */
  private wildcardFilter(
    node: Extract<SearchQuery, { type: 'wildcard' }>,
  ): string {
    const field = this.registry.searchableField(node.field);

    if (field.type !== 'text' && field.type !== 'keyword') {
      throw new UnsupportedFieldError(
        node.field ?? this.registry.defaultField,
        'a number, a date and a boolean have no pattern to match',
      );
    }

    const pattern = escapeLikeTerm(node.pattern)
      .replace(/\*/g, '%')
      .replace(/\?/g, '_');

    return `${this.column(field)} ILIKE ${this.bind(pattern)} ESCAPE '\\'`;
  }

  /** A range, as a filter. */
  private rangeFilter(node: Extract<SearchQuery, { type: 'range' }>): string {
    const field = this.registry.filterableField(node.field);

    if (field.type === 'boolean') {
      throw new UnsupportedFieldError(
        node.field ?? this.registry.defaultField,
        'a boolean has no range',
      );
    }

    const column = this.column(field);
    const parts: string[] = [];

    if (node.lower !== null) {
      const operator = node.inclusiveLower ? '>=' : '>';

      parts.push(
        `${column} ${operator} ${this.bind(this.bound(node.lower, field))}`,
      );
    }

    if (node.upper !== null) {
      const operator = node.inclusiveUpper ? '<=' : '<';

      parts.push(
        `${column} ${operator} ${this.bind(this.bound(node.upper, field))}`,
      );
    }

    return parts.length === 0 ? 'TRUE' : parts.join(' AND ');
  }

  /** A term, as a tsquery. */
  private termTsQuery(value: string): string {
    return `plainto_tsquery('${TEXT_SEARCH_CONFIGURATION}', ${this.bind(value)})`;
  }

  /** A phrase, as a tsquery. */
  private phraseTsQuery(value: string): string {
    return `phraseto_tsquery('${TEXT_SEARCH_CONFIGURATION}', ${this.bind(value)})`;
  }

  /** The field a term is compared against. */
  private fieldForTerm(name: string | null): SearchField {
    const field = this.registry.resolve(name);

    return field.type === 'text'
      ? this.registry.searchableField(name)
      : this.registry.filterableField(name);
  }

  /** True for a field whose text goes into the document. */
  private isTextField(name: string | null): boolean {
    return this.registry.resolve(name).type === 'text';
  }

  /** A comparison against a field that is not text. */
  private comparisonFilter(field: SearchField, value: string): string {
    const column = this.column(field);

    switch (field.type) {
      case 'text':
        return `${column} ILIKE ${this.bind(`%${escapeLikeTerm(value)}%`)} ESCAPE '\\'`;

      case 'keyword':
      case 'uuid':
        return `${column} = ${this.bind(value)}`;

      case 'number':
        return `${column} = ${this.bind(this.numberValue(value, field))}`;

      case 'date':
        return `${column} = ${this.bind(this.dateValue(value, field))}`;

      case 'boolean':
        return `${column} = ${this.bind(this.booleanValue(value, field))}`;
    }
  }

  /** A bound value, converted to the field's type. */
  private bound(value: string, field: SearchField): unknown {
    switch (field.type) {
      case 'number':
        return this.numberValue(value, field);

      case 'date':
        return this.dateValue(value, field);

      case 'boolean':
        return this.booleanValue(value, field);

      default:
        return value;
    }
  }

  /** A number, or an error naming the field and the value. */
  private numberValue(value: string, field: SearchField): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      throw new InvalidSearchValueError(field.column, value, 'number');
    }

    return parsed;
  }

  /** A timestamp, or an error naming the field and the value. */
  private dateValue(value: string, field: SearchField): Date {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidSearchValueError(field.column, value, 'date');
    }

    return parsed;
  }

  /** A boolean, or an error naming the field and the value. */
  private booleanValue(value: string, field: SearchField): boolean {
    const normalised = value.toLowerCase();

    if (normalised !== 'true' && normalised !== 'false') {
      throw new InvalidSearchValueError(field.column, value, 'boolean');
    }

    return normalised === 'true';
  }

  /** Binds a value and returns the placeholder that stands for it. */
  private bind(value: unknown): string {
    const name = `p${this.counter}`;

    this.counter += 1;
    this.parameters[name] = value;

    return `:${name}`;
  }

  /** The document column, qualified with the alias when there is one. */
  private document(): string {
    const column = this.registry.document();

    return this.alias === undefined
      ? `"${column}"`
      : `"${this.alias}"."${column}"`;
  }

  /** A column, qualified with the alias when there is one. */
  private column(field: SearchField): string {
    return this.alias === undefined
      ? `"${field.column}"`
      : `"${this.alias}"."${field.column}"`;
  }
}

/**
 * The product of the boosts in a tree.
 *
 * **Postgres ranks a whole match rather than a clause**, so a boost cannot
 * weigh one clause of a boolean against another. Multiplying the score of the
 * match is the closest thing postgres can do, and it is what a client that
 * boosts a whole query means.
 */
function boostOf(node: SearchQuery): number {
  switch (node.type) {
    case 'boost':
      return node.boost * boostOf(node.query);

    case 'boolean': {
      if (node.operator === 'not') {
        return boostOf(node.operand);
      }

      return boostOf(node.left) * boostOf(node.right);
    }

    default:
      return 1;
  }
}

/**
 * The expression that builds the document.
 *
 * **One `setweight` per searchable field, joined with `||`.** The weights are
 * in the document, so `ts_rank` can tell a match on the address from a match
 * on the name — which is the whole point of a weighted document over a plain
 * one.
 *
 * **Only the searchable fields.** A field that is not searchable is not in the
 * document at all, and that is the difference between a text column and a
 * credential: a password hash in the document would be searchable, and a
 * document is exactly the thing a search box reads.
 *
 * The expression is what the migration creates the column with, and the
 * registry's weights are what the letters come from, so the two cannot drift:
 * a spec compares the expression this builds with the one in the migration.
 */
export function buildDocumentExpression(
  registry: SearchFieldRegistry,
  options: { alias?: string } = {},
): string {
  const parts: string[] = [];

  for (const [, field] of registry.entries()) {
    if (!field.searchable) {
      continue;
    }

    if (field.type !== 'text' && field.type !== 'keyword') {
      continue;
    }

    const column =
      options.alias === undefined
        ? `"${field.column}"`
        : `"${options.alias}"."${field.column}"`;

    parts.push(
      `setweight(to_tsvector('${TEXT_SEARCH_CONFIGURATION}', coalesce(${column}, '')), '${weightLetter(field.weight)}')`,
    );
  }

  if (parts.length === 0) {
    throw new Error(
      'The registry has no searchable text, so there is no document to build.',
    );
  }

  return parts.join(' || ');
}
