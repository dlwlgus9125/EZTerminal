import { defineConfig } from '@playwright/test';

// The in-app browser with the real AIs (scripts/live/in-app-browser-live.spec.ts). Never part of `pnpm e2e`: it spends
// real model calls, and runs only with EZTERMINAL_LIVE_BROWSER=1.
export default defineConfig({
  testDir: './scripts/live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3 * 60 * 60_000,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
});
