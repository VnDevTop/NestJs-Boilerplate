import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxTable implements MigrationInterface {
  name = 'AddOutboxTable';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "public"."outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "aggregate" character varying(255) NOT NULL,
        "event_id" character varying(255) NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_outbox" PRIMARY KEY ("id")
      )`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_aggregate" ON "public"."outbox" ("aggregate")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_event_id" ON "public"."outbox" ("event_id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_processed" ON "public"."outbox" ("processed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_processed"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_event_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_aggregate"`);
    await queryRunner.query(`DROP TABLE "public"."outbox"`);
  }
}
