import type { QueryRunner } from 'typeorm';

/**
 * The session setting the row-level policies read.
 *
 * **One name, in one place.** The policies are written in the migration and
 * the application sets the setting, and the two have to agree — a policy reading
 * a setting nobody sets is a policy that matches nothing, which is safe but
 * useless, and a setting nobody reads is a tenant that is not enforced.
 */
export const TENANT_SETTING = 'app.tenant_id';

/**
 * Sets the tenant for the transaction the runner is in.
 *
 * **`set_config` with the local flag, not `SET`.** A plain `SET` would last for
 * the whole session, so the tenant of the last transaction would leak into the
 * next one — and a connection pool hands the same session to the next request.
 * The local flag ties the setting to the transaction, so it ends with it.
 *
 * **Called inside a transaction.** A setting that is local to a transaction
 * needs one, and a query outside a transaction would find the setting empty —
 * which matches no rows, rather than matching somebody else's.
 */
export async function setTenantScope(
  runner: QueryRunner,
  tenantId: string,
): Promise<void> {
  await runner.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [
    tenantId,
  ]);
}
