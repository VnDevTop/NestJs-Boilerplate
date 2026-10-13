import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'coverage/**'],
    // Starts the postgres and redis containers once for the whole run, and
    // writes the urls every spec reads before it boots the application.
    globalSetup: ['./test/e2e/global-setup.ts'],
    // The e2e suite owns real containers. Two suites booting their own
    // postgres and redis on the same machine race for ports and fail each
    // other, so these files run one at a time.
    fileParallelism: false,
    // A container plus a migration run is not fast. The default five seconds
    // would fail on a cold docker cache rather than on anything the code did.
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
