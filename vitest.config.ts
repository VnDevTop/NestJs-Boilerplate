import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // `*.e2e-spec.ts` ends with `.spec.ts`, so an include without this exclude
    // makes the unit job boot the whole application against a real database.
    // The failure looks like a slow unit test, not like a missing service.
    include: ['**/*.spec.ts'],
    exclude: [
      '**/*.e2e-spec.ts',
      '**/node_modules/**',
      'dist/**',
      'coverage/**',
    ],
  },
});
