export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';
export const MANAGER_ONLY_KEY = 'managerOnly';
/**
 * Whether a route requires a confirmed address.
 *
 * Here with the other three rather than beside its decorator, because a gate in
 * this family is found by looking at the gates — `RateLimit` is the exception and
 * co-locates its key only because `skipIf` reads it from a plain function in a
 * config file with no `Reflector`.
 */
export const EMAIL_VERIFIED_KEY = 'emailVerified';

/**
 * The audit policy for a route, set by `@Audited()`.
 *
 * An object rather than a string, because the two halves are separate decisions:
 * what to call the action, and what to diff. A route that audits a sign-in has no
 * before and no after — the action *is* the record — while a route that updates a
 * user has both and the diff is the whole point.
 */
export const AUDIT_KEY = 'audit';
