import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records that a maintenance run was stopped on request.
 *
 * ## Why a column and not a word in the log
 *
 * `maintenance_logs` already had `timedOut`, and a cancelled run leaves the same
 * shape behind it: some tables cleaned, some listed in `pending`. A record that
 * cannot tell those two apart is a record an operator has to guess at, and the
 * guess is expensive — a timed-out run needs attention, a cancelled run was
 * stopped on purpose and its remaining tables are the next run's work.
 *
 * The alternative was leaving it out and letting the job's own record carry the
 * reason. That record lives in redis with a TTL, so a question asked a week
 * later about a run from last Tuesday would have no answer in it, while the
 * log table keeps a row forever.
 *
 * ## Why the default is false
 *
 * Every row written before this migration was a run that was not cancelled, and
 * the column has to say so rather than be null: "did this run stop because
 * somebody asked it to" has two answers, and a third one that is neither is a
 * question the reader has to interpret.
 */
export class AddMaintenanceCancelled1792500000000 implements MigrationInterface {
  name = 'AddMaintenanceCancelled1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" ADD "cancelled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_logs" DROP COLUMN "cancelled"`,
    );
  }
}
