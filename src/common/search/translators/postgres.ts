import {
  InvalidSearchValueError,
  UnsupportedFieldError,
  UnsupportedOperationError,
} from '../errors.js';
import type { SearchField, SearchFieldRegistry } from '../field-registry.js';
import type { SearchQuery } from '../ast.js';
import { escapeLikeTerm } from '../../query/apply-criteria.js';

/**
 * A query, as SQL and the values to bind with it.
 *
 * **The two halves are the whole contract.** The SQL carries column names and
 * operators, both of which come from the field registry, and never a value. The
 * values are parameters, and a parameter is the only place a value can go
 * without being able to change the meaning of the statement.
 */
export interface TranslatedQuery {
  /** The SQL fragment, with `:name` placeholders. */
  readonly sql: string;
  /** The values the placeholders stand for. */
  readonly parameters: Record<string, unknown>;
}

export interface SqlTranslationOptions {
  /**
   * The table alias the columns are qualified with.
   *
   * **Optional, and checked when it is there.** An unqualified column is
   * ambiguous the moment the query joins a second table, and the alias is
   * interpolated into SQL, so it has to be an identifier this application
   * wrote.
   */
  readonly alias?: string;
}

/**
 * Turns a parsed query into SQL and the values to bind with it.
 *
 * ## The two rules
 *
 * **Every value is a parameter.** The SQL text carries column names and
 * operators and nothing else, and every value the client sent is bound. This
 * is the property the whole phase exists for: a search is a client's input, and
 * a client's input that reaches SQL as text is a client who can read the
 * database.
 *
 * **The column names come from the registry, never from the query.** A field
 * name in a query is the client's input, and the only way it can become SQL is
 * by being looked up in the allow-list first. A name that is not declared is
 * an error, not a dropped clause.
 *
 * ## What it refuses
 *
 * **A fuzzy term.** Postgres has no edit distance without an extension, and a
 * trigram similarity is a different function that would answer a different
 * question — so a fuzzy term is refused here rather than matched exactly and
 * called a match. The in-memory translator implements it exactly, and the two
 * differ in that one respect on purpose.
 */
export function translateToSql(
  query: SearchQuery,
  registry: SearchFieldRegistry,
  options: SqlTranslationOptions = {},
): TranslatedQuery {
  const builder = new SqlBuilder(options.alias);

  return {
    sql: buildFragment(query, registry, builder),
    parameters: builder.parameters,
  };
}

/**
 * The parameters and the names of the columns.
 *
 * **A class rather than a pair of return values**, because the parameter names
 * have to be unique across the whole fragment and a counter is the only thing
 * that can guarantee it. A name built from the field would collide the moment
 * a query named the same field twice.
 */
class SqlBuilder {
  readonly parameters: Record<string, unknown> = {};

  private counter = 0;
  private readonly alias: string | undefined;

  constructor(alias: string | undefined) {
    if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      // The alias is interpolated into SQL, exactly like a column, so it is
      // checked the same way. A programming error rather than a client one.
      throw new Error(
        `"${alias}" is not a table alias. An alias is an identifier: a letter ` +
          'or an underscore, then letters, digits and underscores.',
      );
    }

    this.alias = alias;
  }

  /** Binds a value and returns the placeholder that stands for it. */
  bind(value: unknown): string {
    const name = `p${this.counter}`;

    this.counter += 1;
    this.parameters[name] = value;

    return `:${name}`;
  }

  /** The column, qualified with the alias when there is one. */
  column(field: SearchField): string {
    return this.alias === undefined
      ? `"${field.column}"`
      : `"${this.alias}"."${field.column}"`;
  }
}

function buildFragment(
  query: SearchQuery,
  registry: SearchFieldRegistry,
  builder: SqlBuilder,
): string {
  switch (query.type) {
    case 'matchAll':
      // A query that matches everything matches everything, and saying so in SQL
      // keeps the fragment a boolean expression rather than an empty string.
      return 'TRUE';

    case 'boolean': {
      if (query.operator === 'not') {
        return `NOT (${buildFragment(query.operand, registry, builder)})`;
      }

      const left = buildFragment(query.left, registry, builder);
      const right = buildFragment(query.right, registry, builder);

      return `(${left} ${query.operator === 'and' ? 'AND' : 'OR'} ${right})`;
    }

    case 'boost':
      // A boost changes the order of the results, not which rows match. The
      // ranking is Phase 29's, and this fragment is the filter.
      return buildFragment(query.query, registry, builder);

    case 'field':
      return termFragment(query, registry, builder);

    case 'phrase':
      return phraseFragment(query, registry, builder);

    case 'wildcard':
      return wildcardFragment(query, registry, builder);

    case 'exists': {
      const field = registry.filterableField(query.field);

      return `${builder.column(field)} IS NOT NULL`;
    }

    case 'range':
      return rangeFragment(query, registry, builder);
  }
}

/**
 * A term.
 *
 * **How it is compared depends on the field's type.** A text field is matched
 * as a substring; everything else is compared for equality, and the value is
 * converted to the field's type first — so a number that is not a number is
 * refused here rather than by postgres.
 */
