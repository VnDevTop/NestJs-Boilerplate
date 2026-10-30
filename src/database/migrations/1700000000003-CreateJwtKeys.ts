import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJwtKeys1700000000003 implements MigrationInterface {
  name = 'CreateJwtKeys1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "jwt_keys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kid" varchar(255) NOT NULL UNIQUE,
        "version" integer NOT NULL,
        "algorithm" varchar(32) NOT NULL DEFAULT 'RS256',
        "private_key" text NOT NULL,
        "public_key" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "jwt_keys"`);
  }
}