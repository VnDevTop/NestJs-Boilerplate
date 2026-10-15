import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A fixed point for each session, so a session can be given a maximum age.
 *
 * **Why a new column when `createdAt` already exists.** `createdAt` slides: a
 * rotation creates a *new* row and revokes the old one, so every live refresh
 * token in a chain carries the time of the most recent refresh rather than the
 * time the session began. A client that refreshes every six days keeps a session
 * alive forever, and nothing in the row can see that it has been alive forever.
 *
 * The chain cannot be walked backwards to recover the answer either.
 * `replacedById` points forward — old row to new — so the root is reachable only
 * by following pointers the other way, which is the direction the schema does not
 * index. Carrying the value forward costs one column and one assignment, and
 * turns the question into an indexed comparison.
 *
 * **Backfilled from `createdAt`, not left at `now()`.** The default fills every
 * existing row with the migration's own timestamp, which would make every
 * session in a live deployment look brand new and hand every user a fresh
 * absolute-lifetime clock. `createdAt` is the earliest honest answer available
 * for a row, and it errs towards ending a session rather than extending it.
 *
 * **The index is for the operator, not the request path.** The refresh-time
 * comparison reads a row it has already locked by `jti`, so it uses the unique
 * index that is already there. This one answers "which sessions of this user have
 * outlived the limit", which is the question `GET /auth/sessions` asks and the one
 * a cleanup job would ask.
 */
export class AddSessionStartedAt1792300000000 implements MigrationInterface {
  name = 'AddSessionStartedAt1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "sessionStartedAt" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "sessionStartedAt" = "createdAt"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_session_started" ON "refresh_tokens" ("userId", "sessionStartedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Index first: dropping the column would take it with it, and the reverse
    // order is only a habit. Written explicitly so the pairing is visible.
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_session_started"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "sessionStartedAt"`,
    );
  }
}
