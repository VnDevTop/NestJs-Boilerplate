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
 * ## The down
 *
 * **It drops the column it added**, because a migration that cannot be rolled
 * back to the schema it came from is a migration nobody will roll back.
 *
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
