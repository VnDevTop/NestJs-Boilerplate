import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The last N password hashes per user, so a user cannot cycle between two.
 *
 * Only the hash is stored, in the same `salt:key` scrypt form `users.password`
 * already holds, so a hash that verifies against the history also verifies against
 * the account. That reuse is the reason for the 255 character column matching the
 * existing one: a mismatch here would be a history that silently never matches,
 * which reads as "the feature is off" rather than as a bug.
 *
 * The index is on `(userId, createdAt)` because every read is "the last N for this
 * user". Without the timestamp in it, every password change sorts the user's whole
 * history — at the exact moment they are least patient.
 *
 * The foreign key cascades. A password history is security material, so a
 * restored account must not inherit the hashes of passwords an attacker already
 * knows. This is the opposite decision to `notification_preferences`, which has no
 * key at all so that a mute survives a restore.
 */
export class AddPasswordHistory1791600000000 implements MigrationInterface {
  name = 'AddPasswordHistory1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "password_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "passwordHash" character varying(255) NOT NULL, "reason" character varying(40) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_password_history" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_history_user_created" ON "password_history" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_history" ADD CONSTRAINT "FK_password_history_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "password_history" DROP CONSTRAINT "FK_password_history_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_history_user_created"`,
    );
    await queryRunner.query(`DROP TABLE "password_history"`);
  }
}
