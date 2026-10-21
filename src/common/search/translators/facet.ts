import { DEFAULT_LIMIT, MAX_LIMIT } from '../../constants/index.js';
import type { SearchFieldRegistry } from '../field-registry.js';
import type { SearchQuery } from '../ast.js';
import { translateToFullText } from './full-text.js';

/**
 * A facet: the counts of the rows that match, grouped by one field.
 *
 * **The counts come from the same filter as the results.** A facet that counted
 * a different set of rows would be a number about one thing next to a list
 * about another, and the pair would be read as one answer.
 */
export interface FacetTranslation {
  /** The SQL fragment. */
  readonly sql: string;
  /** The values to bind. */
  readonly parameters: Record<string, unknown>;
}

/**
 * A named-parameter query as one a raw driver call can run.
 *
 * **TypeORM's query builder takes named parameters and its raw `query()` does
 * not.** The builder binds `:p0`; the raw call goes straight to the driver,
 * which takes its own positional placeholders — and postgres's are `$1`.
 *
 * The search layer's SQL is postgres's anyway: the full-text translator emits
 * `plainto_tsquery`, `ts_rank` and `::int`, none of which exist in another
 * database, so a placeholder that is not postgres's would be the least of it.
 *
 * **Only the placeholders are touched.** The values stay parameters — the
 * rewrite changes `:p0` to `$1` and nothing else — and the text it rewrites is
 * the translator's own, not a client's.
 */
export function toRawQuery(
  sql: string,
  parameters: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];

  // The lookbehind is the point of the pattern: postgres writes a cast as `::`
  // — `count(*)::int` — and the second colon is not a placeholder. A pattern
  // that did not say so would rewrite the cast into a parameter and the query
  // would fail with an error about a parameter rather than about the mistake.
  const rewritten = sql.replace(/(?<!:):(\w+)/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
      // A placeholder with no value is a bug in the translator, and leaving it
      // would turn it into a SQL error about a parameter rather than about the
      // mistake.
      throw new Error(
        `The query has a placeholder for "${name}" and no value for it.`,
      );
    }

    values.push(parameters[name]);

    return `$${values.length}`;
  });

  return { sql: rewritten, values };
}

export interface FacetOptions {
  /** The table the rows come from. */
  readonly table: string;
  /** The table alias, when the query joins. */
  readonly alias?: string;
  /** How many values to return. */
  readonly limit?: number;
}

/**
 * Turns a parsed query and a field into the counts of the matching rows.
 *
 * **The filter is the one the results used**, because the facet answers
 * "of the rows you are looking at, how many are in each group" — and that
 * question is only true if the facet counted the same rows.
 *
 * **The value is cast to text**, so a client does not have to know whether the
 * field it asked for is a string, a number or a boolean. The grouping is on the
 * column rather than on the cast, so the index on it can still be used.
 *
 * **The table name is checked**, because it is interpolated into SQL. The
 * search layer's other tables are the application schema's, and a table name
 * that is not an identifier is either a mistake or something worse.
 */
export function translateToFacet(
  query: SearchQuery,
  registry: SearchFieldRegistry,
  facet: string,
  options: FacetOptions,
): FacetTranslation {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.table)) {
    throw new Error(
      `"${options.table}" is not a table name. A table is interpolated into ` +
        'SQL, so it has to be an identifier.',
    );
  }

  if (
    options.alias !== undefined &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.alias)
  ) {
    throw new Error(
      `"${options.alias}" is not a table alias. An alias is an identifier: a ` +
        'letter or an underscore, then letters, digits and underscores.',
    );
  }

  // The facet is grouped by a field, so it has to be one that can be
  // compared — and the filter it applies is the one the results use.
  const field = registry.filterableField(facet);
  const { filter, parameters } = translateToFullText(query, registry, {
    alias: options.alias,
  });

  const column =
    options.alias === undefined
      ? `"${field.column}"`
      : `"${options.alias}"."${field.column}"`;

  const table =
    options.alias === undefined
      ? `"${options.table}"`
      : `"${options.table}" "${options.alias}"`;

  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );

  return {
    sql:
      `SELECT CAST(${column} AS text) AS "value", count(*)::int AS "count" ` +
      `FROM ${table} WHERE ${filter} ` +
      // The group is the column, not the cast, so the index on it can be used.
      `GROUP BY ${column} ` +
      `ORDER BY "count" DESC, "value" ASC ` +
      `LIMIT ${limit}`,
    parameters,
  };
}
