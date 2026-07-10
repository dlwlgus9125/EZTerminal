import { defineConfig } from 'vitest/config';

// Unit-test runner. Real tests are added in later tasks (T1+).
// `passWithNoTests` keeps `pnpm test` green while the suite is empty —
// it reports "no test files" rather than inventing fake passing tests.
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.vite/**', 'out/**', 'dist/**'],
  },
});
