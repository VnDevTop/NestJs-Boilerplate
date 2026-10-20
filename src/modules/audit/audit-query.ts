import { defineQuerySpec } from '../../common/query/index.js';
import type { AuditQueryDto } from './dto/audit-query.dto.js';

/**
 * What `GET /admin/audit` may be filtered and sorted by.
 *
 * **One object, holding the whole query surface of the route.** Before this
 * existed, the sort allow-list lived in the DTO file and the filters were four
 * `if` statements in the service — two places to look, and a filter added to one
 * and not the other. A route's query surface is one fact, so it is one object.
 *
 * **Every column here is indexed, or is the leading column of a composite
 * index.** `action`, `actorId` and `(targetType, targetId)` each have one, and
 * `createdAt` has one — the trail is a year of rows and a filter that cannot use
 * an index is a scan of all of it.
 */
export const AUDIT_QUERY_SPEC = defineQuerySpec<AuditQueryDto>({
  filters: {
    /**
     * The actor, by id.
     *
     * `eq` rather than a pattern: an id is an id, and a substring match on a
     * uuid is a scan dressed up as a filter.
     */
    actorId: { column: 'actorId', operator: 'eq' },

    /**
     * The actor's address.
     *
     * `ilike` rather than `eq`, so a client can search from the domain side —
     * the same reason `GET /users` matches its email as a substring. It is a
     * snapshot, so it matches the address the actor had at the time rather than
     * the one they have now.
     */
    actorEmail: { column: 'actorEmail', operator: 'ilike' },

    /**
     * The kind of actor.
     *
     * `eq`, because the set is closed and three values is a set rather than a
     * pattern.
     */
    actorType: { column: 'actorType', operator: 'eq' },

    /**
     * What happened.
     *
     * `eq`, because the action is a closed vocabulary — the audit policy names
     * one per privileged route, and `audit-policy.spec.ts` fails when two routes
     * share a name. A substring match on it would answer a different question
     * from the one asked: "every `users.update`" is not "every action containing
     * the text `users.update`".
     */
    action: { column: 'action', operator: 'eq' },

    /**
     * The kind of target.
     *
     * `eq`, and paired with `targetId` rather than replacing it. The composite
     * index on `(targetType, targetId)` is what makes "every change to this one
     * account" an index scan rather than a scan of the trail.
     */
    targetType: { column: 'targetType', operator: 'eq' },

    /**
     * The target itself.
     *
     * `eq` for the same reason as the id above.
     */
    targetId: { column: 'targetId', operator: 'eq' },

    /**
     * Success or failure.
     *
     * `eq`, because the set is closed.
     */
    outcome: { column: 'outcome', operator: 'eq' },

    /**
     * The request the entry belongs to.
     *
     * `eq`, because it is a handle rather than a name. It is the column that
     * turns an entry into a trail: the log lines and the mail delivery of the
     * same request are found by the same handle.
     */
    requestId: { column: 'requestId', operator: 'eq' },

    /**
     * The start of the window.
     *
     * `gte`, and a separate field from the end of it rather than one field with
     * a direction the client chooses. The request says *what* to filter by and
     * never *how*: a client that could pick the operator could pick the one
     * that makes the window mean something else.
     */
    from: { column: 'createdAt', operator: 'gte' },

    /**
     * The end of the window.
     *
     * `lte`, for the same reason as `from`.
     */
    to: { column: 'createdAt', operator: 'lte' },
  },

  /**
   * The columns `GET /admin/audit` may be sorted on.
   *
   * **One, and it is `createdAt`.** The trail is a log of things that were
   * recorded in the order they were recorded, and an investigator reads it
   * backwards from a moment they care about. Sorting by anything else — the
   * action, the actor — groups entries in an order that has no meaning, and
   * the index that would make it fast is one nobody asked for.
   *
   * `createdAt` is `NOT NULL`, which the cursor format requires: a cursor
   * carries its boundary value as a string, and a `null` would have to be
   * encoded as something the decoder reads as "malformed".
   */
  sort: {
    createdAt: 'createdAt',
  },

  defaultSort: 'createdAt',
});
