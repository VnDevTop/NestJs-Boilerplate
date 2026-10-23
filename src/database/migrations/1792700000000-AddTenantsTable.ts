import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The tenants this deployment serves.
 *
 * **A registry, not a data table.** The rows themselves carry a `tenantId` and
 * are found through it; this table says a tenant exists, what it is called and
 * whether it is being served. Keeping the two apart is what lets a deployment
 * list its tenants and refuse a disabled one without touching a single row of
 * anybody's data.
 *
 * **The default tenant row is seeded, not migrated.** A migration creates the
 * schema; a seeder writes the data. The seeder's row carries the same id the
 * column's default is, so a row written before the registry existed belongs to
 * the tenant the application will look for.
 */
export class AddTenantsTable1792700000000 implements MigrationInterface {
  name = 'AddTenantsTable1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(100) NOT NULL, "name" character varying(200) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', "plan" character varying(50) NOT NULL DEFAULT 'free', "schemaName" character varying(255), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_tenants" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_tenants_slug" ON "tenants" ("slug")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_tenants_slug"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
  }
}
