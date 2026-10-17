/**
 * Default and maximum rows per page.
 *
 * **`DEFAULT_PAGE` is gone with offset paging.** It only ever existed for
 * `PaginationQueryDto`, and a page *number* is the thing cursor paging replaces:
 * it is the value that goes stale when a row is inserted mid-walk.
 */
export const DEFAULT_LIMIT = 20;

/**
 * The ceiling, not a suggestion.
 *
 * A listing route with no upper bound is a route that can be asked for the whole
 * table, and the answer to that request costs the database the same query the
 * application would have run one page at a time. Over-large requests are clamped
 * rather than refused so a careless client is not taught that the route is fragile.
 */
export const MAX_LIMIT = 100;
