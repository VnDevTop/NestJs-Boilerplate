import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Stands in for the invalidation subscriber Phase 17b planned, and explains the
 * substitution.
 *
 * The plan wanted a TypeORM subscriber in `src/database/subscribers/`, on the
 * reasoning that invalidating from one place "cannot be forgotten in one of them".
 * Two things rule it out, both checked against the installed TypeORM rather than
 * assumed:
 *
 * **A subscriber gets no dependency injection.** `ConnectionMetadataBuilder`
 * instantiates them with `new metadata.target()`, so there is no constructor
 * argument available. `CacheService` is reachable only through a module-level
 * singleton or a second redis client, and a second client would have to reproduce
 * the key derivation that `CacheService` owns — which is the drift the key module
 * exists to prevent.
 *
 * **It could not identify the row anyway.** `UpdateQueryBuilder` passes
 * `valuesSet` as the event entity, so `repository.update()` and `increment()`
 * deliver `{ sessionsVersion: 1 }` with no id, and `DeleteQueryBuilder` passes no
 * entity at all. Every write that matters here is a query-builder write. The
 * subscriber would fire on all of them and be able to act on none.
 *
 * What replaces it is this guard plus the explicit calls it points at: a write to
 * a revocation-critical column can only appear in a file that also invalidates,
 * so adding a third bump site fails the build instead of silently weakening
 * logout-everywhere.
 */

/** The project root, so the paths below read the way the allowlist writes them. */
const SRC = new URL('../../..', import.meta.url).pathname;

/** Directories that never hold business logic worth scanning. */
const SKIP = new Set(['migrations', 'entities', 'dto', 'interfaces', 'seeds']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return SKIP.has(entry) ? [] : walk(full);
    }

    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/**
 * Where a revocation-critical column may be written, and how each place has to
 * drop the cache entry.
 *
 * The second half is the point. Adding a file here is a decision to take
 * responsibility for invalidation, and forgetting the invalidation makes the test
 * fail rather than leaving a stale claim set in force until it expires.
 */
const ALLOWED: Record<string, RegExp> = {
  // The account-wide counter: logout-everywhere and a password change.
  'src/modules/auth/auth.service.ts': /runThenInvalidateAuthCache/,
  'src/modules/auth/password-reset.service.ts': /invalidateAuthCache/,
  // The per-device counter: signing out of one browser, and revoking a device.
  'src/modules/auth/device.service.ts': /invalidateAuthCache/,
};

/**
 * Every file naming the column, ignoring the migrations that created it.
 *
 * The literal is what identifies a write, because it is the only form both an
 * `increment` and a partial-object write take. A read names the column as a
 * property, not as a string.
 */
function writers(): string[] {
  return walk(SRC)
    .filter((file) => {
      const source = readFileSync(file, 'utf8');

      return (
        (source.includes("'sessionsVersion'") ||
          source.includes('"sessionsVersion"')) &&
        !source.includes('ALTER TABLE') &&
        !source.includes('DROP COLUMN')
      );
    })
    .map((file) => relative(SRC, file))
    .sort();
}

describe('a sessions version counter', () => {
  it('is written only in files that also invalidate the cache', () => {
    // Every other place to write it is a way of making a logout ineffective for
    // the length of the entry, which is why the list is closed rather than
    // documented.
    expect(writers()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('covers both counters, so a new one cannot be added quietly', () => {
    // The account counter kills every device; the device counter kills one. Both
    // are revocation, both have to invalidate, so the guard watches for the column
    // wherever it appears rather than for one entity in particular.
    expect(writers()).toContain('src/modules/auth/device.service.ts');
  });

  it('is only ever incremented by one, never set to a fixed value', () => {
    // A fixed value lets a token minted between two logouts keep working: both
    // bumps produce the same number, so a comparison cannot tell them apart.
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(join(SRC, file), 'utf8');
      const bumps =
        source.match(
          /increment\([\s\S]{0,120}?'sessionsVersion'\s*,\s*([\s\S]{0,20}?)\)/g,
        ) ?? [];

      expect(bumps).not.toHaveLength(0);

      for (const bump of bumps) {
        expect(bump).toMatch(/,\s*1\s*,?\s*\)$/);
      }
    }
  });

  it('is invalidated by each of those files today', () => {
    // A guard that lists a file without checking its invalidation would document
    // the rule and not enforce it.
    for (const [file, pattern] of Object.entries(ALLOWED)) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(pattern);
    }
  });
});
