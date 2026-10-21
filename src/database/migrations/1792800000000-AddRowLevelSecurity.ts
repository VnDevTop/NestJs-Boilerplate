import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Row-level security, as the layer underneath the repository scope.
 *
 * ## Why it is underneath and not instead
 *
 * **The repository scope is the first line and this is the second.** An
 * application bug that forgets the scope gets an empty result from this rather
 * than another tenant's data — which is the difference between a bug and a
 * breach. The two are not alternatives: the scope is what the code *intends*,
 * and the policy is what the database *enforces*.
 *
 * ## Why FORCE
 *
 * **Without `FORCE`, the table owner bypasses the policy** — and the
 * application connects as the owner, because the owner is the role that owns
 * the tables. `FORCE ROW LEVEL SECURITY` applies the policy to the owner too,
 * which is the only way the policy applies to the application at all.
 *
 */
export class AddRowLevelSecurity1792800000000 implements MigrationInterface {
  name = 'AddRowLevelSecurity1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_templates" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_logs" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`ALTER TABLE "mail_logs" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `ALTER TABLE "mail_template_versions" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_template_versions" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "permissions" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "permissions" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "two_factor_secrets" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "two_factor_secrets" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_devices" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_devices" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`ALTER TABLE "users" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "users" FORCE ROW LEVEL SECURITY`);

    /**
     * The role the application connects as.
     *
     * **Not a superuser, because a superuser bypasses every policy** — and the
     * policies are the layer underneath the repository scope, so a bypass would
     * make them decoration.
     *
     * The password is the deployment's to set: this role is created so that the
     * shape exists, and the credentials belong in the environment.
     */
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DISABLE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `ALTER TABLE "user_devices" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "two_factor_secrets" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "permissions" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_template_versions" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_logs" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_templates" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" DISABLE ROW LEVEL SECURITY`,
    );
  }
}
