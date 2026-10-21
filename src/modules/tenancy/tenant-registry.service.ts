import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DEFAULT_TENANT_ID } from '../../common/tenancy/tenant.constants.js';
import { Tenant, type TenantStatus } from './entities/tenant.entity.js';

/**
 * What the application knows about a tenant.
 *
 * **A snapshot rather than the row**, because the context carries it into
 * places that have no repository — a queued job, a scheduled run — and a row
 * that can be read again is a row that can be changed under the work in flight.
 */
export interface TenantContextValue {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: string;
  /** Where the tenant's data lives, or null for the default schema. */
  readonly schemaName: string | null;
}

/**
 * The tenants this deployment serves.
 *
 * **The registry is the only place a tenant is turned into a row.** A request
 * carries a slug, the slug is looked up here, and what comes back is either a
 * tenant or nothing at all — and nothing at all is a 401, not a default.
 */
@Injectable()
export class TenantRegistry {
  private readonly logger = new Logger(TenantRegistry.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly repository: Repository<Tenant>,
  ) {}

  /**
   * The tenant with this slug, or null.
   *
   * **Null rather than a default**, because a request for a tenant that does
   * not exist has asked for somebody else's data. Falling back to the default
   * tenant would answer that request with this deployment's rows.
   */
  async findBySlug(slug: string): Promise<TenantContextValue | null> {
    const tenant = await this.repository.findOne({ where: { slug } });

    return tenant === null ? null : TenantRegistry.toContext(tenant);
  }

  /**
   * The tenant with this id, or null.
   */
  async findById(id: string): Promise<TenantContextValue | null> {
    const tenant = await this.repository.findOne({ where: { id } });

    return tenant === null ? null : TenantRegistry.toContext(tenant);
  }

  /**
   * The tenant every request belongs to while multi-tenancy is off.
   *
   * **The fixed default, and it is not looked up.** The registry row may not
   * exist in a database that has not been seeded, and a request that arrives
   * with the feature off must still be answered — so the default is the
   * constant the column's default is, and the row is what the seeder writes
   * so that an operator can see it.
   */
  defaultTenant(): TenantContextValue {
    return {
      id: DEFAULT_TENANT_ID,
      slug: 'default',
      name: 'Default tenant',
      status: 'active',
      plan: 'free',
      schemaName: null,
    };
  }

  /**
   * Whether a tenant is being served.
   *
   * **A disabled tenant is refused, not served slowly.** The point of disabling
   * a tenant is that its data stops being reachable, and a tenant that is
   * disabled but still answered is a tenant whose data is still reachable.
   */
  isServing(tenant: TenantContextValue): boolean {
    return tenant.status === 'active';
  }

  /** The row as the context carries it. */
  static toContext(tenant: Tenant): TenantContextValue {
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      schemaName: tenant.schemaName,
    };
  }
}
