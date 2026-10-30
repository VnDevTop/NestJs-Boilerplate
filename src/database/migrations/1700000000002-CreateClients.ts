import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClients1700000000002 implements MigrationInterface {
  name = 'CreateClients1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "clients" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_id" varchar(255) NOT NULL UNIQUE,
        "client_secret_hash" varchar(255) NOT NULL,
        "scopes" text NOT NULL DEFAULT '',
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "clients"`);
  }
}