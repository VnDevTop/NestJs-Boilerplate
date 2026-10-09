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

/**
 * `user:<id>:devices` — each of a user's device session versions.
 *
 * A second key rather than a field on the claims entry, because the claims entry
 * is read on every request by everybody and this is read only by a token that
 * names a device. Keeping them apart means a user with eight devices does not
 * carry eight counters in the hot entry, and the two can expire independently.
 *
 * They are invalidated together anyway: `UsersService.invalidateAuthCache` drops
 * both, because there is no version bump that changes one without changing the
 * claims that say which device is being presented.
 */
export function authDeviceSessionsKey(userId: string): string {
  return cacheKey(CACHE_NAMESPACE.User, userId, 'devices');
}

/**
 * `token:revoked:<session>` — one revoked session, one key.
 *
 * **Not part of the cache that `invalidateAuthCache` drops.** Every other key here
 * is a cache of something in the database and can be thrown away and refilled.
 * This one is the record: a session revocation has no column to be re-read from,
 * because it is a `revokedAt` on a row nobody looks up by jti. Deleting it would
 * un-revoke the session on the very next request, so it is written and read
 * directly and never invalidated.
 *
 * One key per session rather than a set under the user, because a write is then a
 * plain `SET` instead of a read-modify-write, and two sessions revoked at the same
 * moment cannot lose each other's entry.
 */
export function revokedSessionKey(sessionId: string): string {
  return cacheKey(CACHE_NAMESPACE.Token, 'revoked', sessionId);
}
