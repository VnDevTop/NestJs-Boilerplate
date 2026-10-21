import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The tenant column, on every table, from the start.
 *
 * ## Why it is here before there is a customer
 *
 * **Adding a column to seventeen tables later means touching every query, index
 * and unique constraint again.** The plan puts this phase before the groups that
 * store data precisely because retrofitting a tenant column is the expensive
 * change and doing it once, on a schema that has no rows yet, is the cheap one.
 *
 * The column is `NOT NULL` with a fixed default, so a row written before the
 * feature is switched on still belongs to the tenant the application will look
 * for. The default is a constant rather than a generated uuid: a default that
 * gave every row its own tenant would make every query have to know which one,
 * which is the opposite of a default.
 *
 * ## Why the indexes lead with the tenant
 *
 * **Every query in a multi-tenant application is tenant-scoped**, so an index
 * that does not lead with the tenant is an index the planner can only use to
 * find rows it then has to throw away. Leading with it turns each lookup into a
 * range scan over one tenant's rows.
 *
 * The one exception is the GIN index over the search document: a GIN index
 * cannot lead with a b-tree column without the `btree_gin` extension, and a
 * search that reads a document and then filters it by tenant is still correct —
 * just not as fast as it could be.
 *
 * ## Why the natural keys became composite
 *
 * **An address is only unique within a tenant.** `uq_users_email` on its own
 * would stop the second tenant from having an account with an address the first
 * one already has, which is the whole point of having more than one tenant. So
 * the unique indexes carry the tenant first, and the natural key second.
 *
 * ## The down
 *
 * **It restores the previous indexes exactly**, names and predicates included,
 * because a migration that cannot be rolled back to the schema it came from is a
 * migration nobody will roll back.
 */
