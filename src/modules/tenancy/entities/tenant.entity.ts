import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

/**
 * What a tenant is doing.
 *
 * **Two states rather than a boolean**, because "disabled" and "not yet
 * enabled" are different facts and a deployment has both: a tenant whose trial
 * has ended and a tenant somebody created by hand and has not switched on yet
 * are not the same problem.
 */
export type TenantStatus = 'active' | 'disabled';

/**
 * One tenant.
 *
 * **The registry row, not the data.** This table says a tenant exists, what it
 * is called and whether it is serving; the rows themselves carry a `tenantId`
 * and are found through it. Keeping the two apart is what lets a deployment
 * list its tenants, refuse a disabled one and seed a default one without
 * touching a single row of anybody's data.
 */
@Entity({ name: 'tenants' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The name a request carries.
   *
   * **Unique, and a plain word.** It is the one piece of the tenant a client
   * sends, so it has to be something a person can type and a proxy can route
   * on.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  slug!: string;

  /** What the tenant is called in an operator's screen. */
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** Whether the tenant is being served. */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: TenantStatus;

  /**
   * Which plan the tenant is on.
   *
   * **A name and nothing else.** What a plan *grants* is Phase 64's business —
   * a plan maps to entitlements, and an entitlement maps to a permission. A
   * column that meant something on its own would be a second source of truth
   * about who may do what.
   */
  @Column({ type: 'varchar', length: 50, default: 'free' })
  plan!: string;

  /**
   * Where this tenant's data lives, when it does not live with everybody else's.
   *
   * **Null means the default schema.** The row-mode tenancy this repository
   * ships is one database with a `tenantId` column on every table, and every
   * tenant's rows are in it. The column is there for the schema-per-tenant mode
   * of Phase 92, which is the one case where a tenant's data is somewhere else
   * entirely.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  schemaName!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * The tenant a single-tenant deployment uses.
 *
 * **The same id as the column's default**, so a row written before the
 * registry existed and a row written after it belong to the same tenant — which
 * is what makes the feature switchable without a backfill.
 */
export const DEFAULT_TENANT_SLUG = 'default';

export const DEFAULT_TENANT = {
  id: DEFAULT_TENANT_ID,
  slug: DEFAULT_TENANT_SLUG,
  name: 'Default tenant',
  status: 'active' as TenantStatus,
  plan: 'free',
  schemaName: null,
};
