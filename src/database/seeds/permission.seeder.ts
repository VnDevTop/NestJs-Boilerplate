import type { DataSource } from 'typeorm';

import { authRoleKey } from '../../core/cache/auth-cache.keys.js';
import { createRedisStore } from '../../core/cache/redis-store.js';
import { cacheConfig } from '../../configs/index.js';
import { ROLE_PERMISSIONS } from '../../common/enums/permission.enum.js';
import {
  Permission,
  RolePermission,
} from '../../modules/users/entities/index.js';
import type { Seeder } from './admin.seeder.js';

/**
 * Creates the permission catalogue and grants it to roles.
 *
 * Idempotent for the same reason the admin seeder is: `npm run seed` gets run
 * twice, and a seeder that inserts a second copy of everything leaves a guard
 * debugging a role that appears to hold a permission twice.
 *
 * Two separate jobs, and the order matters:
 *
 * Permissions are upserted on `name`, and the description is updated on the way
 * through. That is deliberate: a permission whose description was improved in
 * code should reach an existing database on the next seed, rather than leaving
 * every deployed environment with the wording from whenever it was first seeded.
 *
 * Grants are only inserted, never re-derived. If a permission is removed from a
 * role in code, the grant stays in the database, because the alternative is that
 * a deploy silently withdraws an access grant from a running system. Revoking a
 * permission is an operator action, taken in the database, on purpose.
 */
/**
 * The cache keys this seed invalidates, one per role the catalogue names.
 *
 * Derived from `ROLE_PERMISSIONS` rather than listed, so a role added to the
 * catalogue is evicted by the same seed that writes its grants. Exported so the
 * list can be asserted without standing up a cache.
 */
export const CACHED_ROLE_GRANT_KEYS: readonly string[] =
  Object.keys(ROLE_PERMISSIONS).map(authRoleKey);

export class PermissionSeeder implements Seeder {
  readonly name = 'permissions';

  async run(dataSource: DataSource): Promise<void> {
    const permissions = dataSource.getRepository(Permission);
    const grants = dataSource.getRepository(RolePermission);

    const byName = new Map<string, string>();

    for (const name of Object.values(ROLE_PERMISSIONS).flat()) {
      const existing = await permissions.findOneBy({ name });

      // Skipped when the row exists with the same description, so a re-seed is a
      // read rather than a write on every permission.
      if (existing === null) {
        await permissions.insert({ name, description: '' });
      }

      const id =
        existing?.id ?? (await permissions.findOneByOrFail({ name })).id;

      byName.set(name, id);
    }

    let inserted = 0;

    for (const [role, names] of Object.entries(ROLE_PERMISSIONS)) {
      for (const name of names) {
        const permissionId = byName.get(name);

        if (permissionId === undefined) {
          throw new Error(
            `Role ${role} lists permission ${name}, which is not in the catalogue`,
          );
        }

        // `orIgnore` so the conflict is resolved by the unique index rather than
        // by a check another process could invalidate between check and insert.
        //
        // `returning` because `InsertResult.identifiers` counts the rows it
        // *attempted*, not the ones the database kept. Without it the summary
        // reported every grant as new on every run, which is the kind of number
        // that teaches an operator to ignore the line that tells them something.
        const result = await grants
          .createQueryBuilder()
          .insert()
          .into(RolePermission)
          .values({ role, permissionId })
          .orIgnore()
          .returning('id')
          .execute();

        inserted += result.raw.length;
      }
    }

    await this.dropCachedRoleGrants();

    process.stdout.write(
      `  permissions: ${byName.size} in the catalogue, ${inserted} new grants\n`,
    );
  }

  /**
   * Drops the cached grant set of every role the catalogue names.
   *
   * Without it a deploy that adds a permission to a role keeps serving the old
   * grant set for the length of `CACHE_AUTH_ROLE_TTL`, and the permission that was
   * just deployed does not work until it expires. That direction is the safe one —
   * the guard refuses rather than admits — so this is a deploy that is briefly
   * *less* capable rather than one that is briefly more permissive, which is why it
   * is a cache eviction and not part of the transaction that wrote the grants.
   *
   * Explicitly targeted rather than swept. The keys are known, because the roles
   * come from the same `ROLE_PERMISSIONS` the grants were written from, and a
   * pattern delete over the keyspace is an unbounded operation on a shared server.
   *
   * Best effort: a seed that cannot reach the cache has still seeded the database,
   * and failing here would turn a cache outage into a failed deploy. The operator
   * is told, because the alternative is a permission that silently does not work.
   *
   * A no-op for `CACHE_BACKEND=memory`, and necessarily so: an in-process cache
   * holds entries no other process can reach, so the only correct response is to
   * let them expire, which is what the configured TTL bounds.
   */
  private async dropCachedRoleGrants(): Promise<void> {
    const config = cacheConfig();

    if (config.backend === 'memory') {
      return;
    }

    const { store, close } = await createRedisStore(config, () => undefined);

    try {
      await store.deleteMany?.([...CACHED_ROLE_GRANT_KEYS]);
    } catch {
      process.stderr.write(
        `  could not clear cached role grants; newly seeded permissions may take ` +
          `up to ${config.authRoleTtl}s to apply\n`,
      );
      return;
    } finally {
      // Without this the socket keeps the event loop alive and the seed script
      // sits there after its last line instead of exiting.
      await close().catch(() => undefined);
    }

    process.stdout.write(
      `  cleared cached grants for ${CACHED_ROLE_GRANT_KEYS.length} roles\n`,
    );
  }
}
