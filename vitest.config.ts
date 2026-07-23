import { defineConfig } from 'vitest/config';

// Unit-test runner. An unexpectedly empty suite is a release-configuration
// failure, and retries stay disabled so intermittent failures remain visible.
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    retry: 0,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.ts'],
    exclude: [
      'e2e/**',
      'node_modules/**',
      '.vite/**',
      'out/**',
      'dist/**',
      'src/**/*.os.test.{ts,tsx}',
    ],
  },
});
