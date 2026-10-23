import type { DataSource } from 'typeorm';

import { AdminSeeder, type Seeder } from './admin.seeder.js';
import { MailTemplateSeeder } from './mail-template.seeder.js';
import { PermissionSeeder } from './permission.seeder.js';
import { TenantSeeder } from './tenant.seeder.js';

/**
 * Runs every seeder in order and reports what happened, so a seed is never a
 * silent no-op that leaves the environment unusable.
 */
/**
 * Permissions first: the admin user is created before its role has any grants,
 * which is fine, because a role gains its permissions by seed order rather than
 * by the account existing.
 *
 * Templates last, because they are the only seeder that reads the filesystem: it is
 * the one most likely to fail on a packaging fault, and running it after the
 * permissions means a deployment with a broken asset list still ends up with a
 * usable administrator rather than with nothing.
 */
export const SEEDERS: Seeder[] = [
  // The tenants first, because the permission catalogue is cloned into each of
  // them: a catalogue seeded before the registry exists would be cloned into
  // nothing, and a deployment would come up with a user who holds no
  // permission at all.
  new TenantSeeder(),
  new PermissionSeeder(),
  new AdminSeeder(),
  new MailTemplateSeeder(),
];

export async function runSeeders(dataSource: DataSource): Promise<void> {
  for (const seeder of SEEDERS) {
    await seeder.run(dataSource);
    process.stdout.write(`  seeded: ${seeder.name}\n`);
  }
}