function termFragment(
  query: Extract<SearchQuery, { type: 'field' }>,
  registry: SearchFieldRegistry,
  builder: SqlBuilder,
): string {
  const field = fieldForTerm(query.field, registry);

  if (query.fuzzy !== undefined) {
    throw new UnsupportedOperationError(
      'a fuzzy term',
      'postgres has no edit distance without an extension, and a similarity ' +
        'is a different function',
    );
  }

  const column = builder.column(field);

  switch (field.type) {
    case 'text': {
      // The wildcards and the escaping are added here, so the caller cannot
      // write a `%` and search the whole column.
      const pattern = `%${escapeLikeTerm(query.value)}%`;

      return `${column} ILIKE ${builder.bind(pattern)} ESCAPE '\\'`;
    }

    case 'keyword':
    case 'uuid': {
      const value =
        field.type === 'uuid' ? uuidValue(query.value, field) : query.value;

      return `${column} = ${builder.bind(value)}`;
    }

    case 'number':
      return `${column} = ${builder.bind(numberValue(query.value, field))}`;

    case 'date':
      return `${column} = ${builder.bind(dateValue(query.value, field))}`;

    case 'boolean':
      return `${column} = ${builder.bind(booleanValue(query.value, field))}`;
  }
}

/**
 * A phrase: the words, in order, next to each other.
 *
 * **On a field that is not text, a phrase of one word is that word.** A
 * keyword is one value, a date is one value, and a quoted value is how a
 * value with a colon or a space in it is written — so a single-word phrase is
 * an equality there, exactly as a term is. More than one word is refused: "the
 * words of a number" is not a question.
 */
function phraseFragment(
  query: Extract<SearchQuery, { type: 'phrase' }>,
  registry: SearchFieldRegistry,
  builder: SqlBuilder,
): string {
  const field = registry.resolve(query.field);

  if (field.type !== 'text') {
    if (query.terms.length > 1) {
      throw new UnsupportedFieldError(
        query.field ?? registry.defaultField,
        'a phrase is words in a row, and this field is not text',
      );
    }

    const single = query.terms[0];

    return single === undefined
      ? 'TRUE'
      : termFragment(
          { type: 'field', field: query.field, value: single },
          registry,
          builder,
        );
  }

  if (!field.searchable) {
    throw new UnsupportedFieldError(
      query.field ?? registry.defaultField,
      'is not searchable',
    );
  }

  const pattern = `%${escapeLikeTerm(query.terms.join(' '))}%`;

  return `${builder.column(field)} ILIKE ${builder.bind(pattern)} ESCAPE '\\'`;
}

/**
 * A wildcard.
 *
 * **The pattern becomes a LIKE pattern, and the user's own wildcards are
 * escaped first.** A `%` the user typed is a literal `%`; the `*` and `?` the
 * user typed are the wildcards. Escaping in the other order would turn the
 * `*` we just converted into a literal.
 */
function wildcardFragment(
  query: Extract<SearchQuery, { type: 'wildcard' }>,
  registry: SearchFieldRegistry,
  builder: SqlBuilder,
): string {
  const field = registry.searchableField(query.field);

  if (field.type !== 'text' && field.type !== 'keyword') {
    throw new UnsupportedFieldError(
      query.field ?? registry.defaultField,
      'a number, a date and a boolean have no pattern to match',
    );
  }

  const pattern = escapeLikeTerm(query.pattern)
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');

  return `${builder.column(field)} ILIKE ${builder.bind(pattern)} ESCAPE '\\'`;
}

/**
 * A range.
 *
 * **The bounds are converted to the field's type**, so a range over numbers
 * compares numbers and a range over dates compares timestamps.
 */
function rangeFragment(
  query: Extract<SearchQuery, { type: 'range' }>,
  registry: SearchFieldRegistry,
  builder: SqlBuilder,
): string {
  const field = registry.filterableField(query.field);

  if (field.type === 'boolean') {
    throw new UnsupportedFieldError(
      query.field ?? registry.defaultField,
      'a boolean has no range',
    );
  }

  const column = builder.column(field);
  const parts: string[] = [];

  if (query.lower !== null) {
    const operator = query.inclusiveLower ? '>=' : '>';
    const value = boundValue(query.lower, field);

    parts.push(`${column} ${operator} ${builder.bind(value)}`);
  }

  if (query.upper !== null) {
    const operator = query.inclusiveUpper ? '<=' : '<';
    const value = boundValue(query.upper, field);

    parts.push(`${column} ${operator} ${builder.bind(value)}`);
  }

  // An open range on both sides is everything, and saying so in SQL keeps the
  // fragment a boolean expression.
  return parts.length === 0 ? 'TRUE' : parts.join(' AND ');
}

/** A bound, converted to the field's type. */
function boundValue(value: string, field: SearchField): unknown {
  switch (field.type) {
    case 'number':
      return numberValue(value, field);

    case 'date':
      return dateValue(value, field);

    case 'boolean':
      return booleanValue(value, field);

    default:
      return value;
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

/** A number, or an error naming the field and the value. */
function numberValue(value: string, field: SearchField): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new InvalidSearchValueError(field.column, value, 'number');
  }

  return parsed;
}

/** A timestamp, or an error naming the field and the value. */
function dateValue(value: string, field: SearchField): Date {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidSearchValueError(field.column, value, 'date');
  }

  return parsed;
}

/** A boolean, or an error naming the field and the value. */
function booleanValue(value: string, field: SearchField): boolean {
  const normalised = value.toLowerCase();

  if (normalised !== 'true' && normalised !== 'false') {
    throw new InvalidSearchValueError(field.column, value, 'boolean');
  }

  return normalised === 'true';
}

/** A uuid, or an error naming the field and the value. */
function uuidValue(value: string, field: SearchField): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new InvalidSearchValueError(field.column, value, 'uuid');
  }

  return value;
}
