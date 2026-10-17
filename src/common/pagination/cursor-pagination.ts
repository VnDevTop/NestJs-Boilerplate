import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../constants/index.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { PageMetaDto, PaginatedResultDto } from './paginated-result.dto.js';
import type { ResolvedSort } from './sort.js';

export interface CursorPageRequest {
  limit: number | undefined;
  cursor?: string;
  sort: ResolvedSort;
  /** Column the total order breaks ties on. Defaults to `id`. */
  idColumn?: string;
}

export interface CursorPage<TEntity extends ObjectLiteral> {
  items: TEntity[];
  meta: PageMetaDto;
}

/**
 * Reads one page of a query builder, keyset style.
 *
 * **Why keyset and not `OFFSET`.** `LIMIT n OFFSET m` makes the database count and
 * discard the first `m` rows on every page, so page 900 of a large table reads
 * nine hundred rows to return twenty. Worse, the count happens inside the same
 * statement as the read, and Postgres is free to evaluate it under a different
 * snapshot: a row inserted between two requests can then appear on page four *and*
 * on page five, or on neither. Keyset paging names the boundary it stopped at, so
 * a concurrent insert ahead of the reader cannot move it, and a row lands on
 * exactly one page or none — which is the property Phase 23 is done when.
 *
 * **`limit + 1` rows, never a count.** The extra row is the entire `hasMore`
 * answer. Whether another page exists is known by looking one row past the end,
 * which is free; it is *not* known by asking how many rows match, which is the
 * expensive query this replaces.
 *
 * **The boundary is `(sort, id)`, compared as a tuple.** The id tie-break is what
 * makes the order total — `createdAt` is not unique, and Postgres is under no
 * obligation to return equal-key rows in a stable order, so a boundary expressed
 * on the sort value alone would either re-read or skip whichever rows share the
 * boundary timestamp.
 *
 * **Both values are parameters.** The sort column comes from an allow-list and the
 * values are bound with `setParameter`, so no part of a client-supplied cursor
 * reaches the SQL text. The identifiers in the fragment are the ones written here,
 * plus the resolved sort column.
 */
export async function paginateByCursor<TEntity extends ObjectLiteral>(
  qb: SelectQueryBuilder<TEntity>,
  request: CursorPageRequest,
): Promise<CursorPage<TEntity>> {
  const limit = clampLimit(request.limit);
  const idColumn = request.idColumn ?? 'id';
  const cursor = decodeCursor(request.cursor);
  const descending = request.sort.direction === 'DESC';

  if (cursor) {
    const operator = descending ? '<' : '>';
    const quotedColumn = `"${request.sort.column}"`;
    const quotedId = `"${idColumn}"`;

    qb.andWhere(
      `(${quotedColumn} ${operator} :cursorValue OR (${quotedColumn} = :cursorValue AND ${quotedId} ${operator} :cursorId))`,
      // Named, rather than positional, because a caller may already have bound
      // parameters on this builder and a positional `?` would shift them.
      { cursorValue: cursor.value, cursorId: cursor.id },
    );
  }

  // The sort column first, then the tie-break, in the same direction. Postgres can
  // scan an index backwards, so one ascending index serves both directions and
  // this does not need two of them.
  qb.orderBy(`"${request.sort.column}"`, request.sort.direction);
  qb.addOrderBy(`"${idColumn}"`, request.sort.direction);

  const rows = await qb.limit(limit + 1).getMany();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore
        ? nextCursorFor(items, request.sort.column, idColumn)
        : null,
    },
  };
}

/**
 * The cursor the next page starts from: the last row of the page just returned.
 *
 * Null-guarded, because a caller can legitimately page with `hasMore` true and
 * then filter the items down to nothing — `GET /users?sort=createdAt` where the
 * caller discards the rows it has already seen is the ordinary case for a client
 * walking a feed. Reading a column off `undefined` would throw on an empty array
 * in exactly the request that is merely unlucky rather than broken.
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
 * string, so the only lossless-enough representation of a timestamp inside one is
 * its ISO form; `toISOString` and Postgres' parser agree to the microsecond, which
 * is the resolution `timestamptz` actually stores.
 *
 * A `null` becomes the empty string rather than the JSON null, because `null` in
 * the payload would mean "this cursor is malformed" to `decodeCursor`. Nullable
 * sort columns are therefore not supported for now, and the allow-list is where
 * that is enforced: `resolveSort` is only ever handed columns declared NOT NULL.
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

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit as number), 1), MAX_LIMIT);
}

/** `paginateByCursor` plus the envelope's own shape, in one call. */
export async function paginatedResult<TEntity extends ObjectLiteral>(
  qb: SelectQueryBuilder<TEntity>,
  request: CursorPageRequest,
): Promise<PaginatedResultDto<TEntity>> {
  const page = await paginateByCursor(qb, request);

  return PaginatedResultDto.of(page.items, page.meta);
}
