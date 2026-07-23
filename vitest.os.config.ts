import { defineConfig } from 'vitest/config';

// Host-process integrations run serially so Windows scheduling/antivirus delays
// cannot starve them behind the parallel unit suite. Retries stay disabled.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.os.test.{ts,tsx}'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
