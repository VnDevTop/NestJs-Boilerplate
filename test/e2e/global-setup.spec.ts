import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ENV_FILE, loadMigrationClasses, planInfra } from './global-setup.js';

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

describe('the infrastructure decision', () => {
  /**
   * The matrix behind `npm run test:e2e`.
   *
   * Pure, so it is testable on a machine with no runtime — which is the machine
   * that needs it most. The `CI` row is the one worth having a test for: the same
   * missing Docker has to skip locally and fail on CI, because a CI job that
   * skipped would report success on a suite that never ran.
   */
  const run = {
    externalDatabase: 'postgresql://x/y',
    externalRedis: 'redis://localhost:6379',
  } as const;

  it('runs when a runtime answers and nothing was supplied', () => {
    expect(planInfra({ runtimeAvailable: true, ci: false })).toEqual({
      action: 'run',
    });
  });

  it('runs on an externally supplied stack without asking for a runtime at all', () => {
    // A machine that cannot install anything can still run this suite, and it is
    // a supported configuration rather than a workaround.
    expect(planInfra({ ...run, runtimeAvailable: false, ci: false })).toEqual({
      action: 'run',
    });
  });

  it('starts only what was not supplied', () => {
    expect(
      planInfra({
        externalDatabase: 'postgresql://x/y',
        runtimeAvailable: true,
        ci: false,
      }),
    ).toEqual({ action: 'run' });
  });

  it('skips locally when there is no runtime and no way to supply one', () => {
    const plan = planInfra({ runtimeAvailable: false, ci: false });

    expect(plan.action).toBe('skip');
    expect(plan).toMatchObject({ reason: 'no-runtime' });
  });

  it('fails on CI under exactly the same conditions', () => {
    const plan = planInfra({ runtimeAvailable: false, ci: true });

    expect(plan.action).toBe('fail');
  });

  it('does not ask CI to fail for a runtime it was never going to use', () => {
    // Both supplied: no container is started, so a machine with no Docker is
    // correct and must not be reported as broken.
    expect(planInfra({ ...run, runtimeAvailable: false, ci: true })).toEqual({
      action: 'run',
    });
  });

  it('honours the opt-out even where a runtime is available', () => {
    const previous = process.env.E2E_NO_CONTAINERS;
    process.env.E2E_NO_CONTAINERS = '1';

    try {
      expect(planInfra({ runtimeAvailable: true, ci: false })).toEqual({
        action: 'skip',
        reason: 'disabled',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.E2E_NO_CONTAINERS;
      } else {
        process.env.E2E_NO_CONTAINERS = previous;
      }
    }
  });

  it('names the three ways out of a missing runtime, in order', () => {
    const plan = planInfra({ runtimeAvailable: false, ci: false });

    const guidance =
      plan.action === 'skip' && 'guidance' in plan ? plan.guidance : '';

    // A start, a URL and a flag. The message is the whole output of the command
    // for the person who hits this, so "what do I do" has to be in it rather than
    // left to the error the runtime library printed.
    expect(guidance).toContain('colima');
    expect(guidance).toContain('docker compose up -d');
    expect(guidance).toContain('E2E_DATABASE_URL');
    expect(guidance).toContain('E2E_NO_CONTAINERS');
  });
});

describe('the file that switches the suite on', () => {
  /**
   * `test/.e2e-env.json` is the whole switch: `e2eEnabled()` is a check for it and
   * nothing else. It is written by the setup and gitignored, so it does not exist
   * on a fresh clone or on a CI runner, and every spec skips until a container
   * exists.
   *
   * Which makes a **stale** one dangerous. It was found the hard way: a run with
   * `E2E_NO_CONTAINERS=1` on a machine that had run the suite earlier reported
   *
   * ```text
   * [e2e] E2E_NO_CONTAINERS=1, every spec is skipped.
   *  Test Files  5 failed (5)
   *       Tests  30 skipped (30)
   * ```
   *
   * — skipped tests inside failing files, because the specs still believed the
   * suite was enabled and reached for a database nobody had started. So the setup
   * removes the file whenever it decides to skip, not only when it decides to
   * write one.
   */
  it('is removed when the setup skips, so a stale one cannot switch the suite back on', async () => {
    const { setup } = await import('./global-setup.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const previousFlag = process.env['E2E_NO_CONTAINERS'];

    // Written first, exactly as a previous run would have left it.
    mkdirSync(dirname(ENV_FILE), { recursive: true });
    writeFileSync(
      ENV_FILE,
      JSON.stringify({ DATABASE_URL: 'postgresql://stale' }),
    );

    process.env['E2E_NO_CONTAINERS'] = '1';

    try {
      await setup();

      expect(existsSync(ENV_FILE)).toBe(false);
    } finally {
      // Clean up after itself whatever happens. A file left behind here would
      // switch the e2e suite on for the next run on this machine, which is the
      // exact failure this test exists to prevent, caused by the test.
      rmSync(ENV_FILE, { force: true });

      if (previousFlag === undefined) {
        delete process.env['E2E_NO_CONTAINERS'];
      } else {
        process.env['E2E_NO_CONTAINERS'] = previousFlag;
      }
      warn.mockRestore();
    }
  });
});

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
