import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The per-device counterpart to `users.sessionsVersion`.
 *
 * `users.sessionsVersion` answers "is this account still allowed in", and it is
 * per account by construction: bumping it takes out every device at once. It
 * cannot answer "is this session still allowed in", because an access token
 * carries no device and a logout names one.
 *
 * So the counter moves to where the scope already is. One column, same semantics,
 * read only when a token names the device it belongs to.
 *
 * Defaulted to zero rather than backfilled, matching `users.sessionsVersion`:
 * zero means "never revoked", which is what lets an access token minted before
 * this column existed stay valid, because it carries no claim and the device is
 * at zero, so has nothing to have been revoked from.
 */
export class AddDeviceSessionsVersion1791387245000 implements MigrationInterface {
  name = 'AddDeviceSessionsVersion1791387245000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_devices" ADD "sessionsVersion" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_devices" DROP COLUMN "sessionsVersion"`,
    );
  }
}
