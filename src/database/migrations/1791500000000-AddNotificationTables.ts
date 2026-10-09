import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The notification preferences and the delivery log.
 *
 * Two tables, and they answer opposite questions. `notification_preferences` is
 * read on the request path — a user has muted an event — and `notification_logs`
 * is read by an operator after the fact, once something went wrong or went
 * missing. Neither index is on the other's access pattern, which is why they are
 * separate tables rather than one with a nullable half.
 *
 * `notification_preferences` has no foreign key to `users`, deliberately and
 * against the precedent of `role_permissions`. A user row is soft deleted first and
 * hard deleted by the retention job thirty days later, so a cascade would erase a
 * preference at the moment an administrator restored the account. The row outliving
 * its user is harmless here — nothing reads a preference for a user that is not
 * there — and it is the only way the preference survives a restore.
 *
 * `notification_logs` keeps its `userId` indexed rather than constrained for the
 * same reason, plus one more: a log row is evidence, and evidence that vanishes
 * with the row it describes is not evidence.
 */
export class AddNotificationTables1791500000000 implements MigrationInterface {
  name = 'AddNotificationTables1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_preferences" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "event" character varying(64) NOT NULL, "channel" character varying(20) NOT NULL, "enabled" boolean NOT NULL DEFAULT 'true', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_notification_preferences" PRIMARY KEY ("id"), CONSTRAINT "UQ_notification_preferences_user_event_channel" UNIQUE ("userId", "event", "channel"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_preferences_user" ON "notification_preferences" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "notification_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "notificationId" uuid NOT NULL, "event" character varying(64) NOT NULL, "channel" character varying(20) NOT NULL, "userId" uuid, "recipient" character varying(255), "delivered" boolean NOT NULL DEFAULT 'false', "statusCode" integer, "attempts" integer NOT NULL DEFAULT '1', "error" character varying(500), "body" character varying(1000), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_notification_logs" PRIMARY KEY ("id"))`,
    );
    // The retention job deletes by age with `WHERE createdAt < cutoff`, so without
    // this every nightly run is a sequential scan of a table that grows on every
    // registration.
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_created_at" ON "notification_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_logs_event" ON "notification_logs" ("event")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_event"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_logs_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "notification_logs"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_preferences_user"`,
    );
    await queryRunner.query(`DROP TABLE "notification_preferences"`);
  }
}
