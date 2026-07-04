import { defineConfig } from '@playwright/test';

// Packaged-EXE smoke runner (ARCH-P0). Separate from `playwright.config.ts` so the
// standard `pnpm e2e` keeps launching the fast unpacked build, while
// `pnpm test:e2e:packaged` builds + launches the REAL packaged app. Packaging is
// slow, so the timeout is generous and the global setup builds it once.
export default defineConfig({
  testDir: './e2e-packaged',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: 'list',
  globalSetup: './e2e-packaged/global-setup.ts',
});
