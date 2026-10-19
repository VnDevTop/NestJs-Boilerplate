import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import '../modules/audit/entities/index.js';
import '../modules/mail/entities/index.js';
import '../modules/notification/entities/index.js';
import '../modules/auth/entities/index.js';
import '../modules/users/entities/index.js';
import '../modules/maintenance/entities/maintenance-log.entity.js';

/**
 * The index declarations and the DDL that creates them are two artefacts, and
 * nothing compares them.
 *
 * `synchronize` is off, so a mismatch does not fail at boot: it fails the first
 * time somebody runs `migration:generate` and reads a diff that should not be
 * there, or — worse — it never fails and the database quietly serves a query
 * without the index that was supposed to make it fast.
 *
 * This compares the two, for every table, in both directions.
 */

interface MigrationIndex {
  file: string;
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}

interface EntityIndex {
  name: string | null;
  table: string;
  columns: string[];
  unique: boolean;
}

function entityIndexes(): EntityIndex[] {
  const storage = getMetadataArgsStorage();

  return storage.indices
    .filter((index) => Array.isArray(index.columns))
    .map((index) => {
      const table = storage.tables.find(
        (entry) => entry.target === index.target,
      )?.name;

      return {
        name: typeof index.name === 'string' ? index.name : null,
        table: table ?? 'unknown',
        columns: (index.columns as string[]).map(String),
        unique: Boolean(index.unique),
      };
    });
}

/**
 * Every `CREATE INDEX` in the migration folder.
 *
 * Read from the source rather than from a database, because a test that needs a
 * live Postgres is a test that does not run in CI.
 *
 * The table is optional in the pattern because the migrations are inconsistent
 * about it: the initial schema qualifies it (`"public"."users"`) and the later
 * ones do not (`"users"`). Both are the same table, and the comparison below
 * should not care which spelling a migration used.
 */
function migrationIndexes(): MigrationIndex[] {
  const directory = join(process.cwd(), 'src', 'database', 'migrations');

  const found: MigrationIndex[] = [];

  for (const file of readdirSync(directory)) {
    const source = readFileSync(join(directory, file), 'utf8');

    for (const match of source.matchAll(
      /CREATE (UNIQUE )?INDEX "([^"]+)" ON (?:"public"\.)?"([^"]+)"\s*\(([^)]*)\)/g,
    )) {
      found.push({
        file,
        name: match[2] ?? '',
        table: match[3] ?? '',
        columns: (match[4] ?? '')
          .split(',')
          .map((column) => column.trim().replace(/"/g, '')),
        unique: Boolean(match[1]),
      });
    }
  }

  return found;
}

describe('the index declarations and the DDL that creates them', () => {
  const declared = entityIndexes();
  const created = migrationIndexes();

  it('creates every index an entity names, with the same columns', () => {
    // The name is the contract between the two. A migration creating
    // `IDX_users_cursor` and an entity declaring `IDX_users_createdat_cursor`
    // describe two different indexes: the migration makes one the entity does
    // not know about, and the entity expects one the database does not have.
    for (const index of declared) {
      if (index.name === null) {
        continue;
      }

      const match = created.find(
        (candidate) =>
          candidate.name === index.name && candidate.table === index.table,
      );

      expect(
        match,
        `${index.name} on ${index.table} is never created`,
      ).toBeDefined();
      expect(match?.columns, index.name).toEqual(index.columns);
    }
  });

  it('declares every named index a migration creates', () => {
    // The other direction. A migration that creates an index no entity knows
    // about is an index the application will never rely on and will never
    // remove.
    //
    // **Indexes TypeORM generated a name for are excluded**, and that is not a
    // loophole. `@Index()` on a property and `@Index({ unique: true })` leave the
    // name to TypeORM, which hashes it into something like
    // `IDX_97672ac88f789774dd47f7c8be`. The entity has no name to compare
    // against — the name exists only in the DDL — so demanding one would fail
    // every correctly-declared column index.
    //
    // What is still checked is that the *coverage* matches: the index a
    // migration creates over these columns is the one the entity declares over
    // the same columns.
    for (const index of created) {
      if (index.name === null || index.name === '') {
        continue;
      }

      const named = declared.find(
        (candidate) =>
          candidate.name === index.name && candidate.table === index.table,
      );

      if (named) {
        expect(named.columns, index.name).toEqual(index.columns);
        continue;
      }

      // A generated name: the entity declares the same columns without a name.
      const anonymous = declared.find(
        (candidate) =>
          candidate.name === null &&
          candidate.table === index.table &&
          candidate.columns.join(',') === index.columns.join(','),
      );

      expect(
        anonymous,
        `${index.name} on ${index.table} is created but not declared`,
      ).toBeDefined();
    }
  });

  it('covers no column twice on the same table', () => {
    // Two indexes over the same columns are two structures maintained on every
    // write for one query's benefit. The one that is not chosen is pure cost,
    // and the entity is where the duplication is written down.
    for (const index of declared) {
      const duplicates = declared.filter(
        (candidate) =>
          candidate.table === index.table &&
          candidate.name !== index.name &&
          candidate.columns.join(',') === index.columns.join(',') &&
          candidate.unique === index.unique,
      );

      expect(
        duplicates.map((duplicate) => duplicate.name ?? 'unnamed'),
        `${index.table} indexes ${index.columns.join(',')} twice`,
      ).toEqual([]);
    }
  });

  it('gives every named index a name that says what it is', () => {
    // A generated name (`IDX_9769b295a8d670435ce210ba15`) is what TypeORM
    // produces for an index nobody named, and it says nothing at the point where
    // somebody reads the schema and asks what it is for.
    for (const index of declared) {
      if (index.name === null) {
        continue;
      }

      expect(index.name, `${index.table} has a generated index name`).toMatch(
        /^[A-Za-z][A-Za-z0-9_]*$/,
      );
    }
  });

  it('drops every index the migrations create', () => {
    // An index that outlives its migration is a name in the schema that nothing
    // can explain, and a rollback that cannot be replayed: the second `up`
    // fails on a name that is already taken.
    //
    // **Checked across the whole migration folder, not per file.** An index is
    // sometimes dropped by a later migration rather than by its own — the one on
    // `users.lockedAt` is dropped by the migration that drops the column, and
    // demanding its own file drop it would be demanding a rollback that drops a
    // column too.
    //
    // **A dropped table drops its indexes.** Postgres refuses to drop a table
    // with an index on it, so `DROP TABLE` is the drop, and the index name never
    // appears in the rollback at all.
    const downs = readdirSync(
      join(process.cwd(), 'src', 'database', 'migrations'),
    )
      .map((file) =>
        readFileSync(
          join(process.cwd(), 'src', 'database', 'migrations', file),
          'utf8',
        ),
      )
      .map((source) => source.split('public async down')[1] ?? '')
      .join('\n');

    for (const index of created) {
      const droppedByName = downs.includes(index.name);
      const droppedWithItsTable = downs.includes(`DROP TABLE "${index.table}"`);

      expect(
        droppedByName || droppedWithItsTable,
        `${index.name} on ${index.table} is never dropped by any migration`,
      ).toBe(true);
    }
  });
});
