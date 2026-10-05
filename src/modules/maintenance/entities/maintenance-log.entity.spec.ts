import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { RetentionTrigger } from './retention-trigger.enum.js';
import { MaintenanceLog } from './maintenance-log.entity.js';

function columns() {
  const storage = getMetadataArgsStorage();

  return (storage.columns ?? []).filter(
    (column) => column.target === MaintenanceLog,
  );
}

function columnNames(): string[] {
  return columns().map((column) => column.propertyName);
}

describe('the maintenance_logs table', () => {
  it('records when the run started and finished separately', () => {
    // A single timestamp cannot answer "how long did it take", and the duration
    // column would have to be trusted over a number nobody can cross-check.
    expect(columnNames()).toContain('startedAt');
    expect(columnNames()).toContain('finishedAt');
  });

  it('stores the per-target detail, since the history is read for detail', () => {
    expect(columnNames()).toContain('targets');
  });

  it('stores jsonb for the detail rather than text', () => {
    // Measured: the same run is 1203 bytes as text and 728 as jsonb, because
    // jsonb drops the repeated keys five near-identical target objects repeat.
    const targets = columns().find(
      (column) => column.propertyName === 'targets',
    );

    expect(targets?.options.type).toBe('jsonb');
  });

  it('requires the detail rather than defaulting it', () => {
    // A run with no recorded targets is indistinguishable from a run that never
    // happened, and that is exactly the row an operator would trust.
    const targets = columns().find(
      (column) => column.propertyName === 'targets',
    );

    // Nullability lives on `options.nullable`, not on a top-level field. Reading
    // the wrong one leaves it undefined forever and the assertion passes no
    // matter what the column says.
    expect(targets?.options.nullable).not.toBe(true);
    expect(targets?.options.default).toBeUndefined();
  });

  it('defaults the two list columns to empty rather than null', () => {
    for (const name of ['pending', 'failedTargets']) {
      const column = columns().find((entry) => entry.propertyName === name);

      // A plain literal, not a callback returning an already-cast string.
      // TypeORM casts a string default to the column type when it normalises one,
      // so a callback returning `'[]'::jsonb` compares unequal to what the driver
      // reads back and every `migration:generate` reports phantom drift against
      // this table. That drift was found the hard way, in an unrelated migration.
      expect(column?.options.default).toBe('[]');
      expect(column?.options.nullable).not.toBe(true);
    }
  });

  it('keeps timedOut as its own column, not just inside the detail blob', () => {
    // It is the field that says the run did not finish, which decides whether
    // the tables it never reached are still unclean.
    expect(columnNames()).toContain('timedOut');
  });

  it('records who asked for the run', () => {
    expect(columnNames()).toContain('trigger');
    expect(Object.values(RetentionTrigger)).toEqual([
      'cron',
      'manual',
      'admin',
    ]);
  });

  it('defaults the trigger to cron, the only source that runs unattended', () => {
    const trigger = columns().find(
      (column) => column.propertyName === 'trigger',
    );

    expect(trigger?.options.default).toBe(RetentionTrigger.Cron);
  });
});

describe('append-only', () => {
  it('has no updatedAt, because nothing ever updates a row', () => {
    expect(columnNames()).not.toContain('updatedAt');
  });

  it('has no deletedAt, because nothing deletes a row through the application', () => {
    expect(columnNames()).not.toContain('deletedAt');
  });

  it('has no relations to anything, so it cannot cascade or be cascaded', () => {
    const storage = getMetadataArgsStorage();

    expect(
      storage.relations.filter(
        (relation) => relation.target === MaintenanceLog,
      ),
    ).toEqual([]);
  });
});

describe('indexing', () => {
  it('declares no index at all', () => {
    // Measured against the real payload: 728 bytes a row, so a year of daily
    // runs is about 260 KB and fits in memory. An index on startedAt would be
    // the only index on this table and would cost more than it saves. The
    // operator trims by hand when the row count finally matters.
    const storage = getMetadataArgsStorage();

    expect(
      storage.indices.filter((index) => index.target === MaintenanceLog),
    ).toEqual([]);
  });

  it('has no unique constraint beyond the primary key', () => {
    const storage = getMetadataArgsStorage();
    const uniques = storage.uniques
      .filter((unique) => unique.target === MaintenanceLog)
      .map((unique) => unique.columns);

    expect(uniques).toEqual([]);
  });
});

describe('the migration', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      'src',
      'database',
      'migrations',
      '1791019893220-AddMaintenanceLogs.ts',
    ),
    'utf8',
  );

  it('creates exactly one table', () => {
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it('creates no index, matching the decision above', () => {
    expect(migration).not.toMatch(/CREATE INDEX|CREATE UNIQUE INDEX/);
  });

  it('defaults the two list columns at the database level', () => {
    // So a row inserted by hand, or by a future migration, cannot leave them null.
    expect(migration).toContain(`'[]'::jsonb`);
  });

  it('drops the table in down', () => {
    expect(migration).toContain('DROP TABLE "maintenance_logs"');
  });
});
