/** Where a route says the acted-upon id lives. */
export type AuditTargetSource = readonly ['param', string] | 'user' | 'result';

/**
 * What a route declares about itself for the audit trail.
 *
 * Declared rather than inferred, because inferring it would mean guessing from a
 * method name — and a guessed action string is one nobody can query against
 * later. A reader asking "show me every `users.role.granted`" needs the string to
 * be exact, and the only way to guarantee that is to have somebody write it.
 */
export interface AuditPolicy {
  /**
   * `entity.action`, as written in the entity column.
   *
   * Dotted and namespaced by the thing acted upon, matching the notification event
   * names from Phase 18 so the two tables read the same way: `users.update`,
   * `users.role.granted`, `auth.2fa.enabled`.
   */
  action: string;
  /**
   * What this route acts on: `user`, `session`, `device`, `role`.
   *
   * An entity name rather than something read from the return value, because a
   * route that deletes a user returns nothing and a route that updates one returns
   * a DTO that has already been redacted into a shape the audit row does not want.
   */
  targetType: string;
  /**
   * How the target id is found, in order of preference.
   *
   * `'param:<name>'` reads a route parameter, `'user'` reads the authenticated
   * caller's own id, `'result'` reads the id off the response.
   *
   * The order matters and is the reason this is a list: a delete route takes its
   * id from the path, an admin acting on their own account has no id in the path at
   * all, and a create route only learns the id from what it created.
   */
  targetIdFrom?: AuditTargetSource[];
  /**
   * Whether to diff the response into `after`.
   *
   * Off for anything whose response is not a row: a token response, a list of
   * sessions. The action is the record there, and a diff of a JWT into an audit
   * table is exactly the kind of accident the redaction list exists to catch.
   */
  diffResponse?: boolean;
  /**
   * Whether a rejected request is recorded.
   *
   * Defaults to true. A permission that was refused is evidence — a refusal is a
   * half of what an audit trail is for — and the half most systems skip.
   */
  recordFailures?: boolean;
}
