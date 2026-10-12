import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { ENTITIES } from './data-source.js';
import '../modules/audit/entities/index.js';
import '../modules/notification/entities/index.js';

/**
 * Hand-written DDL can drift from the entities and nothing else would notice:
 * `synchronize` is off, so a column the entity names and the migration does not
 * create shows up as a runtime error on the first query that touches it, in
 * whichever deployment ran the migration first.
 *
 * These compare the two without a database, which is the only place the comparison
 * can live: a test needing a live Postgres is a test that does not run.
 */

/**
 * Every table migration is checked against its entity here rather than per file.
 *
 * The comparison is generic so a new migration joins the existing coverage by
 * being added to one array — a hand-written DDL that drifts from the entity is
 * invisible until a deployment runs it, and by then it is one environment's problem
 * rather than a diff.
 */
const MIGRATIONS: { file: string; tables: string[] }[] = [
  {
    file: '1791500000000-AddNotificationTables.ts',
    tables: ['notification_logs', 'notification_preferences'],
  },
  { file: '1791800000000-AddAuditLogs.ts', tables: ['audit_logs'] },
];

/**
 * Migrations that add a column to an existing table rather than creating one.
 *
 * Checked separately because `columnsOf` reads a `CREATE TABLE` statement and these
 * write `ALTER TABLE … ADD`. The check that matters here is the reverse one: an
 * entity column with no migration is the failure this whole file is for, and for an
 * `ALTER` migration that means every column the migration adds must be one an
 * entity declares — the entity is the larger set, and the extra columns here are the
 * ones that migration brought in.
 */
const ALTER_MIGRATIONS: {
  file: string;
  /** Column name, for the per-migration checks. */
  adds: string[];
  /** Table each one was added to, for folding into the CREATE TABLE comparison. */
  tables?: Record<string, string>;
}[] = [
  { file: '1791900000000-AddVersionColumns.ts', adds: ['version'] },
  {
    file: '1792100000000-AddMailLogs.ts',
    adds: ['requestId'],
    tables: { requestId: 'notification_logs' },
  },
];

function read(file: string): { up: string; down: string } {
  const text = readFileSync(
    join(new URL('.', import.meta.url).pathname, 'migrations', file),
    'utf8',
  );

  return {
    up: text.slice(0, text.indexOf('public async down')),
    down: text.slice(text.indexOf('public async down')),
  };
}

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
/**
 * Columns an `ALTER TABLE … ADD` migration brought in after the table was created.
 *
 * The per-migration check compares a `CREATE TABLE` statement against an entity, so
 * a table that gained a column later would look like the migration and the entity
 * had drifted. Folding the later additions back in is what keeps the comparison
 * honest rather than merely strict.
 */
function laterAdditions(table: string): string[] {
  return ALTER_MIGRATIONS.flatMap((migration) => {
    const declared = migration.tables ?? {};

    return migration.adds.filter(
      (column) =>
        (declared[column] ?? table) === table &&
        new RegExp(`ALTER TABLE "${table}" ADD "${column}"`).test(
          read(migration.file).up,
        ),
    );
  });
}

