import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { ENTITIES } from './data-source.js';
import '../modules/notification/entities/index.js';

/**
 * The migration is hand-written DDL, so it can drift from the entities and nothing
 * else would notice: `synchronize` is off, so a column the entity names and the
 * migration does not create shows up as a runtime error on the first query that
 * touches it, in whichever deployment ran the migration first.
 *
 * This compares the two without a database, which is the only place the comparison
 * can live: a test needing a live Postgres is a test that does not run.
 */

const MIGRATION = '1791500000000-AddNotificationTables.ts';

const TABLES = ['notification_logs', 'notification_preferences'];

const source = readFileSync(
  join(new URL('.', import.meta.url).pathname, 'migrations', MIGRATION),
  'utf8',
);

const up = source.slice(0, source.indexOf('public async down'));
const down = source.slice(source.indexOf('public async down'));

/** Table names a statement mentions, deduplicated and in no particular order. */
function tablesMentioned(sql: string): string[] {
  return [
    ...new Set(
      [...sql.matchAll(/(?:CREATE TABLE|DROP TABLE)\s+"([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

/**
 * Column names inside one CREATE TABLE statement.
 *
 * Each is matched as a quoted name followed by a SQL type, rather than as any quoted
 * name: a statement also quotes constraint names and repeats the columns in the
 * primary key clause, and a looser pattern counts those as columns.
 */
function columnsOf(table: string): string[] {
  const statement = up.split(`CREATE TABLE "${table}" (`)[1] ?? '';

  // The statement ends at the backtick that closes it. Spelled as a character code so
  // this file does not carry a literal one inside a template string.
  const body = statement.split(String.fromCharCode(96))[0];

  // Constraint clauses are stripped first. They quote a name too — `CONSTRAINT
  // "PK_..." PRIMARY KEY ("id")` — and a column list read without this counts the
  // constraint's name as a column, which is the kind of false mismatch that makes a
  // test get deleted rather than fixed.
  //
  // Everything from the first CONSTRAINT onwards, rather than one clause at a time: a
  // UNIQUE constraint's column list contains commas, so a per-clause pattern stops
  // halfway through and leaves the rest behind.
  const columnsOnly = body.split('CONSTRAINT')[0];

  return [...columnsOnly.matchAll(/"([^"]+)"\s+\w+/g)].map((match) => match[1]);
}

function entityColumns(table: string): string[] {
  const target = getMetadataArgsStorage().tables.find(
    (found) => found.name === table,
  )?.target;

  return (
    getMetadataArgsStorage()
      .columns.filter((column) => column.target === target)
      // Every column here is a plain property, so the property name is the column name.
      // `databaseName` is not on this metadata type: it appears once the entity has been
      // built, which needs a DataSource and therefore a database.
      .map((column) => column.propertyName)
      .sort()
  );
}

describe('the notification tables migration', () => {
  it('creates exactly the two tables the entities declare', () => {
    // Both directions matter: a table in the migration with no entity is a table
    // nothing will read, and an entity with no table is a table that does not exist.
    const declared = getMetadataArgsStorage()
      .tables.map((found) => found.name ?? '')
      .filter((found) => found.startsWith('notification'))
      .sort();

    expect(tablesMentioned(up)).toEqual(TABLES);
    expect(declared).toEqual([...TABLES].sort());
  });

  it('creates every column the entities declare', () => {
    // A missing column is the failure this exists for: `synchronize` is off, so it
    // surfaces as a runtime error on the first insert rather than at the migration.
    for (const table of TABLES) {
      expect(columnsOf(table).sort(), table).toEqual(entityColumns(table));
    }
  });

  it('lists both entities in the standalone data source', () => {
    // The TypeORM CLI runs outside Nest and reads this list, so an entity missing
    // from it means a migration generated from it would be incomplete.
    const names = ENTITIES.map((entity) => entity.name);

    expect(names).toContain('NotificationLog');
    expect(names).toContain('NotificationPreference');
  });

  it('drops both tables and their indexes on the way down', () => {
    // Postgres refuses to drop an indexed column without CASCADE, so a down that
    // drops the tables first is a migration nobody can roll back.
    expect(tablesMentioned(down)).toEqual([...TABLES].sort());
    expect(down).toContain('DROP INDEX');
  });

  it('drops every index it created, and each before its table', () => {
    // Postgres refuses to drop an indexed column without CASCADE, so a DROP TABLE
    // preceding its own index is a migration that cannot be rolled back.
    //
    // Per table rather than across the whole statement: creating two tables
    // interleaves their teardown, so demanding every DROP INDEX precede every
    // DROP TABLE would fail a correct ordering.
    const created = [
      ...up.matchAll(/CREATE INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"/g),
    ];

    expect(created.length).toBeGreaterThan(0);

    const indexesOf = (table: string) =>
      [
        ...up.matchAll(new RegExp(`CREATE INDEX "[^"]+" ON "${table}"`, 'g')),
      ].map((match) => match[0].match(/CREATE INDEX "([^"]+)"/)?.[1] ?? '');

    for (const table of TABLES) {
      const tableDrop = down.indexOf(`DROP TABLE "${table}"`);

      expect(tableDrop, table).toBeGreaterThan(-1);

      const names = indexesOf(table).filter(Boolean);

      expect(names.length, `${table} creates no index`).toBeGreaterThan(0);

      for (const name of names) {
        const indexDrop = down.indexOf(`DROP INDEX "public"."${name}"`);

        expect(indexDrop, `${table}.${name} is never dropped`).toBeGreaterThan(
          -1,
        );
        expect(
          indexDrop,
          `${table}.${name} drops after its table`,
        ).toBeLessThan(tableDrop);
      }
    }
  });

  it('has a rollback that creates nothing', () => {
    // A down leaving a table behind means re-running up fails on a name that is
    // already taken, which is the failure a rollback is supposed to prevent.
    expect(down).not.toContain('CREATE TABLE');
  });

  it('creates no foreign key, matching the entities that declare no relation', () => {
    // Both halves are deliberate: the cascade that `role_permissions` has would erase
    // a preference when the retention job hard-deleted a soft-deleted user, which is
    // the moment an administrator might have been about to restore the account.
    expect(up).not.toContain('FOREIGN KEY');
  });
});
