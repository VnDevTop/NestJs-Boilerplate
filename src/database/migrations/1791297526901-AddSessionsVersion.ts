import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionsVersion1791297526901 implements MigrationInterface {
  name = 'AddSessionsVersion1791297526901';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "sessionsVersion" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "sessionsVersion"`,
    );
  }
}
