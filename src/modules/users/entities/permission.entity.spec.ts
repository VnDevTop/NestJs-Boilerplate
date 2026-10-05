import { getMetadataArgsStorage } from 'typeorm';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Permission, RolePermission } from './index.js';

function columns(target: typeof Permission | typeof RolePermission) {
  const storage = getMetadataArgsStorage();

  return storage.columns.filter((column) => column.target === target);
}

function columnNames(
  target: typeof Permission | typeof RolePermission,
): string[] {
  return columns(target).map((column) => column.propertyName);
}

function relations(target: typeof Permission | typeof RolePermission) {
  return getMetadataArgsStorage().relations.filter(
    (relation) => relation.target === target,
  );
}

/**
 * `@Index({ unique: true })` lands in the indices list under a flattened
 * `unique` field, not in the uniques list and not nested under `options`.
 * Reading the wrong one makes the assertion vacuous, because the property is
 * simply absent and the filter matches nothing.
 */
function uniqueIndexes(target: typeof Permission | typeof RolePermission) {
  return getMetadataArgsStorage().indices.filter(
    (index) => index.target === target && index.unique,
  );
}

const migration = readFileSync(
  join(
    process.cwd(),
    'src',
    'database',
    'migrations',
    '1791137310008-AddPermissions.ts',
  ),
  'utf8',
);

describe('the permissions table', () => {
  it('keys on a name, because that is what a guard compares against', () => {
    expect(columnNames(Permission)).toContain('name');
  });

  it('makes the name unique', () => {
    // A duplicate name would give a guard two rows to reason about and an
    // operator two identical entries in a role editor.
    expect(uniqueIndexes(Permission).map((index) => index.columns)).toEqual([
      ['name'],
    ]);
  });

  it('defaults the description to empty rather than null', () => {
    const description = columns(Permission).find(
      (column) => column.propertyName === 'description',
    );

    expect(description?.options.default).toBe('');
  });
});

describe('the role_permissions table', () => {
  it('stores the role as a string, because a role is a column on users', () => {
    // There is no role row. A grant joins a name to a permission, so the column
    // is the same varchar that `users.role` already holds.
    expect(columnNames(RolePermission)).toContain('role');
  });

  it('refuses the same grant twice', () => {
    expect(uniqueIndexes(RolePermission).map((index) => index.columns)).toEqual(
      [['role', 'permissionId']],
    );
  });

  it('cascades from the permission, so a removed name takes its grants with it', () => {
    // Without this, deleting a permission fails on the foreign key and becomes
    // undeletable, which is how a catalogue rots.
    const permission = relations(RolePermission).find(
      (relation) => relation.relationType === 'many-to-one',
    );

    expect(permission?.options.onDelete).toBe('CASCADE');
  });

  it('joins on permissionId rather than inventing a column', () => {
    // Asserted against the migration rather than the metadata, because a
    // relation's `joinColumns` are resolved when the metadata is built and are
    // not present on the stored arguments. The migration is also the artifact a
    // deployment runs.
    expect(migration).toMatch(
      /FOREIGN KEY \("permissionId"\) REFERENCES "permissions"\("id"\)/,
    );
  });

  it('holds no relation back to a role, because there is no role row', () => {
    // Only one many-to-one, to the permission. A second one to a Role entity
    // would need that entity to exist.
    expect(relations(RolePermission)).toHaveLength(1);
  });
});
