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
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // One retry: the `gen-rows 100000000` cancel test is timing-sensitive under the
  // 100M-row stress (Playwright actionability can time out when the DOM churns
  // hard), so it occasionally needs a second attempt. The behavior under test is
  // correct — this keeps the suite deterministic rather than masking a real bug.
  retries: configuredRetries(1),
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
});
