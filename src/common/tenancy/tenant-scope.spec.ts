import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { setTenantScope, TENANT_SETTING } from './tenant-scope.js';

/**
 * The policy, and the setting it reads.
 *
 * **The two have to agree.** A policy reading a setting nobody sets matches
 * nothing — safe, and useless — and a setting nobody reads is a tenant that is
 * not enforced. So the migration and the application are compared here rather
 * than trusted.
 */
const migration = readFileSync(
  join(
    process.cwd(),
    'src',
    'database',
    'migrations',
    '1792800000000-AddRowLevelSecurity.ts',
  ),
  'utf8',
);

describe('the row-level policy', () => {
  it('reads the setting the application sets', () => {
    expect(migration).toContain(`current_setting('${TENANT_SETTING}', true)`);
  });

  it('is on every table that carries a tenant', () => {
    const tables = [
      ...migration.matchAll(/CREATE POLICY "tenant_isolation" ON "([^"]+)"/g),
    ].map((match) => match[1] ?? '');

    // Seventeen tables, and the count is the point: a table with a policy on
    // every other table is a table nobody thought about.
    expect(tables).toHaveLength(17);
  });

  it('is enforced, not merely enabled', () => {
    // Without FORCE the table owner bypasses the policy, and the application
    // connects as the owner.
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('has a WITH CHECK, so an insert cannot write into another tenant', () => {
    expect(migration).toContain('WITH CHECK');
  });

  it('gives the application a role that is not a superuser', () => {
    // A superuser bypasses every policy, which would make the policies
    // decoration.
    expect(migration).toContain('NOSUPERUSER');
  });
});

describe('setting the tenant', () => {
  it('sets it locally, so it ends with the transaction', () => {
    const query = vi.fn().mockResolvedValue([]);

    void setTenantScope({ query } as never, 'tenant-1');

    // A plain SET would last for the whole session, and a pooled connection
    // hands that session to the next request.
    expect(query).toHaveBeenCalledWith(
      `SELECT set_config('${TENANT_SETTING}', $1, true)`,
      ['tenant-1'],
    );
  });
});
