import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { RefreshToken } from './refresh-token.entity.js';

function columns() {
  const storage = getMetadataArgsStorage();

  return (storage.columns ?? []).filter(
    (column) => column.target === RefreshToken,
  );
}

function indices() {
  return getMetadataArgsStorage().indices.filter(
    (index) => index.target === RefreshToken,
  );
}

/**
 * The columns an index covers, or undefined when the index is not the one asked
 * for.
 *
 * `columns` on a decorator index is `string[]` or a function producing one,
 * depending on the metadata kind, so it is narrowed rather than assumed.
 */
function indexColumns(name: string): string[] | undefined {
  const index = indices().find((entry) => entry.name === name);
  const columns = index?.columns;

  return Array.isArray(columns) ? columns.map(String) : undefined;
}

function indexByName(name: string) {
  return indices().find((index) => index.name === name);
}

const CURSOR_INDEX = 'IDX_refresh_tokens_user_created_cursor';
const REVOKE_INDEX = 'IDX_refresh_tokens_user_revoked';
const AGE_INDEX = 'IDX_refresh_tokens_session_started';

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

describe('the refresh_tokens table', () => {
  it('keeps the token id unique, because a duplicate would authenticate twice', () => {
    // Read off the indices rather than the columns: `@Index({ unique: true })` on
    // a column lands in the indices list with a flattened `unique` field.
    const unique = indices().filter((index) => index.unique);

    expect(unique.map((index) => index.columns)).toEqual([['tenantId', 'jti']]);
  });

  it('records the session start separately from the token creation', () => {
    // `createdAt` slides with every rotation, so it cannot answer "how old is
    // this session"; `sessionStartedAt` is carried forward and can.
    const names = columns().map((column) => column.propertyName);

    expect(names).toContain('sessionStartedAt');
    expect(names).toContain('createdAt');
  });
});

describe('indexing for cursor paging', () => {
  it('carries the keyset index the session list pages on', () => {
    expect(indexColumns(CURSOR_INDEX)).toEqual(['userId', 'createdAt', 'id']);
  });

  it('leads with the owner, so the index seeks to one user', () => {
    // `userId = ?` is a constant in that query, and the sort columns follow so
    // postgres can walk that user's rows in order rather than filter the table.
    const columnsOf = indexColumns(CURSOR_INDEX);

    expect(columnsOf?.[0]).toBe('userId');
    expect(columnsOf?.slice(-2)).toEqual(['createdAt', 'id']);
  });

  it('is not unique, because it is a range scan and not a lookup', () => {
    expect(indexByName(CURSOR_INDEX)?.unique).toBe(false);
  });

  it('keeps the revocation index, because that write does not sort', () => {
    // "Revoke every session of this user" is an equality on `userId` and a
    // filter on `revokedAt`, and the keyset index cannot serve it.
    expect(indexColumns(REVOKE_INDEX)).toEqual(['userId', 'revokedAt']);
  });

  it('keeps the session-age index, because that question is asked by column', () => {
    // "Which sessions of this user have outlived the limit" is an indexed
    // comparison on `sessionStartedAt`, and it is not the session list's sort.
    expect(indexColumns(AGE_INDEX)).toEqual(['userId', 'sessionStartedAt']);
  });

  it('sorts on a column that is never null', () => {
    const createdAt = columns().find(
      (column) => column.propertyName === 'createdAt',
    );

    expect(createdAt?.options.nullable).not.toBe(true);
  });
});

describe('the cursor index migration', () => {
  it('creates the index the entity declares, by the same name', () => {
    expect(cursorMigration).toContain(
      `CREATE INDEX "${CURSOR_INDEX}" ON "refresh_tokens" ("userId", "createdAt", "id")`,
    );
  });

  it('drops the index in down, so the migration is reversible', () => {
    expect(cursorMigration).toContain(`DROP INDEX "public"."${CURSOR_INDEX}"`);
  });

  it('creates no table, because it only indexes what already exists', () => {
    expect(cursorMigration).not.toMatch(/CREATE TABLE/);
  });
});
