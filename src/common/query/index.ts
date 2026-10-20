/**
 * The query layer: a request, described as data, and applied to a query builder.
 *
 * **A route declares a spec, a DTO, and calls one function.** The spec says
 * which fields may be filtered and sorted and which column each one means; the
 * DTO says what the request may contain; `readPage` does the rest. Nothing
 * else in a list route knows how a query is built.
 */
export * from './filter-operator.js';
export * from './query-spec.js';
export * from './query-criteria.js';
export * from './build-criteria.js';
export * from './apply-criteria.js';
export * from './read-page.js';
