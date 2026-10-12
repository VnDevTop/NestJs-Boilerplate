import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The permanent lockout: two columns on `users` and the table holding the tokens
 * that clear one.
 *
 * Both columns are nullable rather than defaulted. A locked account is the rare
 * case, so `NULL` is the cheap default and an index over it stays empty until one
 * exists — the opposite of a `locked boolean DEFAULT false`, which is the same
 * information with an extra column in every row and an index that cannot be a
 * partial one.
 *
 * The index is partial on `lockedAt IS NOT NULL`, which is the whole point of
 * making the column nullable. An operator asking "who is locked" reads a handful
 * of rows out of millions, and a partial index over just those is a fraction of
 * the size of the full one while answering the same question.
 *
 * `account_unlock_tokens` cascades from `users` for the same reason the other
 * token tables do: a restored account must not inherit the capability to unlock
 * itself from a backup taken while the lock was on.
 */
export class AddAccountLockout1791700000000 implements MigrationInterface {
  name = 'AddAccountLockout1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "lockedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "lockReason" character varying(255)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_lockedAt" ON "users" ("lockedAt") WHERE "lockedAt" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_unlock_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "tokenHash" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_account_unlock_tokens" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_user" ON "account_unlock_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_account_unlock_tokens_token_hash" ON "account_unlock_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_unlock_tokens_expires_at" ON "account_unlock_tokens" ("expiresAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" ADD CONSTRAINT "FK_account_unlock_tokens_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_unlock_tokens" DROP CONSTRAINT "FK_account_unlock_tokens_user"`,
    );
    await queryRunner.query(`DROP TABLE "account_unlock_tokens"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_lockedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lockReason"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lockedAt"`);
  }
}
