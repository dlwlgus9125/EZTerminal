import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

import {
  currentOwnedDesktopProfileRegistry,
  trackElectronApplicationClose,
} from './owned-desktop-profile';

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
/**
 * Turn the boot sequence off for every harness launch.
 *
 * It defaults on and covers the workbench for roughly three seconds, which
 * would add that to each of the ~40 specs and hide the controls they click
 * first. Specs that deliberately share a userData dir call this on a directory
 * that may already hold settings, so the existing file is merged rather than
 * replaced — clobbering it would wipe the state a restart-restore test just
 * saved. A spec that wants the intro can set the flag back afterwards.
 */
function disableBootIntro(dir: string): void {
  const file = path.join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
    } catch {
      // A corrupt settings file is the app's problem to quarantine, not ours to
      // repair; fall through and write a minimal one.
      settings = {};
    }
  }
  // Only fill in the default. An explicit value — including `true` — is a
  // spec deliberately opting in, and a relaunch against a shared userData dir
  // must not undo what the previous launch persisted.
  if ('bootIntro' in settings) return;
  // schemaVersion and startup are the two required fields of SettingsSchema.
  // Without them the file fails validation, the store quarantines it to
  // settings.json.corrupt, and the flag is silently lost — which reinstates the
  // very overlay this is here to suppress.
  writeFileSync(
    file,
    JSON.stringify(
      { schemaVersion: 1, startup: { mode: 'last' }, ...settings, bootIntro: false },
      null,
      2,
    ),
    'utf8',
  );
}

export async function launchApp(
  userDataDir?: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  const registry = currentOwnedDesktopProfileRegistry();
  const dir = userDataDir ?? registry.createTempDir('ezterm-e2e-');
  const lease = registry.reserve(dir);
  let launchedApp: ElectronApplication | undefined;
  let appCloser: ReturnType<typeof trackElectronApplicationClose> | undefined;
  try {
    disableBootIntro(dir);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.EZTERMINAL_USER_DATA_DIR = dir;
    // Production is single-instance. Playwright intentionally launches many
    // isolated app instances, so the harness must opt out explicitly.
    env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES = '1';
    Object.assign(env, extraEnv);
    // The broad legacy E2E suite asserts English copy. Keep its browser locale
    // deterministic across developer and CI machines; locale-specific product
    // behavior is covered separately by i18n, Storybook, and visual contracts.
    launchedApp = await electron.launch({ args: [MAIN_ENTRY, '--lang=en-US'], env });
    appCloser = trackElectronApplicationClose(launchedApp);
    lease.settle(appCloser);
    return launchedApp;
  } catch (error) {
    lease.settle(appCloser ?? launchedApp);
    // The auto fixture owns the global close-then-remove barrier. Cleaning one
    // profile here could race another pending launch or remove directories
    // while an unrelated resource remains live.
    throw error;
  }
}
