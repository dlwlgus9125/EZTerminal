import { test as base } from '@playwright/test';

import {
  activateOwnedDesktopProfileRegistry,
  type AsyncCloser,
  currentOwnedDesktopProfileRegistry,
  OwnedDesktopProfileRegistry,
} from './owned-desktop-profile';

export { _electron, expect } from '@playwright/test';
export type {
  ElectronApplication,
  Locator,
  Page,
} from '@playwright/test';

interface DesktopProfileFixtures {
  readonly _ownedDesktopProfiles: void;
}

/**
 * Root E2E test with automatic ownership of every launchApp profile.
 *
 * Test-scoped fixture teardown runs after public afterEach hooks even when the
 * test assertion fails or times out. Cleanup errors are intentionally allowed
 * to fail the test instead of being downgraded to best-effort diagnostics.
 */
export const test = base.extend<DesktopProfileFixtures>({
  _ownedDesktopProfiles: [async ({ browserName }, use) => {
    void browserName;
    const registry = new OwnedDesktopProfileRegistry();
    const deactivate = activateOwnedDesktopProfileRegistry(registry);
    try {
      await use();
    } finally {
      try {
        await registry.disposeAll();
      } finally {
        deactivate();
      }
    }
  }, { auto: true }],
});

/** Creates and registers one exact direct-child TEMP fixture directory. */
export function createRegisteredE2eTempDir(prefix: string): string {
  return currentOwnedDesktopProfileRegistry().createTempDir(prefix);
}

/** Registers an idempotent LIFO resource closer in the test teardown barrier. */
export function registerE2eResourceCloser(closer: AsyncCloser): AsyncCloser {
  return currentOwnedDesktopProfileRegistry().registerCloser(closer);
}
