import { defineQuerySpec } from '../../common/query/index.js';

/**
 * What `GET /auth/sessions` may be filtered and sorted by.
 *
 * **No filters, and that is a decision rather than an omission.** The route
 * answers "the caller's own live sessions", so the only thing a client could
 * usefully ask for is which of them — and the caller's own id is not something a
 * client chooses. The scope is applied by the service; the spec holds the sort.
 */
export const SESSION_QUERY_SPEC = defineQuerySpec<{
  limit: number;
  cursor?: string;
  sort?: string;
  order?: string;
}>({
  filters: {},

  /**
   * The columns `GET /auth/sessions` may be sorted on.
   *
   * **`createdAt` only, and the omission is deliberate.** The other candidates
   * are `expiresAt` and `sessionStartedAt`, both of which answer a question
   * about the session's age rather than about the list, and sorting a
   * live-session list by either produces an order that shuffles underneath the
   * reader as tokens are rotated — the page they are on stops being the page
   * they were reading. `sessionStartedAt` is in fact what a "sessions older
   * than N days" filter should use, and when that filter exists it belongs in
   * the WHERE clause, not in the ORDER BY.
   */
  sort: {
    createdAt: 'createdAt',
  },

  defaultSort: 'createdAt',
});
