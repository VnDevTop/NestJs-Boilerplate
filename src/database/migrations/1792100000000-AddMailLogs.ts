import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The mail log, and a request id on both delivery records.
 *
 * ## Why `mail_logs` arrives now
 *
 * The plan for Phase 20 asks to propagate `X-Request-Id` into a "mail record",
 * and the runbook asks to trace a missing email through `mail_logs`. Neither table
 * existed: the mail correlation id lived on a log line and in the memory
 * transport's buffer, both of which are gone by the time anybody asks.
 *
 * So the record is created here rather than the propagation being narrowed to fit
 * what exists. A request id stamped onto a table nobody queries is a column; a
 * request id on the table somebody queries when a user says they got nothing is
 * the feature.
 *
 * ## Why it has no foreign key
 *
 * The rows are evidence, and evidence outlives the thing it is evidence about. A
 * cascade would delete the record of a delivery at the moment an operator erased
 * the account it was delivered to, which is the exact moment somebody might be
 * asking why the erasure email never arrived.
 *
 * ## `requestId` is indexed on both tables, not merely stored
 *
 * The lookup is "a user says they got nothing at 14:02" — one indexed read, not a
 * recipient search across a guessed time window. That is the whole reason for the
 * column, so an unindexed one would be a column nobody used.
 *
 * `mail_logs.recipient` is indexed for the same reason from the other direction:
 * "everything we ever sent this address" is the question a support conversation
 * starts with.
 */
export class AddMailLogs1792100000000 implements MigrationInterface {
  name = 'AddMailLogs1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mail_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "mailId" character varying(64) NOT NULL, "template" character varying(64) NOT NULL, "to" character varying(255) NOT NULL, "transport" character varying(20) NOT NULL, "subject" character varying(255), "delivered" boolean NOT NULL DEFAULT false, "statusCode" integer, "attempts" integer NOT NULL DEFAULT 1, "permanent" boolean NOT NULL DEFAULT false, "error" character varying(500), "requestId" character varying(64), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_mail_logs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_created_at" ON "mail_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_mail_id" ON "mail_logs" ("mailId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_request_id" ON "mail_logs" ("requestId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_logs_recipient" ON "mail_logs" ("to")`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" ADD "requestId" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_request_id" ON "notification_logs" ("requestId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The notification column first, while the table it belongs to still exists.
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_request_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_logs" DROP COLUMN "requestId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_recipient"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_request_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_mail_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_mail_logs_created_at"`);
    await queryRunner.query(`DROP TABLE "mail_logs"`);
  }
}
