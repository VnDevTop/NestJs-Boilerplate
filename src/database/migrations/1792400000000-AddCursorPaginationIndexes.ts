import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes that make a cursor page an index range scan.
 *
 * **Why these columns, in this order.** A keyset boundary is a comparison on the
 * sort column with the id as a tie-break, so the index has to lead with the sort
 * column and carry the id immediately after it. An index on `createdAt` alone
 * would still filter, but Postgres would have to filter the ties and heap-fetch
 * them before deciding, which is the difference between reading twenty rows and
 * reading every row that shares a timestamp.
 *
 * **Ascending only.** Both directions are served by one index: Postgres scans an
 * index backwards when the sort is reversed, so `?order=asc` costs nothing extra
 * and a second descending index would be a copy maintained on every insert for no
 * query it enables.
 *
 * **The composite ones lead with the equality predicate.** `userId = ?` and
 * `isActive = true` are constants in the sessions and devices pages, so they go
 * first and the sort columns follow — Postgres seeks straight to one user's rows
 * and walks them. With the columns reversed the index could not seek at all and
 * would be worse than the existing two-column index.
 *
 * **`maintenance_logs` gets one despite the entity's own note that it carries no
 * index.** That note was written when the history route used `OFFSET` over a
 * table that "fits in memory". It does not fit in memory forever: nothing prunes
 * it, so it grows for the life of the deployment, and the route an operator opens
 * when something has gone wrong is the last place to have it degrade. The index is
 * four kilobytes per thousand rows and the note in the entity has been corrected
 * to match.
 *
 * **Built without `CONCURRENTLY`.** This one blocks writes to `users` while it
 * runs. `CONCURRENTLY` is the right answer on a live table, but it cannot run
 * inside a transaction and TypeORM wraps migrations in one — so the choice here is
 * a brief lock on a table that receives a handful of signups, against a migration
 * framework that would need a bespoke code path for the alternative. Recorded here
 * rather than left for whoever meets the lock.
 */
export class AddCursorPaginationIndexes1792400000000 implements MigrationInterface {
  name = 'AddCursorPaginationIndexes1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_users_createdat_cursor" ON "users" ("createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_devices_user_active_cursor" ON "user_devices" ("userId", "isActive", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_created_cursor" ON "refresh_tokens" ("userId", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_logs_created_cursor" ON "maintenance_logs" ("createdAt", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_users_createdat_cursor"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_devices_user_active_cursor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_refresh_tokens_user_created_cursor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_maintenance_logs_created_cursor"`,
    );
  }
}
