import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The column a word search reads, and the index that makes it fast.
 *
 * ## Why a generated column
 *
 * **A column filled by a trigger is a column that can be wrong.** The trigger
 * misses, the write is rolled back, the trigger is disabled for a moment — and a
 * search index that is wrong is worse than no index, because it answers "no such
 * user" for a user that exists. A generated column is computed by postgres on
 * every write, so it is the row's own text by construction and there is nothing
 * to keep in step.
 *
 * The expression is immutable, which is what a stored generated column has to
 * be, and `to_tsvector` is only immutable for a *literal* configuration — so
 * `simple` is written into the expression rather than read from a setting.
 *
 * ## Why the weights are in the document
 *
 * **`setweight` marks each field's lexemes with a band**, and `ts_rank` reads
 * the bands, so a match on the address outranks a match on the name. The bands
 * come from the field map in `src/modules/users/users-search.ts` — A for the
 * address, B for the two names, C for the role — and a spec compares this
 * expression with the one that map builds. A weight that changed in one place
 * and not the other would make the ranking quietly wrong, and a ranking nobody
 * can explain is a ranking nobody trusts.
 *
 * The role is in the document because "the admins" is a real question; the
 * active flag and the creation date are not, because an account is either
 * active or it is not and a date is a range rather than a word.
 *
 * ## Why GIN
 *
 * **A `tsvector` is not a b-tree candidate.** It holds a document, and the
 * question is which documents contain a lexeme — so the index has to be able to
 * answer "which rows mention this" without reading every row. GIN is the index
 * type for that, and the b-tree the other indexes use would be useless here.
 *
 * ## What it costs
 *
 * **A document per row, maintained on every write.** The column is small — a
 * handful of lexemes for a user — and it is the price of not reading the whole
 * table to answer "who matches ada".
 */
export class AddUserSearchVector1792500000000 implements MigrationInterface {
  name = 'AddUserSearchVector1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "searchVector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("email", '')), 'A') || setweight(to_tsvector('simple', coalesce("firstName", '')), 'B') || setweight(to_tsvector('simple', coalesce("lastName", '')), 'B') || setweight(to_tsvector('simple', coalesce("role", '')), 'C')) STORED`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_search_vector" ON "users" USING GIN ("searchVector")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The index first: postgres would drop it with the column, but saying so
    // is the difference between a rollback that is legible and one that is
    // merely correct.
    await queryRunner.query(`DROP INDEX "public"."IDX_users_search_vector"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "searchVector"`);
  }
}
