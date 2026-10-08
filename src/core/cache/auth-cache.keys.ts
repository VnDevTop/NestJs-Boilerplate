import { CACHE_NAMESPACE, cacheKey } from './cache-keys.js';

/**
 * Keys for the authentication and authorisation cache.
 *
 * Built here rather than inlined at the read and the delete, so the two cannot
 * drift apart. That drift is the failure mode this whole cache has: a write that
 * deletes `user:<id>` while the read fills `user:id` is not a cache miss, it is a
 * user who stays deactivated for the rest of the TTL.
 *
 * **No email key.** Phase 17b planned one, and it was dropped for a reason worth
 * keeping: the only caller is `login`, and `login` needs the password hash to
 * verify against. Serving that row from cache means a bcrypt hash in redis,
 * which turns a cache compromise into offline cracking material for every
 * account. Caching just the email-to-id mapping would save nothing, because the
 * row still has to be fetched for the hash. The lookup stays a database read.
 *
 * **No per-user permission key either.** Permissions are stored against a role,
 * so one entry per role covers every holder, and invalidation stays a single
 * delete. A per-user key would need one delete per holder of a role, and
 * `CacheService` has no pattern delete on purpose, so that is a scan of the
 * user table on every role change.
 */

/** `user:<id>` — the claims the strategy authorises a request with. */
export function authUserKey(userId: string): string {
  return cacheKey(CACHE_NAMESPACE.User, userId);
}

/**
 * `role:<role>` — the permission names one role holds.
 *
 * An empty role never reaches the cache: `PermissionsService.forRole` answers an
 * empty set without reading or writing, and `cacheKey` drops an empty part, so
 * caching it would put a nameless entry under the bare `role` key where any
 * future `role:something` could collide with it.
 */
export function authRoleKey(role: string): string {
  return cacheKey(CACHE_NAMESPACE.Role, role);
}
