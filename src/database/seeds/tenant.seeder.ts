import type { DataSource } from 'typeorm';

import { DEFAULT_TENANT_ID } from '../../common/tenancy/tenant.constants.js';
import { Tenant } from '../../modules/tenancy/entities/tenant.entity.js';
import type { Seeder } from './admin.seeder.js';

/**
 * The default tenant.
 *
 * **One row, seeded, with the same id the column's default is.** A
 * single-tenant deployment has one tenant and it is this one; a row written
 * before the registry existed belongs to it too, which is what makes the
 * feature switchable without a backfill.
 *
 * **The seeder is idempotent**, so a deployment that seeds twice does not end
 * up with two default tenants — which would be two tenants answering for the
 * same slug, and the second one would be unreachable.
 */
export class TenantSeeder implements Seeder {
  name = 'tenants';

  async run(dataSource: DataSource): Promise<void> {
    const repository = dataSource.getRepository(Tenant);

    const existing = await repository.findOne({
      where: { id: DEFAULT_TENANT_ID },
    });

    if (existing !== null) {
      return;
    }

    await repository.insert({
      id: DEFAULT_TENANT_ID,
      slug: 'default',
      name: 'Default tenant',
      status: 'active',
      plan: 'free',
      schemaName: null,
    });
  }
}
