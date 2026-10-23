import { Injectable } from '@nestjs/common';
import type {
  EntitySubscriberInterface,
  QueryRunner,
  QueryEvent,
} from 'typeorm';

import { DEFAULT_TENANT_ID } from './tenant.constants.js';
import { TENANT_SETTING } from './tenant-scope.js';
import { TenantContextService } from './tenant-context.service.js';

/**
 * Puts the request's tenant into the session the query runs on.
 *
 * **The setting the row-level policies read has to be set by something.** The
 * retention run already sets it on its own transaction, but the request path
 * goes through the shared pool: there is no transaction per request, and a
 * session setting that outlived the query would leak this tenant into the next
 * one on the same connection.
 *
 * So the setting is made *around every statement*, not once per request. The
 * connection is borrowed from the pool, the tenant is set, the statement runs,
 * and the setting is cleared before the connection goes back. A pooled
 * connection therefore never carries a tenant it is not using.
 *
 * **Resetting matters as much as setting.** `current_setting(..., true)` is
 * null when unset and matches no rows — the safe direction. Leaving the
 * previous tenant behind would be the unsafe one.
 *
 * This subscriber is only installed while multi-tenancy or row-level security
 * is on. With both off, every row belongs to the default tenant and the three
 * round trips per query would buy nothing.
 */
@Injectable()
export class TenantScopeSubscriber implements EntitySubscriberInterface {
  private readonly applying = new WeakSet<QueryRunner>();

  constructor(private readonly context: TenantContextService) {}

  async beforeQuery(event: QueryEvent): Promise<void> {
    if (!this.enabled() || this.isControlQuery(event.query)) {
      return;
    }

    const runner = event.queryRunner;

    if (this.applying.has(runner)) {
      return;
    }

    this.applying.add(runner);

    try {
      await runner.query(`SELECT set_config('${TENANT_SETTING}', $1, false)`, [
        this.tenantId(),
      ]);
    } finally {
      this.applying.delete(runner);
    }
  }

  async afterQuery(event: QueryEvent): Promise<void> {
    if (!this.enabled() || this.isControlQuery(event.query)) {
      return;
    }

    const runner = event.queryRunner;

    if (this.applying.has(runner)) {
      return;
    }

    this.applying.add(runner);

    try {
      // A failed statement inside a transaction leaves it aborted, and a reset
      // there would produce a second error that hides the first. The rollback
      // clears the setting anyway.
      await runner.query(`RESET ${TENANT_SETTING}`);
    } catch {
      // Best effort. The connection is either about to be rolled back or was
      // already broken; neither is improved by throwing from a listener.
    } finally {
      this.applying.delete(runner);
    }
  }

  private enabled(): boolean {
    return (
      process.env.MULTI_TENANT === 'true' || process.env.DATABASE_RLS === 'true'
    );
  }

  private tenantId(): string {
    return this.context.current()?.id ?? DEFAULT_TENANT_ID;
  }

  /**
   * Statements that must not be wrapped.
   *
   * Transaction control cannot carry a tenant (there is no row to filter), and
   * wrapping it would turn `BEGIN` into three statements. A statement that sets
   * the setting itself is left alone: that is how the retention run and the
   * export stream deliberately scopes a transaction, and resetting it
   * immediately would undo what it just did.
   */
  private isControlQuery(query: string): boolean {
    const trimmed = query.trimStart();

    if (trimmed.startsWith(`SELECT set_config('${TENANT_SETTING}'`)) {
      return true;
    }

    return /^(begin|start\s+transaction|commit|rollback|savepoint|release\s+savepoint|set\s+transaction|reset)\b/i.test(
      trimmed,
    );
  }
}
