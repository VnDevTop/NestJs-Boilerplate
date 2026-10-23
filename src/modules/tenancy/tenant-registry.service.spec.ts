import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TENANT_ID } from '../../common/tenancy/tenant.constants.js';
import { TenantContextService } from '../../common/tenancy/tenant-context.service.js';
import { TenantRegistry } from './tenant-registry.service.js';
import { TenantMiddleware } from './tenant.middleware.js';
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

describe('resolving the tenant of a request', () => {
  const config = {
    enabled: true,
    header: 'x-tenant-id',
    baseDomain: 'acme.test',
    defaultTenantId: DEFAULT_TENANT_ID,
  };

  const configService = { getOrThrow: () => config } as never;
  const context = new TenantContextService();

  function request(overrides: Record<string, unknown> = {}) {
    return {
      header: (name: string) => overrides[name] as string | undefined,
      hostname: (overrides.hostname as string | undefined) ?? '',
      ...overrides,
    } as never;
  }

  it('takes the tenant from the header', async () => {
    const middleware = new TenantMiddleware(
      registryWith([acme]),
      configService,
      context,
    );

    const req = request({ 'x-tenant-id': 'acme' });
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect(next).toHaveBeenCalled();
    expect((req as { tenant?: { slug: string } }).tenant?.slug).toBe('acme');
  });

  it('takes the tenant from the host, when there is no header', async () => {
    const middleware = new TenantMiddleware(
      registryWith([acme]),
      configService,
      context,
    );

    const req = request({ hostname: 'acme.acme.test' });
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    expect((req as { tenant?: { slug: string } }).tenant?.slug).toBe('acme');
  });

  it('refuses a request that names no tenant', async () => {
    const middleware = new TenantMiddleware(
      registryWith([acme]),
      configService,
      context,
    );

    // The deployment's own host names no tenant: `acme.test` is the
    // deployment, and nothing is in front of it.
    await expect(
      middleware.use(request({ hostname: 'acme.test' }), {} as never, vi.fn()),
    ).rejects.toThrow(/names no tenant/);
  });

  it("refuses a host that is not the deployment's own domain", async () => {
    const middleware = new TenantMiddleware(
      registryWith([acme]),
      configService,
      context,
    );

    await expect(
      middleware.use(
        request({ hostname: 'acme.example.com' }),
        {} as never,
        vi.fn(),
      ),
    ).rejects.toThrow(/names no tenant/);
  });

  it('refuses a request for a tenant that does not exist', async () => {
    const middleware = new TenantMiddleware(
      registryWith([acme]),
      configService,
      context,
    );

    await expect(
      middleware.use(request({ 'x-tenant-id': 'nope' }), {} as never, vi.fn()),
    ).rejects.toThrow(/no tenant called/);
  });

  it('refuses a request for a tenant that is not being served', async () => {
    const middleware = new TenantMiddleware(
      registryWith([{ ...acme, status: 'disabled' }]),
      configService,
      context,
    );

    await expect(
      middleware.use(request({ 'x-tenant-id': 'acme' }), {} as never, vi.fn()),
    ).rejects.toThrow(/not being served/);
  });

  it('gives every request the default tenant while the feature is off', async () => {
    const middleware = new TenantMiddleware(
      registryWith([]),
      { getOrThrow: () => ({ ...config, enabled: false }) } as never,
      context,
    );

    const req = request({ 'x-tenant-id': 'acme' });
    const next = vi.fn();

    await middleware.use(req, {} as never, next);

    // The header is ignored when the feature is off, so a client that sends one
    // cannot reach a tenant the deployment is not serving.
    expect((req as { tenant?: { id: string } }).tenant?.id).toBe(
      DEFAULT_TENANT_ID,
    );
  });
});
