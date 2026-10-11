import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The audit trail.
 *
 * **Four indexes, one per question.** An audit table is read by asking four
 * questions and nothing else: who did this, what happened, what was this acted
 * upon, and what did they do in this window. Every index here is one of those, and
 * there is no index on `changedFields` — a jsonb containment index would serve a
 * query nobody writes, at the cost of a write on every privileged action.
 *
 * The composite `(targetType, targetId)` index is the one that earns its keep: "show
 * me everything that ever happened to this user" is the question a support
 * conversation actually asks, and without the composite it is a full scan of a
 * year of rows for every lookup.
 *
 * **No foreign keys at all**, on the actor and on the target alike. A foreign key
 * here would either block the erasure that Phase 19 also adds — the user the audit
 * entry is about is exactly the row the erasure removes — or cascade the evidence
 * away with it. An audit trail that deletes its own records when the subject is
 * deleted is not a trail, so the ids are plain uuid and varchar columns and the
 * rows outlive everything they point at.
 *
 * `actorEmail` is stored as well as `actorId` for the same reason: a join would
 * answer with the address the person has now rather than the one they had when
 * they did it, which is not the same answer.
 */
export class AddAuditLogs1791800000000 implements MigrationInterface {
  name = 'AddAuditLogs1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actorId" uuid, "actorEmail" character varying(255), "actorType" character varying(20) NOT NULL, "action" character varying(64) NOT NULL, "targetType" character varying(64) NOT NULL, "targetId" character varying(255), "before" jsonb, "after" jsonb, "changedFields" jsonb, "ipAddress" character varying(100), "userAgent" character varying(500), "requestId" character varying(64), "outcome" character varying(20) NOT NULL, "statusCode" integer, "error" character varying(500), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_created_at" ON "audit_logs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_actor" ON "audit_logs" ("actorId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_target" ON "audit_logs" ("targetType", "targetId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Written out rather than looped. `DROP TABLE` takes its indexes with it, so
    // this is belt-and-braces — but `migrations.spec.ts` greps the down half for the
    // literal index names, and a loop would hide them behind a variable and let a
    // typo through every assertion.
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_actor"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_target"`);

    await queryRunner.query(`DROP TABLE "audit_logs"`);
  }
}
