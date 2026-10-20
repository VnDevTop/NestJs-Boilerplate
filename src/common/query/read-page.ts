import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import {
  PageMetaDto,
  PaginatedResultDto,
  encodeCursor,
} from '../pagination/index.js';
import type { QueryCriteria } from './query-criteria.js';
import {
  applyCursorBoundary,
  applyFilters,
  applySort,
} from './apply-criteria.js';

/**
 * Reads one page of rows, given a criteria.
 *
 * **The one call a list route makes.** A service that has a repository, an
 * entity's spec and a validated DTO should be able to say "give me a page of
 * this" in one line, and Phase 24 is done when adding a list route needs no
 * new pagination code.
 *
 * **The order of operations is fixed and it matters.** The filters go on first,
 * then the cursor boundary, then the sort. A boundary applied before the
 * filters would be computed over a different row set than the one being paged,
 * and a sort applied before the boundary would make the boundary compare
 * against an order the query is not in.
 */
export interface PageRequest<TEntity extends ObjectLiteral> {
  /** The query builder, already scoped to whatever the route can see. */
  readonly query: SelectQueryBuilder<TEntity>;

  /** The criteria, built from the DTO and the entity's spec. */
  readonly criteria: QueryCriteria;

  /**
   * The alias the query builder uses for its main entity.
   *
   * **Named rather than read off the builder** because a query builder's alias
   * is not part of its public contract, and a name read from somewhere
   * surprising is a name that is sometimes wrong. The route that builds the
   * query knows the alias it used.
   */
  readonly alias: string;

  /**
   * The property the total order breaks ties on.
   *
   * Defaults to `id`, which every entity here has. A route whose entity has a
   * composite key says so.
   */
  readonly idColumn?: string;
}

/**
 * A page of rows and where the next one starts.
 */
export interface QueryPage<TEntity extends ObjectLiteral> {
  readonly items: TEntity[];
  readonly meta: PageMetaDto;
}

/**
 * Reads one page, given a criteria.
 *
 * **Keyset, not offset, and the reason is in `cursor-pagination.ts`.** The
 * boundary is `(sortColumn, id)`, compared as a tuple, with both values bound
 * as parameters, so a row inserted between two page requests cannot appear on
 * both pages or on neither.
 *
 * **`limit + 1` rows.** The extra row is the whole `hasMore` answer, and it is
 * free; a `COUNT(*)` is the expensive query this replaces.
 */
export async function readPage<TEntity extends ObjectLiteral>(
  request: PageRequest<TEntity>,
): Promise<QueryPage<TEntity>> {
  const { query, criteria, alias } = request;
  const idColumn = request.idColumn ?? 'id';

  applyFilters(query, criteria, alias);
  applyCursorBoundary(query, criteria, alias, idColumn);
  applySort(query, criteria, alias, idColumn);

  const rows = await query.limit(criteria.limit + 1).getMany();

  const hasMore = rows.length > criteria.limit;
  const items = hasMore ? rows.slice(0, criteria.limit) : rows;

  return {
    items,
    meta: {
      limit: criteria.limit,
      hasMore,
      nextCursor: hasMore
        ? nextCursorFor(items, criteria.sort.column, idColumn)
        : null,
    },
  };
}

/**
 * Reads one page and returns it in the envelope's shape.
 *
 * **The same call, for a route whose rows are already the response shape.**
 */
export async function readPaginatedResult<TEntity extends ObjectLiteral>(
  request: PageRequest<TEntity>,
): Promise<PaginatedResultDto<TEntity>> {
  const page = await readPage(request);

  return PaginatedResultDto.of(page.items, page.meta);
}

/**
 * The cursor the next page starts from: the last row of the page just returned.
 *
 * **Null-guarded, because a caller can legitimately page with `hasMore` true and
 * then filter the items down to nothing.** Reading a column off `undefined`
 * would throw on an empty array in exactly the request that is merely unlucky
 * rather than broken.
 */
function nextCursorFor<TEntity extends ObjectLiteral>(
  items: TEntity[],
  sortColumn: string,
  idColumn: string,
): string | null {
  const last = items[items.length - 1];

  if (last === undefined) {
    return null;
  }

  return encodeCursor({
    value: toCursorValue(last[sortColumn]),
    id: String(last[idColumn]),
  });
}

/**
 * Renders a column value as the string a cursor carries.
 *
 * **Dates as ISO-8601, and the comparison re-parses it.** A cursor is a JSON
 * string, so the only lossless-enough representation of a timestamp inside one
 * is its ISO form; `toISOString` and Postgres' parser agree to the microsecond,
 * which is the resolution `timestamptz` actually stores.
 *
 * A `null` becomes the empty string rather than the JSON null, because `null` in
 * the payload would mean "this cursor is malformed" to `decodeCursor`. Nullable
 * sort columns are therefore not supported, and the allow-list is where that is
 * enforced: a sortable column is always one declared `NOT NULL`.
 */
function toCursorValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}
