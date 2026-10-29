import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialMigration1700000000000 implements MigrationInterface {
  name = 'InitialMigration1700000000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // Initial migration placeholder.
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Initial migration placeholder.
  }
}