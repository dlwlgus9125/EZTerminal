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
 */
export function launchApp(userDataDir?: string): Promise<ElectronApplication> {
  const dir = userDataDir ?? mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.EZTERMINAL_USER_DATA_DIR = dir;
  return electron.launch({ args: [MAIN_ENTRY], env });
}
