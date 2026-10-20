/**
 * The cursor, and the two shapes a paged response has.
 *
 * **The cursor is a transport detail, not a query detail.** It is an opaque
 * token a client hands back, and everything about how a query is built from it
 * lives in `common/query` — which is the layer that knows about filters, sorts
 * and the keyset walk.
 *
 * So this folder holds three things and no logic: the encoding, the DTO every
 * listing route's query extends, and the page result the envelope carries.
 */
export * from './cursor.js';
export * from './paginated-result.dto.js';
export * from './cursor-pagination-query.dto.js';
