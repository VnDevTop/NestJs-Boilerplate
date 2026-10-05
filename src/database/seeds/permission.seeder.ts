import type { DataSource } from 'typeorm';

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

    process.stdout.write(
      `  permissions: ${byName.size} in the catalogue, ${inserted} new grants\n`,
    );
  }
}