export class AddTenantColumn1792600000000 implements MigrationInterface {
  name = 'AddTenantColumn1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_templates" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_logs" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_template_versions" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "permissions" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "two_factor_secrets" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_devices" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "tenantId" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_users_lockedAt"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_createdat_cursor"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f3752400c98d5c0b3dca54d66d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9769b295a8d670435ce210ba15"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_user_revoked"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_user_created_cursor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_session_started"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_devices_user_active"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_devices_user_active_cursor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_19f5536918227dabaddff3a7a5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_90489f8f3368c45f461e90efbe"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_464e435574cc84eb70e4baef19"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_email_verification_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1143abb8c3fad8b06dd857a8c9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f75f11ca4ed69b941336c5d0e3"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_reset_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_history_user_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_unlock_tokens_token_hash"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_unlock_tokens_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_unlock_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_48ce552495d14eae9b187bb671"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_role_permissions_role_permission"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_actor"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_target"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_event"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_request_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_preferences_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_email_templates_name_locale"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_email_templates_name"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_template"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_request_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_recipient"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_mail_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_logs_created_cursor"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("tenantId", "email")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_locked_at" ON "users" ("tenantId", "lockedAt") WHERE "lockedAt" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_createdat_cursor" ON "users" ("tenantId", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_refresh_tokens_jti" ON "refresh_tokens" ("tenantId", "jti")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_device" ON "refresh_tokens" ("tenantId", "deviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_revoked" ON "refresh_tokens" ("tenantId", "userId", "revokedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_created_cursor" ON "refresh_tokens" ("tenantId", "userId", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_session_started" ON "refresh_tokens" ("tenantId", "userId", "sessionStartedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_devices_user_active" ON "user_devices" ("tenantId", "userId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_devices_user_active_cursor" ON "user_devices" ("tenantId", "userId", "isActive", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_two_factor_secrets_user" ON "two_factor_secrets" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_verification_tokens_token" ON "email_verification_tokens" ("tenantId", "tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_tokens_expires_at" ON "email_verification_tokens" ("tenantId", "expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_tokens_user" ON "email_verification_tokens" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_password_reset_tokens_token" ON "password_reset_tokens" ("tenantId", "tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_expires_at" ON "password_reset_tokens" ("tenantId", "expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_user" ON "password_reset_tokens" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_history_user_created" ON "password_history" ("tenantId", "userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_unlock_tokens_token" ON "account_unlock_tokens" ("tenantId", "tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_expires_at" ON "account_unlock_tokens" ("tenantId", "expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_user" ON "account_unlock_tokens" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_permissions_name" ON "permissions" ("tenantId", "name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_role_permissions_role_permission" ON "role_permissions" ("tenantId", "role", "permissionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_created_at" ON "audit_logs" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_actor" ON "audit_logs" ("tenantId", "actorId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("tenantId", "action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_target" ON "audit_logs" ("tenantId", "targetType", "targetId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_created_at" ON "notification_logs" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_event" ON "notification_logs" ("tenantId", "event")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_request_id" ON "notification_logs" ("tenantId", "requestId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_preferences_user" ON "notification_preferences" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_templates_name_locale" ON "email_templates" ("tenantId", "name", "locale")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_templates_name" ON "email_templates" ("tenantId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_template" ON "mail_template_versions" ("tenantId", "name", "locale", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_created_at" ON "mail_template_versions" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_created_at" ON "mail_logs" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_request_id" ON "mail_logs" ("tenantId", "requestId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_recipient" ON "mail_logs" ("tenantId", "to")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_mail_id" ON "mail_logs" ("tenantId", "mailId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_logs_created_cursor" ON "maintenance_logs" ("tenantId", "createdAt", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_users_email"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_locked_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_createdat_cursor"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_refresh_tokens_jti"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_refresh_tokens_device"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_user_revoked"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_user_created_cursor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_session_started"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_devices_user_active"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_devices_user_active_cursor"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_two_factor_secrets_user"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_email_verification_tokens_token"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_email_verification_tokens_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_email_verification_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_password_reset_tokens_token"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_reset_tokens_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_reset_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_history_user_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_account_unlock_tokens_token"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_unlock_tokens_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_unlock_tokens_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_permissions_name"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_role_permissions_role_permission"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_actor"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_target"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_event"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_request_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_preferences_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_email_templates_name_locale"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_email_templates_name"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_template"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_request_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_recipient"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_mail_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_logs_created_cursor"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_lockedAt" ON "users" ("lockedAt") WHERE "lockedAt" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_createdat_cursor" ON "users" ("createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f3752400c98d5c0b3dca54d66d" ON "refresh_tokens" ("jti")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9769b295a8d670435ce210ba15" ON "refresh_tokens" ("deviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_revoked" ON "refresh_tokens" ("userId", "revokedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_created_cursor" ON "refresh_tokens" ("userId", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_session_started" ON "refresh_tokens" ("userId", "sessionStartedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_devices_user_active" ON "user_devices" ("userId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_devices_user_active_cursor" ON "user_devices" ("userId", "isActive", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_19f5536918227dabaddff3a7a5" ON "two_factor_secrets" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_90489f8f3368c45f461e90efbe" ON "email_verification_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_464e435574cc84eb70e4baef19" ON "email_verification_tokens" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_tokens_user" ON "email_verification_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_1143abb8c3fad8b06dd857a8c9" ON "password_reset_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f75f11ca4ed69b941336c5d0e3" ON "password_reset_tokens" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_user" ON "password_reset_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_history_user_created" ON "password_history" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_account_unlock_tokens_token_hash" ON "account_unlock_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_expires_at" ON "account_unlock_tokens" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_user" ON "account_unlock_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_48ce552495d14eae9b187bb671" ON "permissions" ("name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_role_permissions_role_permission" ON "role_permissions" ("role", "permissionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_created_at" ON "audit_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_actor" ON "audit_logs" ("actorId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_target" ON "audit_logs" ("targetType", "targetId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_created_at" ON "notification_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_event" ON "notification_logs" ("event")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_request_id" ON "notification_logs" ("requestId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_preferences_user" ON "notification_preferences" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_templates_name_locale" ON "email_templates" ("name", "locale")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_templates_name" ON "email_templates" ("name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_template" ON "mail_template_versions" ("name", "locale", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_created_at" ON "mail_template_versions" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_created_at" ON "mail_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_request_id" ON "mail_logs" ("requestId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_recipient" ON "mail_logs" ("to")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_mail_id" ON "mail_logs" ("mailId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_logs_created_cursor" ON "maintenance_logs" ("createdAt", "id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "tenantId"`);
    await queryRunner.query(
      `ALTER TABLE "email_templates" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(`ALTER TABLE "mail_logs" DROP COLUMN "tenantId"`);
    await queryRunner.query(
      `ALTER TABLE "mail_template_versions" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(`ALTER TABLE "permissions" DROP COLUMN "tenantId"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "two_factor_secrets" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_devices" DROP COLUMN "tenantId"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tenantId"`);
  }
}
