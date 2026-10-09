import { describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS } from '../../common/enums/permission.enum.js';
import { CACHED_ROLE_GRANT_KEYS } from './permission.seeder.js';

/**
 * The seed writes grants to the database, and the application reads them from a
 * cache that a deploy does not clear on its own. Without the eviction a permission
 * added by this seed does not take effect for the length of
 * `CACHE_AUTH_ROLE_TTL`, which is a permission that silently does not work.
 *
 * These assert the list of keys rather than the eviction, because the list is the
 * part that can silently be wrong: a role added to the catalogue and missed here
 * would keep its cached grants forever, with no error anywhere.
 */
describe('the cached role grants a seed clears', () => {
  it('covers every role the catalogue names', () => {
    expect([...CACHED_ROLE_GRANT_KEYS].sort()).toEqual(
      Object.keys(ROLE_PERMISSIONS)
        .map((role) => `role:${role}`)
        .sort(),
    );
  });

  it('follows the catalogue rather than a second list of roles', () => {
    // A hand-written list is how a new role ends up seeded but never evicted.
    expect(CACHED_ROLE_GRANT_KEYS).toHaveLength(
      Object.keys(ROLE_PERMISSIONS).length,
    );
  });

  it('is derived from the same role names the grants are written from', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      expect(CACHED_ROLE_GRANT_KEYS).toContain(`role:${role}`);
    }
  });

  it('names a role rather than a pattern, because there is no pattern delete', () => {
    // A wildcard would be a scan of a shared keyspace, and an accidentally broad
    // one is silent and expensive.
    expect(CACHED_ROLE_GRANT_KEYS.every((key) => !key.includes('*'))).toBe(
      true,
    );
  });
});
