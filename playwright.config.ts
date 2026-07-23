import { defineConfig } from '@playwright/test';

function configuredRetries(defaultValue: number): number {
  const raw = process.env.EZTERMINAL_PLAYWRIGHT_RETRIES;
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`EZTERMINAL_PLAYWRIGHT_RETRIES must be a non-negative integer (received ${raw})`);
  }
  return parsed;
}

// End-to-end runner. Drives the real Electron app via Playwright's Electron API.
// `globalSetup` produces the Vite build artifacts the app launches from.
export default defineConfig({
  testDir: './e2e',
  // The 5-warmup/25-sample benchmark is release evidence, not an ordinary
  // functional test. Keeping it opt-in prevents every CI/e2e invocation from
  // silently spending up to fifteen minutes without a same-host baseline.
  testIgnore: process.env.EZTERMINAL_RUN_RELEASE_PERFORMANCE === '1'
    ? []
    : ['**/release-performance.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // Release evidence must not hide intermittent process or port failures behind
  // retries. Diagnostic callers can still opt in through the environment.
  retries: configuredRetries(0),
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
});
