import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

/**
 * The tenant a request is about.
 *
 * **A snapshot, and only what a query needs.** The context is read by the
 * repositories, the cache keys and the queue, and none of them needs the
 * tenant's plan — so the shape is here rather than the module's own type, and
 * the common layer does not have to know about the tenancy module.
 */
export interface TenantScope {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly plan: string;
  /** Where the tenant's data lives, or null for the default schema. */
  readonly schemaName: string | null;
}

/**
 * Which tenant the work in flight is about.
 *
 * **On `AsyncLocalStorage`, and that is the whole point.** A tenant that had
 * to be passed as an argument to every service would be passed to every
 * service *that remembered*, and the one that forgot would read another
 * tenant's rows. The context is the only version of this that cannot be
 * forgotten, because nothing has to carry it.
 *
 * **Set before any guard runs.** The tenant decides what a request may see, so
 * a guard that cannot read it cannot decide anything. The middleware that
 * resolves the tenant wraps the whole chain.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantScope>();

  /**
   * Runs some work as a tenant.
   *
   * **The scope ends with the work.** A callback that outlives the request
   * would keep the tenant alive, and the work would be done in a context that
   * says something that is no longer true.
   */
  run<T>(tenant: TenantScope, fn: () => T): T {
    return this.storage.run(tenant, fn);
  }

  /** The tenant of the work in flight, or undefined. */
  current(): TenantScope | undefined {
    return this.storage.getStore();
  }

  /**
   * The tenant of the work in flight, or an error.
   *
   * **For the code that cannot work without one.** A repository that has no
   * tenant to scope its query by would read the whole table, and the whole
   * table is every tenant's rows.
   */
  require(): TenantScope {
    const tenant = this.storage.getStore();

    if (tenant === undefined) {
      throw new Error(
        'This work is not running as a tenant. Every query has to know whose ' +
          'rows it is reading.',
      );
    }

    return tenant;
  }
}
