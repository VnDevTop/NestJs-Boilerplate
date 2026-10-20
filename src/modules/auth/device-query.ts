import { defineQuerySpec } from '../../common/query/index.js';

/**
 * What `GET /auth/devices` may be filtered and sorted by.
 *
 * **No filters, and that is a decision rather than an omission.** The route
 * answers "the caller's own devices", so the only thing a client could usefully
 * ask for is which of them — and the caller's own id is not something a client
 * chooses. The scope is applied by the service; the spec holds the sort.
 *
 * A filter map that is empty is a statement: the route's query surface is its
 * sort, and everything else about the answer is fixed by the server.
 */
export const DEVICE_QUERY_SPEC = defineQuerySpec<{
  limit: number;
  cursor?: string;
  sort?: string;
  order?: string;
}>({
  filters: {},

  /**
   * The columns `GET /auth/devices` may be sorted on.
   *
   * **Two columns, both `NOT NULL`.** `createdAt` is the one anybody asks for —
   * "what did I sign in on most recently" — and `deviceName` is there because
   * the list is read by looking for a machine. `lastUsedAt` is deliberately
   * absent: it is nullable, and a nullable column cannot carry a keyset cursor
   * boundary.
   */
  sort: {
    createdAt: 'createdAt',
    deviceName: 'deviceName',
  },

  defaultSort: 'createdAt',
});
