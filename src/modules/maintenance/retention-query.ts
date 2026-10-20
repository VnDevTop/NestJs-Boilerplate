import { defineQuerySpec } from '../../common/query/index.js';

/**
 * What `GET /admin/retention/runs` may be filtered and sorted by.
 *
 * **One sortable column, and no filters.** The history is a log of runs in
 * order; a filter on it would answer a question an operator asks of the audit
 * trail rather than of the retention screen, and the audit trail gets its own
 * read surface in Phase 26.
 */
export const RETENTION_QUERY_SPEC = defineQuerySpec<{
  limit: number;
  cursor?: string;
  sort?: string;
  order?: string;
}>({
  filters: {},

  sort: {
    createdAt: 'createdAt',
  },

  defaultSort: 'createdAt',
});
