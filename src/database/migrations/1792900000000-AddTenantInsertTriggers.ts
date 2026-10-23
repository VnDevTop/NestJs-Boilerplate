import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fills `tenantId` from the session the insert is running on.
 *
 * The row-level policy's `WITH CHECK` compares the new row's `tenantId` with
 * `app.tenant_id`. A column default cannot be per-request, so an insert that
 * does not name the tenant writes the default tenant — and in any tenant but
 * the default that is a policy violation rather than a row.
 *
 * **A trigger instead of a TypeORM subscriber.** Subscribers fire for
 * `repository.save()`, but `repository.insert()` and a query builder's
 * `.insert()` go straight to SQL. That is not a corner: the audit writer, the
 * mail log and the password history all insert that way, and they are exactly
 * the rows that must carry the tenant. The database is the one layer every
 * path passes through.
 *
 * **Only when the setting exists.** With multi-tenancy off nothing sets
 * `app.tenant_id`, so the trigger leaves the column's default alone and a
 * single-tenant deployment behaves exactly as before.
 */
export class AddTenantInsertTriggers1792900000000 implements MigrationInterface {
  name = 'AddTenantInsertTriggers1792900000000';

  private readonly tables = [
    'account_unlock_tokens',
    'audit_logs',
    'email_templates',
    'email_verification_tokens',
    'mail_logs',
    'mail_template_versions',
    'maintenance_logs',
    'notification_logs',
    'notification_preferences',
    'password_history',
    'password_reset_tokens',
    'permissions',
    'refresh_tokens',
    'role_permissions',
    'two_factor_secrets',
    'user_devices',
    'users',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION app_set_tenant_id() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE
         current_tenant text := current_setting('app.tenant_id', true);
       BEGIN
         IF current_tenant IS NOT NULL AND current_tenant <> '' THEN
           NEW."tenantId" := current_tenant::uuid;
         END IF;
         RETURN NEW;
       END;
       $$`,
    );

    for (const table of this.tables) {
      await queryRunner.query(
        `CREATE TRIGGER "tenant_id_from_session" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION app_set_tenant_id()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "tenant_id_from_session" ON "${table}"`,
      );
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS app_set_tenant_id()`);
  }
}
