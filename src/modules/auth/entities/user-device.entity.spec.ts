import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { UserDevice } from './user-device.entity.js';

function columns() {
  const storage = getMetadataArgsStorage();

  return (storage.columns ?? []).filter(
    (column) => column.target === UserDevice,
  );
}

function indices() {
  return getMetadataArgsStorage().indices.filter(
    (index) => index.target === UserDevice,
  );
}

/**
 * The columns an index covers, or undefined when the index is not the one asked
 * for.
 *
 * `columns` on a decorator index is `string[]` or a function producing one,
 * depending on the metadata kind, so it is narrowed rather than assumed. Reading
 * it as an array without the narrowing is a type error, which is the type system
 * doing what the comment in `token.entities.spec.ts` describes.
 */
function indexColumns(name: string): string[] | undefined {
  const index = indices().find((entry) => entry.name === name);
  const columns = index?.columns;

  return Array.isArray(columns) ? columns.map(String) : undefined;
}

function indexByName(name: string) {
  return indices().find((index) => index.name === name);
}

const CURSOR_INDEX = 'IDX_user_devices_user_active_cursor';
const OWNER_INDEX = 'IDX_user_devices_user_active';

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

describe('the user_devices table', () => {
  it('records who the device belongs to', () => {
    const names = columns().map((column) => column.propertyName);

    expect(names).toContain('userId');
  });

  it('carries the active flag, because a revoked device is not listed', () => {
    // `GET /auth/devices` lists active devices only, and the flag is also what
    // "sign out this machine" writes.
    const isActive = columns().find(
      (column) => column.propertyName === 'isActive',
    );

    expect(isActive?.options.type).toBe('boolean');
    expect(isActive?.options.nullable).not.toBe(true);
  });
});

describe('indexing for cursor paging', () => {
  it('carries the keyset index the device list pages on', () => {
    expect(indexColumns(CURSOR_INDEX)).toEqual([
      'userId',
      'isActive',
      'createdAt',
      'id',
    ]);
  });

  it('leads with the equality columns, so the index can seek rather than filter', () => {
    // `userId = ?` and `isActive = true` are constants in that query. With the
    // sort columns first the index could not seek at all, and the composite would
    // be worse than the plain two-column index it sits beside.
    const columnsOf = indexColumns(CURSOR_INDEX);

    expect(columnsOf?.slice(0, 2)).toEqual(['userId', 'isActive']);
    expect(columnsOf?.slice(-2)).toEqual(['createdAt', 'id']);
  });

  it('keeps the two-column index, because the revoke path does not sort', () => {
    // `IDX_user_devices_user_active` still serves the write that deactivates
    // every device of a user. Replacing it with the keyset one would make that
    // write a range scan for nothing.
    expect(indexColumns(OWNER_INDEX)).toEqual(['userId', 'isActive']);
  });

  it('is not unique, because it is a range scan and not a lookup', () => {
    expect(indexByName(CURSOR_INDEX)?.unique).toBe(false);
  });

  it('sorts on a column that is never null', () => {
    // A cursor carries its boundary as a string, so a nullable sort column
    // cannot be the one the boundary is read from.
    const createdAt = columns().find(
      (column) => column.propertyName === 'createdAt',
    );

    expect(createdAt?.options.nullable).not.toBe(true);
  });
});

describe('the cursor index migration', () => {
  it('creates the index the entity declares, by the same name', () => {
    expect(cursorMigration).toContain(
      `CREATE INDEX "${CURSOR_INDEX}" ON "user_devices" ("userId", "isActive", "createdAt", "id")`,
    );
  });

  it('drops the index in down, so the migration is reversible', () => {
    expect(cursorMigration).toContain(`DROP INDEX "public"."${CURSOR_INDEX}"`);
  });

  it('creates no table, because it only indexes what already exists', () => {
    expect(cursorMigration).not.toMatch(/CREATE TABLE/);
  });
});
