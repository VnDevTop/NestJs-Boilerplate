import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMigrationClasses } from './global-setup.js';

/**
 * The migration list the e2e suite migrates its container with.
 *
 * This lives in the unit suite, and it is here because of how it failed. The
 * loader read `module.default` for each migration file, and this repository's
 * migrations export a *named* class, so every entry was `undefined` and TypeORM
 * failed at `buildMigrations` with "migrationClass is not a constructor" —
 * after the container had already started, which made it look like a database
 * problem rather than a one-line mistake in a test harness.
 *
 * A pure loader check costs nothing and needs no daemon, so the shape of the
 * list is verified here and the migration run itself stays in the e2e job.
 */
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/database/migrations',
);

describe('the e2e migration loader', () => {
  const migrations = loadMigrationClasses();

  it('finds one class per migration file', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((file) =>
      file.endsWith('.ts'),
    );

    // One per file, exactly. Fewer means a file exported nothing the loader
    // recognised — the silent case, where the schema comes up one table short.
    expect(migrations).toHaveLength(files.length);
  });

  it('reads every export of a migration file, not only its default', () => {
    const names = migrations.map((migration) => migration.name || 'anonymous');

    // The failure this covers: a `default` lookup returns nothing for a named
    // export, and the resulting array is `[undefined, undefined, …]`.
    for (const name of names) {
      expect(name).not.toBe('undefined');
    }

    expect(
      migrations.every((migration) => typeof migration === 'function'),
    ).toBe(true);
  });

  it('only hands TypeORM classes that implement up and down', () => {
    for (const migration of migrations) {
      expect(typeof migration.prototype.up).toBe('function');
      expect(typeof migration.prototype.down).toBe('function');
    }
  });

  it('produces names TypeORM can order, with a trailing timestamp', () => {
    // `MigrationExecutor.getMigrations` parses the last thirteen characters of the
    // class name as a timestamp and throws when there is none, so a class renamed
    // to `AddThing` would fail at migration time rather than at generate time.
    for (const migration of migrations) {
      const name = migration.name ?? migration.constructor.name;
      expect(Number.parseInt(name.slice(-13), 10)).not.toBeNaN();
    }
  });
});
