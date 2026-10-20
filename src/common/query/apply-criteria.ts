import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from '../pagination/index.js';
import type { FilterOperator } from './filter-operator.js';
import type { QueryCriteria } from './query-criteria.js';

/**
 * Applies a criteria to a query builder.
 *
 * **Every value is bound.** The SQL text this function produces contains
 * column names and comparison operators, both of which come from the entity's
 * spec, and never a value. A value reaches postgres as a parameter, which is
 * the only place a value can go without being able to change the meaning of
 * the statement.
 *
 * **The column is quoted.** A column named `order` or `user` is a column and
 * not a keyword, and quoting costs nothing for a name that came from source.
 */
export function applyFilters(
  qb: SelectQueryBuilder<ObjectLiteral>,
  criteria: QueryCriteria,
  alias: string,
): SelectQueryBuilder<ObjectLiteral> {
  for (const [index, filter] of criteria.filters.entries()) {
    const column = `"${alias}"."${filter.column}"`;
    const parameter = `filter_${index}`;

    qb.andWhere(
      fragmentFor(filter.operator, column, parameter),
      filter.operator === 'in'
        ? { [parameter]: filter.value as unknown[] }
        : { [parameter]: prepareFilterValue(filter.operator, filter.value) },
    );
  }

  return qb;
}

/**
 * The SQL fragment for one operator.
 *
 * **Written out by hand, one case per operator.** A generic "build a
 * comparison" function would have to take the operator's SQL from somewhere,
 * and everywhere it could come from is a place a value could reach. Here the
 * only thing that varies is the fragment, and every fragment in this function
 * is a literal in the source.
 *
 * **`IN` uses TypeORM's spread syntax.** `:...parameter` with an array value
 * expands into one placeholder per element, so a list of twenty ids is twenty
 * parameters rather than one string of twenty ids — which would be a list
 * nobody could inject into, but also a list postgres could not use an index
 * for.
 */
function fragmentFor(
  operator: FilterOperator,
  column: string,
  parameter: string,
): string {
  switch (operator) {
    case 'eq':
      return `${column} = :${parameter}`;
    case 'neq':
      return `${column} != :${parameter}`;
    case 'gt':
      return `${column} > :${parameter}`;
    case 'gte':
      return `${column} >= :${parameter}`;
    case 'lt':
      return `${column} < :${parameter}`;
    case 'lte':
      return `${column} <= :${parameter}`;
    case 'in':
      return `${column} IN (:...${parameter})`;
    case 'ilike':
      // The escape character is stated rather than assumed. Postgres defaults
      // `LIKE`'s escape to a backslash, but saying so means the behaviour does
      // not depend on the server's configuration.
      return `${column} ILIKE :${parameter} ESCAPE '\\'`;
  }
}

/**
 * Prepares a value for an `ILIKE` comparison.
 *
 * **The wildcards are added and the term is escaped, here.** A caller writing
 * `%term%` themselves would eventually write `%` on its own, and the search
 * would become a full scan of the table with a filter that matches everything.
 *
 * **The escape character is a backslash, and the SQL declares it.** Postgres
 * defaults `LIKE`'s escape to a backslash, but stating it means the behaviour
 * does not depend on the server's configuration. The term's own wildcards — a `%`
 * or `_` the user typed — are escaped, so they match literally.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The value a filter binds, after the operator has had its say.
 *
 * **Only `ilike` changes the value.** Every other operator binds what it was
 * given. The `ilike` case trims the term, escapes it and wraps it in wildcards.
 *
 * **A term that is only whitespace never reaches here.** The builder drops it,
 * because a filter that is dropped is a filter that is not applied — a dropped
 * value would still be bound as a parameter, and `ILIKE '%%'` would match every
 * row.
 */
export function prepareFilterValue(
  operator: FilterOperator,
  value: unknown,
): unknown {
  if (operator !== 'ilike' || typeof value !== 'string') {
    return value;
  }

  const term = value.trim();

  if (term === '') {
    // `undefined` is the marker for "no filter", and the builder reads it that
    // way. The value is dropped before it reaches the query, so there is no
    // fragment and no parameter.
    return undefined;
  }

  return `%${escapeLikeTerm(term)}%`;
}

/**
 * The keyset boundary, as a condition on the query builder.
 *
 * **The tuple is `(sortColumn, id)` and both halves are compared.** A boundary
 * on the sort column alone is not a total order, and a row that ties with the
 * boundary is either re-read or skipped depending on which side the plan
 * happens to fall. The id makes the order total.
 *
 * **The direction follows the sort.** A descending list walks backwards, and a
 * boundary that compared in the other direction would return the whole table.
 */
export function applyCursorBoundary(
  qb: SelectQueryBuilder<ObjectLiteral>,
  criteria: QueryCriteria,
  alias: string,
  idColumn = 'id',
): SelectQueryBuilder<ObjectLiteral> {
  if (criteria.cursor === undefined) {
    return qb;
  }

  const cursor = decodeCursor(criteria.cursor);
  const descending = criteria.sort.direction === 'DESC';
  const operator = descending ? '<' : '>';

  const sortColumn = `"${alias}"."${criteria.sort.column}"`;
  const id = `"${alias}"."${idColumn}"`;

  qb.andWhere(
    `(${sortColumn} ${operator} :cursorValue OR (${sortColumn} = :cursorValue AND ${id} ${operator} :cursorId))`,
    { cursorValue: cursor?.value, cursorId: cursor?.id },
  );

  return qb;
}

/**
 * The sort, applied to the query builder.
 *
 * **The id is the tie-break, in the same direction.** The boundary compares
 * `(sortColumn, id)`, so the order has to be the same tuple or the comparison
 * walks off the end of the list.
 */
export function applySort(
  qb: SelectQueryBuilder<ObjectLiteral>,
  criteria: QueryCriteria,
  alias: string,
  idColumn = 'id',
): SelectQueryBuilder<ObjectLiteral> {
  qb.orderBy(`"${alias}"."${criteria.sort.column}"`, criteria.sort.direction);
  qb.addOrderBy(`"${alias}"."${idColumn}"`, criteria.sort.direction);

  return qb;
}
