import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database-managed mail templates, and their version history.
 *
 * ## Why the table is an override rather than the definition
 *
 * Phase 14 shipped the templates as plain functions and this phase adds a table. The
 * only design that does not break an existing deployment is one where an empty table
 * means "render the shipped files", so that is what this creates: the application
 * works identically before and after the migration, and an operator opts in by
 * writing a row.
 *
 * That is also why nothing here is `NOT NULL` on the bodies other than the row
 * itself — a partial override is not a supported state, and the service refuses to
 * write one, so the column constraints only restate what the service already checks.
 *
 * ## The unique index is load-bearing
 *
 * `UQ_email_templates_name_locale` is what makes `findOneBy({ name, locale })` a
 * correct read rather than an arbitrary one. Two operators saving the same template
 * at the same moment would otherwise produce two rows, and which one a send renders
 * would depend on insertion order — an edit that silently does not take effect.
 *
 * ## The version table has no foreign key, on purpose
 *
 * It records what an operator overwrote. A cascade would delete that record when the
 * row it describes was reset back to the shipped file, which is exactly the moment
 * somebody wants to know what they replaced.
 */
export class AddEmailTemplates1792200000000 implements MigrationInterface {
  name = 'AddEmailTemplates1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_templates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(64) NOT NULL, "locale" character varying(16) NOT NULL DEFAULT 'en', "subject" character varying(255) NOT NULL, "text" text NOT NULL, "html" text NOT NULL, "version" integer NOT NULL DEFAULT 1, "updatedBy" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_email_templates" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_templates_name_locale" ON "email_templates" ("name", "locale")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_templates_name" ON "email_templates" ("name")`,
    );

    await queryRunner.query(
      `CREATE TABLE "mail_template_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(64) NOT NULL, "locale" character varying(16) NOT NULL, "version" integer NOT NULL, "subject" character varying(255) NOT NULL, "text" text NOT NULL, "html" text NOT NULL, "updatedBy" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_mail_template_versions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_template" ON "mail_template_versions" ("name", "locale", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mail_template_versions_created_at" ON "mail_template_versions" ("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Indices before their tables, then the tables themselves. The history table goes
    // first: it is the one that describes the other, so dropping the live table first
    // would leave rows describing a table that no longer exists.
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_mail_template_versions_template"`,
    );
    await queryRunner.query(`DROP TABLE "mail_template_versions"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_email_templates_name"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_email_templates_name_locale"`,
    );
    await queryRunner.query(`DROP TABLE "email_templates"`);
  }
}
