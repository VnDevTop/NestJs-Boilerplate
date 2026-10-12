import { createRequire } from 'node:module';

/**
 * The version this build is, for a release tag.
 *
 * **`createRequire` rather than an import.** A bare `import pkg from
 * '../../package.json'` needs `resolveJsonModule` and drags a JSON file through
 * the build for one string. Reading it through the CJS resolver gets the same
 * value with no compiler setting and no emitted asset.
 *
 * Falls back rather than throwing. A missing `package.json` — a bundled
 * artifact, a test run from a temporary directory — must not stop the
 * application booting over a version string used only for grouping errors.
 */
export function appVersion(): string {
  try {
    const require = createRequire(import.meta.url);

    return (
      (require('../../../package.json') as { version?: string }).version ??
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}
