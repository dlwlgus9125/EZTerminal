import { defineConfig } from 'vitest/config';

// Unit-test runner. An unexpectedly empty suite is a release-configuration
// failure, and retries stay disabled so intermittent failures remain visible.
export default defineConfig({
  test: {
    environment: 'node',
    // The suite mixes jsdom and child-process-heavy contracts. Bounding forks
    // keeps Windows scheduling pressure below Vitest's fixed 60s worker-RPC
    // deadline while preserving useful file-level parallelism.
    maxWorkers: 4,
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
