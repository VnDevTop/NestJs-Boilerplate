import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reason an account was erased.
 *
 * Nullable, like the rest of this row's optional state, so an existing account
 * costs nothing and the column stays out of every row that has never used it.
 *
 * The column exists because the hard delete is thirty days away and the answer to
 * "why is this row gone" cannot be reconstructed once it is. The audit trail
 * outlives the row on purpose — no foreign key, no cascade — so the actor is
 * recoverable, but *why* is not recorded anywhere else, and a row with no reason
 * is a row nobody can explain to the person it belonged to.
 */
export class AddDeletionReason1792000000000 implements MigrationInterface {
  name = 'AddDeletionReason1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "deletionReason" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deletionReason"`);
  }
}
