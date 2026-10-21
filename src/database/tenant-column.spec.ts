import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TENANT_ID } from '../common/tenancy/tenant.constants.js';
import { ENTITIES } from './data-source.js';

/**
 * The tenant column, on every table.
 *
 * **The property is the point, not the column.** A table that does not carry
 * it is a table that has to be migrated the first time a customer arrives, and
 * that is the expensive change this phase exists to avoid.
 */
describe('the tenant column', () => {
  const entities = ENTITIES.filter(
    (entity) => typeof entity === 'function',
  ) as Array<new () => unknown>;

  it('is on every entity', () => {
    const without = entities.filter((entity) => !hasTenantColumn(entity));

    // Named rather than counted, because a count would not say which table was
    // missed.
    expect(without.map((entity) => entity.name)).toEqual([]);
  });

  it('defaults to the fixed default tenant, so a row written before the feature is on still belongs to the tenant the application looks for', () => {
    for (const entity of entities) {
      const column = getMetadataArgsStorage().columns.find(
        (candidate) =>
          candidate.target === entity && candidate.propertyName === 'tenantId',
      );

      expect(column?.options.default, entity.name).toBe(DEFAULT_TENANT_ID);
    }
  });

  it('is not nullable, because a row with no tenant belongs to nobody', () => {
    for (const entity of entities) {
      const column = getMetadataArgsStorage().columns.find(
        (candidate) =>
          candidate.target === entity && candidate.propertyName === 'tenantId',
      );

      expect(column?.options.nullable, entity.name).not.toBe(true);
    }
  });

  it('leads every index, so a tenant-scoped query is a range scan', () => {
    // The one exception is the GIN index over the search document: a GIN index
    // cannot lead with a b-tree column without the `btree_gin` extension.
    const leading = getMetadataArgsStorage().indices.filter(
      (index) =>
        Array.isArray(index.columns) &&
        index.columns.length > 0 &&
        String((index.columns as string[])[0]) !== 'tenantId' &&
        index.type !== 'gin',
    );

    expect(leading.map((index) => `${index.name ?? '(unnamed)'}`)).toEqual([]);
  });

  it('makes the natural keys composite, because an address is only unique within a tenant', () => {
    const uniques = getMetadataArgsStorage().indices.filter(
      (index) => index.unique && Array.isArray(index.columns),
    );

    for (const index of uniques) {
      const columns = index.columns as string[];

      expect(String(columns[0]), index.name ?? '').toBe('tenantId');
    }
  });
});

/** True when the entity declares the tenant column. */
function hasTenantColumn(entity: new () => unknown): boolean {
  return getMetadataArgsStorage().columns.some(
    (column) => column.target === entity && column.propertyName === 'tenantId',
  );
}

/**
 * The migration, which is where the schema actually is.
 *
 * **The entity and the migration are compared**, because `synchronize` is off
 * and a column one of them has and the other does not is a runtime error on the
 * first query that touches it.
 */
describe('the tenant migration', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      'src',
      'database',
      'migrations',
      '1792600000000-AddTenantColumn.ts',
    ),
    'utf8',
  );

  it('adds the column to every table', () => {
    const tables = [
      ...migration.matchAll(/ALTER TABLE "([^"]+)" ADD "tenantId"/g),
    ]
      .map((match) => match[1] ?? '')
      .sort();

    const expected = getMetadataArgsStorage()
      .tables.map((table) => table.name ?? '')
      .filter((name) => name !== 'migrations')
      .sort();

    expect(tables).toEqual(expected);
  });

  it('gives every row the fixed default tenant, so the backfill needs no application', () => {
    expect(migration).toContain(`DEFAULT '${DEFAULT_TENANT_ID}'`);
  });

  it('restores the previous indexes in its down, so it can be rolled back', () => {
    const down = migration.split('public async down')[1] ?? '';

    // The old indexes are back, names and predicates included, because a
    // migration that cannot be rolled back to the schema it came from is a
    // migration nobody will roll back.
    expect(down).toContain(
      'CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be"',
    );
    expect(down).toContain('CREATE INDEX "IDX_users_createdat_cursor"');
  });
});
