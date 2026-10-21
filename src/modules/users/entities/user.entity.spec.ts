import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { User } from './user.entity.js';

function columns() {
  const storage = getMetadataArgsStorage();

  return (storage.columns ?? []).filter((column) => column.target === User);
}

function indices() {
  return getMetadataArgsStorage().indices.filter(
    (index) => index.target === User,
  );
}

/**
 * The index names, rather than the whole metadata object.
 *
 * A named index is the thing a migration creates by name, so the name is the
 * contract between the two. Reading `columns` alone would pass even if the index
 * were renamed on one side and not the other, and the two would then be different
 * indexes: the migration creating one the entity does not know about, and the
 * entity declaring one the database does not have.
 */
function indexNames(): string[] {
  return indices()
    .map((index) => index.name)
    .filter((name): name is string => typeof name === 'string');
}

const CURSOR_INDEX = 'IDX_users_createdat_cursor';
/** The full-text index, whose type is GIN rather than the default b-tree. */
const SEARCH_INDEX = 'IDX_users_search_vector';

const cursorMigration = readFileSync(
  join(
    process.cwd(),
    'src',
    'database',
    'migrations',
    '1792400000000-AddCursorPaginationIndexes.ts',
  ),
  'utf8',
);

describe('the users table', () => {
  it('keeps the address unique, because two rows with one address is one login', () => {
    // Read off the indices rather than the columns: `@Index({ unique: true })` on
    // a column lands in the indices list with a flattened `unique` field, and
    // reading the wrong one makes the assertion vacuous.
    const unique = indices().filter((index) => index.unique);

    // The tenant leads, because an address is only unique *within* a tenant:
    // the second tenant must be able to have the address the first one has.
    expect(unique.map((index) => index.columns)).toEqual([
      ['tenantId', 'email'],
    ]);
  });

  it('indexes lockedAt, because "who is locked" is asked of the column', () => {
    // The question an operator asks most often is which accounts are locked, and
    // it is asked by filtering this column rather than by reading the table.
    const lockedAt = indices().find(
      (index) =>
        Array.isArray(index.columns) && index.columns.includes('lockedAt'),
    );

    expect(lockedAt).toBeDefined();
  });
});

describe('indexing for cursor paging', () => {
  it('carries the keyset pair the list route pages on', () => {
    // `GET /users` pages on `(createdAt, id)`. The id is not decoration: a
    // timestamp is not unique, and Postgres owes no ordering to equal keys, so a
    // boundary on the sort column alone would either re-read or skip the rows
    // that tie with it.
    const cursor = indices().find((index) => index.name === CURSOR_INDEX);
    const columns = cursor?.columns;

    expect(Array.isArray(columns) ? columns.map(String) : undefined).toEqual([
      'createdAt',
      'id',
    ]);
  });

  it('is not unique, because it is a range scan and not a lookup', () => {
    // A unique index over `(createdAt, id)` would be a second primary key, and
    // two rows created in the same millisecond would be refused.
    const cursor = indices().find((index) => index.name === CURSOR_INDEX);

    expect(cursor?.unique).toBe(false);
  });

  it('is the only index on the sort column, so a keyset page is one range scan', () => {
    // Two indexes leading with `createdAt` would mean the planner chooses, and
    // the one it does not choose is pure write amplification on every signup.
    const leading = indices().filter(
      (index) =>
        Array.isArray(index.columns) && index.columns[0] === 'createdAt',
    );

    expect(leading.map((index) => index.name)).toEqual([CURSOR_INDEX]);
  });

  it('sorts on a column that is never null, because a cursor cannot carry null', () => {
    // The cursor's boundary value is a string, and `null` would have to be
    // encoded as something the decoder reads as malformed. A nullable sort
    // column is therefore not sortable at all, which is a rule about the schema
    // rather than about the route.
    const createdAt = columns().find(
      (column) => column.propertyName === 'createdAt',
    );

    expect(createdAt?.options.nullable).not.toBe(true);
  });

  it('names only the indexes it means to, and leaves the others as they were', () => {
    // The locked-at lookup still carries a generated name, so the named list is
    // the three that were asked for: the cursor index, the full-text one, and
    // the unique address — which is named now, because a name that says what
    // it is is worth more than a generated one.
    expect([...indexNames()].sort()).toEqual(
      [CURSOR_INDEX, SEARCH_INDEX, 'UQ_users_email'].sort(),
    );
  });
});

describe('the cursor index migration', () => {
  it('creates the index the entity declares, by the same name', () => {
    // The name is the contract. A migration that creates `IDX_users_cursor` and
    // an entity that declares `IDX_users_createdat_cursor` describe two different
    // indexes, and nothing but this check would notice.
    expect(cursorMigration).toContain(
      `CREATE INDEX "${CURSOR_INDEX}" ON "users" ("createdAt", "id")`,
    );
  });

  it('drops the index in down, so the migration is reversible', () => {
    expect(cursorMigration).toContain(`DROP INDEX "public"."${CURSOR_INDEX}"`);
  });

  it('creates no table, because it only indexes what already exists', () => {
    expect(cursorMigration).not.toMatch(/CREATE TABLE/);
  });

  it('declares no unique index, because none of these is a lookup key', () => {
    expect(cursorMigration).not.toMatch(/CREATE UNIQUE INDEX/);
  });
});
