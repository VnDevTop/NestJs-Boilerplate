import { BadRequestException } from '@nestjs/common';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../constants/index.js';
import { decodeCursor } from '../pagination/index.js';
import type { FilterOperator } from './filter-operator.js';
import type {
  QueryCriteria,
  ResolvedFilter,
  ResolvedSort,
} from './query-criteria.js';
import type { QuerySpec } from './query-spec.js';

/**
 * The request shape a criteria builder reads.
 *
 * **Structural, not a class.** A criteria builder takes whatever the route's
 * DTO happens to be and reads the fields it knows about. The DTO has already
 * been validated by the global pipe, so the builder's job is the mapping and
 * not the checking — a second layer of validation would be a second set of
 * rules to keep in step with the first.
 *
 * **The filter values are read by name, from a record.** A DTO is a class, and
 * a class instance does not satisfy an index signature, so the builder cannot
 * ask for `source['role']` and have the type system allow it. `criteriaSourceFrom`
 * is the seam: it turns the DTO into the record the builder reads, and it is the
 * one place that knows a DTO is a class.
 */
export interface CriteriaSource {
  /** The page size. Clamped here, so an oversized value cannot reach a query. */
  readonly limit?: number;

  /** The cursor from a previous page. */
  readonly cursor?: string;

  /**
   * The sort field the client asked for.
   *
   * Typed `unknown` rather than `string`, because the builder is defensive
   * about a value that was never validated. A DTO says `sort?: string`, and
   * this type is deliberately looser — it accepts whatever the DTO produced,
   * and the builder refuses what it cannot use.
   */
  readonly sort?: unknown;

  /**
   * The sort direction the client asked for.
   *
   * `unknown` for the same reason as `sort`.
   */
  readonly order?: unknown;

  /**
   * The filter values, by request-facing name.
   *
   * A record rather than a getter, so a caller can build one by hand — a test,
   * or a service that assembles a query from somewhere other than a DTO.
   */
  readonly filters?: Readonly<Record<string, unknown>>;
}

/**
 * Builds a `QueryCriteria` from a validated DTO and an entity's spec.
 *
 * **One place where a request becomes a query.** Every list route in the
 * application should go through this, so the rules — which fields exist, what
 * they compare, how the page is bounded — are written once rather than once
 * per service.
 *
 * **The DTO is passed as it is.** A route hands over the object the validation
 * pipe produced, and this reads the fields it knows about. A DTO is a class, so
 * the filter values are read through `criteriaSourceFrom` — the one place that
 * knows a DTO is a class and not a record.
 *
 * **A filter the spec does not declare is ignored, and a DTO field the spec
 * does not declare never reaches the query.** The global validation pipe
 * already refuses a query parameter the DTO does not declare, so the second
 * half of the same rule lives here: a DTO that declares a field the spec does
 * not is a mismatch between two files, and `defineQuerySpec` makes it a
 * compile error rather than a filter that silently never fires.
 */
export function buildCriteria(source: object, spec: QuerySpec): QueryCriteria {
  return buildFromSource(criteriaSourceFrom(source), spec);
}

/**
 * Builds a `QueryCriteria` from an already-shaped source.
 *
 * **Separate from `buildCriteria` so a caller that has no DTO — a service
 * assembling a query from a queue payload, a test — can build one without
 * inventing a class for it.
 */
export function buildFromSource(
  source: CriteriaSource,
  spec: QuerySpec,
): QueryCriteria {
  return {
    filters: resolveFilters(source, spec),
    sort: resolveSort(source, spec),
    limit: clampLimit(source.limit),
    cursor: resolveCursor(source.cursor),
  };
}

/**
 * Adapts a DTO to the shape the criteria builder reads.
 *
 * **The one place a DTO is turned into a source.** A route calls this once and
 * the builder never has to know what a DTO is.
 *
 * **The values are read off the instance, not off a prototype.** `source[field]`
 * on a plain object would find a property on the prototype chain — `constructor`
 * and `__proto__` are properties of every object — and a filter named after one
 * of them would receive a function. The DTO's own fields are the only ones
 * that are ever read, and a field the DTO does not declare is `undefined`.
 */
export function criteriaSourceFrom(dto: object): CriteriaSource {
  const filters: Record<string, unknown> = {};

  for (const key of Object.keys(dto)) {
    // The paging keys are not filters. A spec that declared a filter named
    // `sort` would otherwise read the sort *field name* as its value — a
    // silent wrong answer rather than an error, because the value would be a
    // perfectly ordinary string.
    if (PAGING_KEYS.has(key)) {
      continue;
    }

    filters[key] = (dto as Record<string, unknown>)[key];
  }

  return {
    limit: (dto as { limit?: number }).limit,
    cursor: (dto as { cursor?: string }).cursor,
    sort: (dto as { sort?: unknown }).sort,
    order: (dto as { order?: unknown }).order,
    filters,
  };
}

/**
 * The keys the criteria builder reads for itself.
 *
 * **The same set `FilterKeys` excludes**, so the two cannot disagree about which
 * names are reserved.
 */
const PAGING_KEYS = new Set(['limit', 'cursor', 'sort', 'order']);

/**
 * The filters, in the order the spec declares them.
 *
 * **Declared order rather than request order.** Two requests that name the
 * same fields produce the same SQL, which makes the query cacheable and the
 * generated statement comparable between two requests. It also means a filter
 * cannot be reordered to change the plan, which is not a thing a client should
 * be able to do.
 */
