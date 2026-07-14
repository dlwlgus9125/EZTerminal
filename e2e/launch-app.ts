import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const MAIN_ENTRY = path.resolve(__dirname, '..', '.vite', 'build', 'main.js');

/**
 * Launch the unpacked app with an ISOLATED temp userData dir. Layout
 * persistence (Track A ③) restores the last saved layout on startup — without
 * per-launch isolation, one test's splits/tabs would leak into every later
 * test (and across runs) via the shared real userData.
 *
 * Pass `userDataDir` to deliberately SHARE state across relaunches — the
 * layout-persistence restart-restore tests do exactly that.
 *
 * `extraEnv` overrides/adds env vars for this launch — e.g. session-mirror.spec.ts
 * sets `EZTERMINAL_REMOTE_PORT` to a dedicated test port so it never binds the
 * same port a real, already-running desktop instance would use.
 */
export function launchApp(
  userDataDir?: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  const dir = userDataDir ?? mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.EZTERMINAL_USER_DATA_DIR = dir;
  Object.assign(env, extraEnv);
  // The broad legacy E2E suite asserts English copy. Keep its browser locale
  // deterministic across developer and CI machines; locale-specific product
  // behavior is covered separately by i18n, Storybook, and visual contracts.
  return electron.launch({ args: [MAIN_ENTRY, '--lang=en-US'], env });
}
