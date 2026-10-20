import { defineQuerySpec } from '../../../common/query/index.js';
import type { ListUsersQueryDto } from './list-users-query.dto.js';

/**
 * What `GET /users` may be filtered and sorted by.
 *
 * **One object, holding the whole query surface of the route.** Before this
 * existed, the sort allow-list lived in the DTO file and the filters were four
 * `if` statements in the service — two places to look, and a filter added to one
 * and not the other. A route's query surface is one fact, so it is one object.
 *
 * **The filter keys are the DTO's property names.** `defineQuerySpec` is typed
 * against the DTO, so a filter here that the DTO does not declare — or a DTO
 * property that no filter declares — is a compile error rather than a parameter
 * the client can send and the route silently ignores.
 */
export const USER_QUERY_SPEC = defineQuerySpec<ListUsersQueryDto>({
  filters: {
    /**
     * The role, matched exactly.
     *
     * `eq` rather than a pattern: a role is a closed set of three values, and
     * a substring match on it would match nothing useful while matching
     * `user` against `super_admin` by accident.
     */
    role: { column: 'role', operator: 'eq' },

    /**
     * Active or not.
     *
     * `eq` and not a boolean flag, because a flag cannot express "false" — a
     * `?isActive=false` has to be able to ask for the inactive accounts, and a
     * flag's absence is indistinguishable from its false.
     */
    isActive: { column: 'isActive', operator: 'eq' },

    /**
     * Whether the address is confirmed.
     *
     * The same reasoning as `isActive`: a route that hides unverified accounts
     * by default and a client that wants to see them need a value that can be
     * false.
     */
    isEmailVerified: { column: 'isEmailVerified', operator: 'eq' },

    /**
     * A substring of the address.
     *
     * `ilike` rather than `eq`, so a client can search from the domain side.
     * The wildcards and the escaping are the operator's business — see
     * `prepareFilterValue` — because a caller who had to write `%term%` would
     * eventually write `%` on its own and search the whole table.
     */
    email: { column: 'email', operator: 'ilike' },
  },

  /**
   * The columns `GET /users` may be sorted on.
   *
   * **Every entry is `NOT NULL`, which the cursor format requires.** A cursor
   * carries its boundary value as a string; a `null` would have to be encoded as
   * something the decoder reads as "malformed", so sortable columns are
   * restricted to ones that always hold a value. Adding a nullable column here
   * means encoding nulls in the cursor and defining what `< NULL` means for a
   * keyset walk — do that deliberately, not by adding a line.
   *
   * `email`, `role` and `isActive` are here because an operator paging a user
   * list asks "the admins", "the inactive ones" — usually as a filter, but
   * sorting by the same columns is what makes a filtered list navigable.
   *
   * `firstName` and `lastName` are absent on purpose. Sorting by either is
   * legal SQL and useless in practice — the answer is "do you mean the full
   * name?" — and an index on either would be maintained forever for a question
   * nobody asks.
   */
  sort: {
    createdAt: 'createdAt',
    email: 'email',
    role: 'role',
    isActive: 'isActive',
  },

  defaultSort: 'createdAt',
});
