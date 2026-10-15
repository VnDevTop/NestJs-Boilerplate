/**
 * Every key is built here rather than inlined, so invalidation cannot drift
 * from the key that stored the value.
 */
export const CACHE_NAMESPACE = {
  User: 'user',
  Role: 'role',
  Device: 'device',
  Token: 'token',
  /**
   * Mail template source, added by Phase 22.
   *
   * One key per template *and locale*, so a deployment that later resolves a second
   * locale does not serve the `en` row for it, and so a `KEYS` scan says which
   * template somebody is asking about.
   */
  Mail: 'mail',
} as const;

export type CacheNamespace =
  (typeof CACHE_NAMESPACE)[keyof typeof CACHE_NAMESPACE];

/**
 * Joins a namespace and its identifiers into one key, for example
 * `cacheKey(CACHE_NAMESPACE.User, userId)` -> `user:9f1c`.
 */
export function cacheKey(
  namespace: string,
  ...parts: (string | number)[]
): string {
  return [namespace, ...parts.map(String).filter(Boolean)].join(':');
}