function resolveFilters(
  source: CriteriaSource,
  spec: QuerySpec,
): ResolvedFilter[] {
  const filters: ResolvedFilter[] = [];

  for (const [field, fieldSpec] of Object.entries(spec.filters)) {
    const value = source.filters?.[field];

    // Absent means absent. A filter the client did not ask for is not applied,
    // and it is not applied as a comparison against null — which would match
    // nothing and turn an unfiltered list into an empty one.
    if (value === undefined || value === null) {
      continue;
    }

    // A search term that is only whitespace is a filter the client did not
    // really ask for. Left in, it becomes `ILIKE '%   %'`, which matches
    // nearly every address: a filter that looks like a filter and behaves like
    // no filter, while costing a scan.
    if (
      fieldSpec.operator === 'ilike' &&
      typeof value === 'string' &&
      value.trim() === ''
    ) {
      continue;
    }

    filters.push({
      column: fieldSpec.column,
      operator: fieldSpec.operator,
      value: assertValue(
        field,
        value,
        fieldSpec.operator,
        fieldSpec.list === true,
      ),
    });
  }

  return filters;
}

/**
 * The sort.
 *
 * **An unknown sort field is a 400 naming the valid ones.** Falling back to
 * the default would answer a different question than the one asked, and a
 * client sorting by a field that does not exist would receive a valid page
 * ordered by something else and believe it got what it asked for.
 */
function resolveSort(source: CriteriaSource, spec: QuerySpec): ResolvedSort {
  const validNames = Object.keys(spec.sort).join(', ');
  const requested = source.sort;

  let field: string;

  if (requested === undefined || requested === '') {
    field = spec.defaultSort;
  } else {
    // Not a string. The DTO validates this, so anything else means the
    // criteria was built from something that was never validated — and
    // `hasOwnProperty` on a number is a 400 rather than a TypeError.
    if (typeof requested !== 'string') {
      throw new BadRequestException(
        `Cannot sort by that field. Sortable fields: ${validNames}.`,
      );
    }

    if (!Object.prototype.hasOwnProperty.call(spec.sort, requested)) {
      throw new BadRequestException(
        `Cannot sort by "${requested}". Sortable fields: ${validNames}.`,
      );
    }

    field = requested;
  }

  const column = spec.sort[field];

  if (column === undefined) {
    // The default sort is not a sortable field. A programming error rather than
    // a client error, and one that would otherwise produce a query ordering by
    // an unvalidated column.
    throw new Error(
      `The default sort "${field}" is not one of the sortable fields: ${validNames}.`,
    );
  }

  return {
    column,
    direction: resolveDirection(source.order),
  };
}

/**
 * The direction.
 *
 * **Descending by default**, because the newest thing is nearly always the one
 * being asked for, and because every list in this application is a list of
 * things that were created.
 */
function resolveDirection(order: unknown): 'ASC' | 'DESC' {
  if (order === undefined || order === '') {
    return 'DESC';
  }

  // Not a string. The DTO validates this, so a number here means the criteria
  // was built from something that was never validated — and a TypeError from
  // deep inside a query builder is a 500 for a request that was merely wrong.
  if (typeof order !== 'string') {
    throw new BadRequestException(
      'Cannot sort in that order. Use "asc" or "desc".',
    );
  }

  const normalised = order.toUpperCase();

  if (normalised !== 'ASC' && normalised !== 'DESC') {
    throw new BadRequestException(
      `Cannot sort in order "${order}". Use "asc" or "desc".`,
    );
  }

  return normalised;
}

/**
 * The cursor, decoded.
 *
 * **Decoded here rather than at the point of use**, so a malformed cursor is
 * refused with a 400 before any query is built. A cursor that is ignored is a
 * silent first page, and a silent first page is a client that believes it
 * asked for page four and was given page one.
 */
function resolveCursor(cursor: unknown): string | undefined {
  if (cursor === undefined || cursor === '') {
    return undefined;
  }

  if (typeof cursor !== 'string') {
    throw new BadRequestException('The cursor is not a valid cursor.');
  }

  // Decoding for the side effect of refusing a bad one. The value is re-read at
  // the point of use, and the two decoders are the same function.
  decodeCursor(cursor);

  return cursor;
}

/**
 * The page size.
 *
 * **Clamped, not refused.** A client asking for more than the ceiling is
 * careless rather than wrong, and a 400 teaches it that the route is fragile.
 * A negative or unparseable value falls back to the default for the same
 * reason.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * The value, checked against the operator that will use it.
 *
 * **Only the shapes that are actually wrong are refused.** The point is to
 * catch a mismatch between a DTO and a spec — a DTO that declares `role` as a
 * string where the spec says it is a list, say — because that mismatch
 * otherwise becomes a query postgres rejects with a message nobody reading the
 * application would understand.
 */
function assertValue(
  field: string,
  value: unknown,
  operator: FilterOperator,
  isList: boolean,
): unknown {
  if (isList) {
    if (!Array.isArray(value)) {
      throw new BadRequestException(
        `The filter "${field}" expects a list of values.`,
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    throw new BadRequestException(
      `The filter "${field}" expects a single value, not a list.`,
    );
  }

  // An object cannot be bound as a comparison value, and postgres would reject
  // it with a message about a type it cannot coerce. Refusing it here names the
  // field the client actually sent.
  if (typeof value === 'object') {
    throw new BadRequestException(
      `The filter "${field}" expects a simple value.`,
    );
  }

  return value;
}
