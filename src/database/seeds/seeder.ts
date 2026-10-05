import type { DataSource } from 'typeorm';

import { AdminSeeder, type Seeder } from './admin.seeder.js';
import { PermissionSeeder } from './permission.seeder.js';

/**
 * Runs every seeder in order and reports what happened, so a seed is never a
 * silent no-op that leaves the environment unusable.
 */
/**
 * Permissions first: the admin user is created before its role has any grants,
 * which is fine, because a role gains its permissions by seed order rather than
 * by the account existing.
 */
export const SEEDERS: Seeder[] = [new PermissionSeeder(), new AdminSeeder()];

export async function runSeeders(dataSource: DataSource): Promise<void> {
  for (const seeder of SEEDERS) {
    await seeder.run(dataSource);
    process.stdout.write(`  seeded: ${seeder.name}\n`);
  }
}
