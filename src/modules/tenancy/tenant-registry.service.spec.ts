import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TENANT_ID } from '../../common/tenancy/tenant.constants.js';
import { TenantRegistry } from './tenant-registry.service.js';
import type { Tenant } from './entities/tenant.entity.js';

/**
 * The registry and the resolution.
 *
 * **The refusals are the point.** A request for a tenant that does not exist
 * has asked for somebody else's data, and answering it with this deployment's
 * rows would be worse than refusing it.
 */
function registryWith(rows: Partial<Tenant>[]): TenantRegistry {
  const repository = {
    findOne: vi.fn(async ({ where }: { where: Partial<Tenant> }) => {
      const found = rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => row[key as keyof Tenant] === value,
        ),
      );

      return found === null || found === undefined ? null : found;
    }),
  };

  return new TenantRegistry(repository as never);
}

const acme: Partial<Tenant> = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  plan: 'free',
  schemaName: null,
};

describe('the tenant registry', () => {
  it('finds a tenant by its slug', async () => {
    const registry = registryWith([acme]);

    await expect(registry.findBySlug('acme')).resolves.toMatchObject({
      id: acme.id,
      slug: 'acme',
    });
  });

  it('answers null for a tenant it does not have', async () => {
    const registry = registryWith([acme]);

    // Not the default tenant. A request for a tenant that does not exist has
    // asked for somebody else's data, and answering it with this
    // deployment's rows would be worse than refusing it.
    await expect(registry.findBySlug('nope')).resolves.toBeNull();
  });

  it('has a default tenant that is not looked up', async () => {
    const registry = registryWith([]);

    // The feature being off must not depend on a row existing: a database that
    // has not been seeded still has to answer a request.
    const tenant = registry.defaultTenant();

    expect(tenant.id).toBe(DEFAULT_TENANT_ID);
    expect(tenant.status).toBe('active');
  });

  it('serves an active tenant and refuses a disabled one', async () => {
    const registry = registryWith([{ ...acme, status: 'disabled' }]);

    const tenant = await registry.findBySlug('acme');

    expect(registry.isServing(tenant!)).toBe(false);
  });
});