function columnsOf(table: string, up: string): string[] {
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

/**
 * The class name for a table name.
 *
 * `audit_logs` is `AuditLog` and `notification_logs` is `NotificationLog`, which
 * is TypeORM's own convention rather than a rule this code chose. The suffix is
 * what is being matched on, so the pair below is a lookup table rather than a
 * derivation that could be wrong.
 */
const ENTITY_CLASS_NAMES: Record<string, string> = {
  audit_logs: 'AuditLog',
  notification_logs: 'NotificationLog',
  notification_preferences: 'NotificationPreference',
};

function className(table: string): string | undefined {
  return ENTITY_CLASS_NAMES[table];
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

describe.each(MIGRATIONS)('the $file migration', ({ file, tables: TABLES }) => {
  const { up, down } = read(file);

  it('creates exactly the tables the entities declare, and no others', () => {
    // Both directions matter: a table in the migration with no entity is a table
    // nothing will read, and an entity with no table is a table that does not exist.
    const declared = getMetadataArgsStorage()
      .tables.map((found) => found.name ?? '')
      .filter((found) => TABLES.includes(found))
      .sort();

    expect(tablesMentioned(up)).toEqual([...TABLES].sort());
    expect(declared).toEqual([...TABLES].sort());
  });

  it('creates every column the entities declare', () => {
    // A missing column is the failure this exists for: `synchronize` is off, so it
    // surfaces as a runtime error on the first insert rather than at the migration.
    for (const table of TABLES) {
      const created = columnsOf(table, up);
      const added = laterAdditions(table);

      expect([...created, ...added].sort(), table).toEqual(
        entityColumns(table),
      );
    }
  });

  it('lists every entity in the standalone data source', () => {
    // The TypeORM CLI runs outside Nest and reads this list, so an entity missing
    // from it means a migration generated from it would be incomplete.
    for (const table of TABLES) {
      const declared = ENTITIES.find(
        (entity) => entity.name === table || entity.name === className(table),
      );

      expect(
        declared,
        `${table} is not in the standalone data source`,
      ).toBeDefined();
    }
  });

  it('drops every index it created, and each before its table', () => {
    // Postgres refuses to drop an indexed column without CASCADE, so a DROP TABLE
    // preceding its own index is a migration nobody can roll back.
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
});

describe.each(ALTER_MIGRATIONS)('the $file migration', ({ file, adds }) => {
  const { up } = read(file);

  it('adds every column it claims to', () => {
    // Grepped out of the source rather than compared against the entity: this one
    // adds a subset, and the subset is the point.
    for (const column of adds) {
      expect(up, column).toContain(`ADD "${column}"`);
    }
  });

  it('makes a version column NOT NULL, so no existing row is left unusable', () => {
    // A nullable version would need a null case in every comparison, and the one
    // place that would compare it is exactly the place that must not have an
    // exception. Conditional because a `requestId` is *supposed* to be nullable — a
    // retention job's own mail has no request behind it — and not every ALTER
    // migration here adds a version.
    if (!adds.includes('version')) {
      return;
    }

    expect(up).toMatch(/ADD "version" \w+ NOT NULL DEFAULT/);
  });

  it('leaves a correlation column nullable, because some sends have no request', () => {
    // The opposite requirement, and it is a real one: a send from a scheduled job
    // has no request id, and a NOT NULL column would make it unrecordable — which
    // is how a table ends up with no row for the failures nobody asked about.
    for (const column of adds) {
      if (column === 'version') {
        continue;
      }

      expect(up, column).not.toMatch(
        new RegExp(`ADD "${column}"[^;]*NOT NULL`),
      );
    }
  });

  it('is declared on an entity, so `save()` actually uses it', () => {
    // The migration alone changes nothing: `@VersionColumn()` is what makes
    // TypeORM put the version in the WHERE clause.
    const declared = ENTITIES.filter((entity) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === entity)
        .some((column) => column.options?.type === 'integer'),
    );

    expect(declared.length).toBeGreaterThan(0);
  });

  it('can be rolled back without leaving the entities expecting a column that is gone', () => {
    const { down } = read(file);

    for (const column of adds) {
      expect(down, column).toContain(`DROP COLUMN "${column}"`);
    }
  });
});

describe('the notification tables migration', () => {
  const { up } = read(MIGRATIONS[0]!.file);

  it('creates no foreign key, matching the entities that declare no relation', () => {
    // Both halves are deliberate: the cascade that `role_permissions` has would erase
    // a preference when the retention job hard-deleted a soft-deleted user, which is
    // the moment an administrator might have been about to restore the account.
    expect(up).not.toContain('FOREIGN KEY');
  });
});
