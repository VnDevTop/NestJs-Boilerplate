import type { FilterOperator } from './filter-operator.js';

/**
 * One resolved filter: a column, a comparison, and a value.
 *
 * **The column is already resolved.** By the time a filter reaches this
 * object, the request-facing name has been looked up in the entity's spec and
 * replaced by the column it means. Nothing downstream of `buildCriteria` ever
 * sees a client-supplied name, which is what makes the applier safe to write
 * without looking at where the values came from.
 */
export interface ResolvedFilter {
  /** The database column. Declared in the entity's spec, never by the client. */
  readonly column: string;

  /** The comparison. Also from the spec. */
  readonly operator: FilterOperator;

  /**
   * The value, as the client sent it and the DTO validated it.
   *
   * **Bound, never interpolated.** The applier turns it into a placeholder;
   * the only thing that reaches the SQL text is the operator's own fragment,
   * which is written out by hand in `apply-criteria.ts`.
   */
  readonly value: unknown;
}

/**
 * The sort, resolved.
 *
 * **The column is already resolved** for the same reason a filter's is: the
 * request-facing name has been replaced by the column it means, so the
 * applier has nothing to look up and nothing to refuse.
 */
export interface ResolvedSort {
  /** The database column. */
  readonly column: string;

  /** `ASC` or `DESC`. */
  readonly direction: 'ASC' | 'DESC';
}

/**
 * A query, described.
 *
 * **Data, not a builder.** This object holds what was asked for; it does not
 * know how to ask a database for it. That separation is what lets one
 * criteria be applied to a `SelectQueryBuilder`, to a `Repository`, or to
 * something that is neither, and it is what lets a test assert on the query
 * without a database in the room.
 *
 * **Built once, from a DTO.** The DTO has already been validated by the
 * global pipe — the values are the right types, and a field the DTO does not
 * declare was refused before the handler ran. The criteria builder's job is
 * the mapping from validated request shape to query, and nothing else.
 */
export interface QueryCriteria {
  /** The filters to apply, in the order they were declared. */
  readonly filters: readonly ResolvedFilter[];

  /** The sort to apply. */
  readonly sort: ResolvedSort;

  /** The page size, already clamped. */
  readonly limit: number;

  /** The cursor, if the client sent one. */
  readonly cursor?: string;
}
