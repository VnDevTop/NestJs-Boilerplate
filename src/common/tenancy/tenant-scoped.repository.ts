import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { TenantContextService } from './tenant-context.service.js';

/**
 * The query options a scoped read takes.
 *
 * **Only the ones this repository supports.** A narrower type than
 * TypeORM's is the point: a method that took the full `FindOptions` would
 * accept a `where` that this repository then has to merge with the scope, and
 * merging a scope into somebody else's `where` is where a leak hides.
 */
export interface ScopedFindOptions<T extends ObjectLiteral> {
  /** The columns to read. */
  readonly select?: string[];
  /** The rows to read, beyond the tenant. */
  readonly where?: Partial<T>;
  /** How many rows to read. */
  readonly limit?: number;
  /** How many rows to skip. */
  readonly offset?: number;
  /** The order to read them in. */
  readonly order?: Record<string, 'ASC' | 'DESC'>;
}

/**
 * A repository that only ever sees one tenant's rows.
 *
 * **The scope is applied here, once, for every method.** A query that had to
 * remember to scope itself is a query that will forget: the same repository is
 * used by the list route, the export, the job and the seed, and the one that
 * forgets is the one nobody reads. So the scope is not a parameter of the
 * query — it is a property of the repository, and a caller cannot leave it out
 * because there is nowhere to leave it out.
 *
 * **Every method carries the tenant, including the writes.** An update that
 * matched a row by id alone would change another tenant's row; a delete that
 * matched by email alone would delete one. The scope is on the update and the
 * delete for the same reason it is on the read.
 */
export class TenantScopedRepository<T extends ObjectLiteral> {
  constructor(
    private readonly repository: Repository<T>,
    private readonly context: TenantContextService,
  ) {}

  /** A query builder that is already scoped to the tenant. */
  createQueryBuilder(alias?: string): SelectQueryBuilder<T> {
    const builder = this.repository.createQueryBuilder(alias);
    const name = alias ?? builder.alias;

    return builder.andWhere(`${name}.tenantId = :tenantId`, {
      tenantId: tenantIdOf(this.context),
    });
  }

  /** The rows of this tenant that match. */
  async find(options: ScopedFindOptions<T> = {}): Promise<T[]> {
    return (await this.repository.find({
      select: options.select,
      where: { ...options.where, tenantId: tenantIdOf(this.context) },
      order: options.order,
      take: options.limit,
      skip: options.offset,
    } as never)) as unknown as T[];
  }

  /** One row of this tenant, or null. */
  async findOne(options: { where: Partial<T> }): Promise<T | null> {
    return this.repository.findOne({
      where: { ...options.where, tenantId: tenantIdOf(this.context) },
    } as never);
  }

  /** How many rows of this tenant match. */
  async count(options: { where?: Partial<T> } = {}): Promise<number> {
    return this.repository.count({
      where: { ...options.where, tenantId: tenantIdOf(this.context) },
    } as never);
  }

  /** Whether this tenant has a row that matches. */
  async exists(options: { where: Partial<T> }): Promise<boolean> {
    return this.repository.exists({
      where: { ...options.where, tenantId: tenantIdOf(this.context) },
    } as never);
  }

  /**
   * Writes a row.
   *
   * **The tenant is set on the way in**, so a row cannot be written into
   * another tenant by a caller that forgot to say which one.
   */
  async save(entity: DeepPartial<T>): Promise<T> {
    return (await this.repository.save({
      ...entity,
      tenantId: tenantIdOf(this.context),
    } as never)) as unknown as T;
  }

  /** Deletes the rows of this tenant that match. */
  async delete(criteria: Partial<T>): Promise<number> {
    const result = await this.repository.delete({
      ...criteria,
      tenantId: tenantIdOf(this.context),
    } as never);

    return result.affected ?? 0;
  }
}

/**
 * The tenant every query carries.
 *
 * **Required, not defaulted.** A repository with no tenant to scope its query
 * by would read the whole table, and the whole table is every tenant's rows.
 *
 * A function rather than a method, so the class's public surface is exactly
 * the methods a caller can use — and a spec can list them and check that every
 * one of them scopes.
 */
function tenantIdOf(context: TenantContextService): string {
  return context.require().id;
}

/** The part of an entity a write may set. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] | undefined;
};
