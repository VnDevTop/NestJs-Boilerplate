import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimistic locking on the two entities a request reads before it writes.
 *
 * **Only those two.** Every other table here is written with `insert`, `delete` or
 * a whole-set replace inside a transaction — `refresh_tokens`, `user_devices`,
 * `two_factor_secrets`, `role_permissions`, `permissions`. Nothing loads one of
 * those rows to edit it a field at a time, so there is no read-modify-write window
 * for a version column to close. Adding one there would be a counter bumped on
 * writes that never race, and a false sense that the entity is protected.
 *
 * `users` and `notification_preferences` are different: the update routes load the
 * row, merge the request body into it and save. That is a lost update waiting to
 * happen, and the version column is what turns it from "both requests succeeded and
 * one silently reverted the other" into a 409 the caller can act on.
 *
 * **Backfilled to 1, not 0.** TypeORM's `@VersionColumn` semantics are "the version
 * on the entity is compared in the WHERE clause and incremented", and a row starting
 * at 0 would be indistinguishable from a row whose version was never set. The
 * default matches the column default so an insert from TypeORM and one from the
 * migration agree.
 *
 * **`NOT NULL` with a default, not a nullable column.** A null version would have
 * to be special-cased in every comparison, and the one place that would compare it
 * is exactly the place that must not have an exception.
 */
export class AddVersionColumns1791900000000 implements MigrationInterface {
  name = 'AddVersionColumns1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD "version" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversed as one pair rather than table by table: a half-applied version
    // column is worse than neither, because the entities still carry it and every
    // `save()` on those rows would silently stop matching.
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" DROP COLUMN "version"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "version"`);
  }
}
