import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';
import { buildFixtureState, startFakeGateway, writeFakeCliShim, writeFixtureFiles } from './fixtures/openclaw-fixtures';

// openclaw-stabilization M2: the tri-state `openclawMode` ('auto'|'on'|'off')
// setting that gates ALL desktop OpenClaw UI (App.tsx's btn-toggle-openclaw
// header button + drawer + chat panel — see App.tsx's `openclawVisible` state
// and main.ts's resolveOpenClawVisibility/applyOpenClawVisibility). Distinct
// from openclaw-panel.spec.ts/openclaw-chat.spec.ts, which drive the drawer's
// OWN content once it's already visible — this spec is purely about whether
// the UI exists AT ALL, seeded/toggled via the SettingsPanel "OpenClaw"
// radios (settings-openclaw-mode-auto/-on/-off). Reuses the same fake CLI
// shim/gateway fixtures (fixtures/openclaw-fixtures.ts) so the real gateway
// that may be running on this machine at 127.0.0.1:18789 is never dialed.

const SCREENSHOT_DIR = path.join(
  process.env.TEMP ?? process.env.TMP ?? '.',
  'claude',
  'ezterminal-openclaw-panel-screenshots',
);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function seedSettings(dir: string, openclawMode: 'auto' | 'on' | 'off'): void {
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, openclawMode }),
    'utf8',
  );
}

test('mode off hides all OpenClaw UI, even with the CLI installed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-visibility-off-e2e-'));
  seedSettings(dir, 'off');
  // isInstalled() is PATH resolution only (openclaw-service.ts) — a fake CLI
  // shim here proves 'off' wins even when the CLI IS installed, not just
  // coincidentally hidden because nothing resolved.
  const cliShim = writeFakeCliShim(dir);

  const app = await launchApp(dir, { EZTERMINAL_OPENCLAW_CLI: cliShim });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    // App.tsx's `openclawVisible` state starts optimistically `true` until the
    // first getOpenClawVisibility() round trip resolves — poll (not a fixed
    // sleep) so a flash-then-hide isn't mistaken for a failure.
    await expect(window.getByTestId('btn-toggle-openclaw')).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('mode on shows OpenClaw UI even when the CLI is absent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-visibility-on-e2e-'));
  seedSettings(dir, 'on');

  const app = await launchApp(dir, {
    // An absolute path resolving to nothing — CommandResolver treats an
    // absolute name as a direct probe (no PATH search), so this
    // deterministically reports "not installed" regardless of what's on this
    // machine's PATH (same trick as openclaw-panel.spec.ts's CLI-absent test).
    EZTERMINAL_OPENCLAW_CLI: path.join(SCREENSHOT_DIR, `does-not-exist-${Date.now()}.cmd`),
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await expect(window.getByTestId('btn-toggle-openclaw')).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('auto mode shows UI with the CLI present; a runtime toggle to off rips the UI out, and back to on restores it', async () => {
  const state = buildFixtureState({ running: true });
  const { dir: fixtureDir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(fixtureDir);
  const gateway = await startFakeGateway(statePath);

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-visibility-auto-e2e-'));
  seedSettings(userDataDir, 'auto');

  const app = await launchApp(userDataDir, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    const openclawBtn = window.getByTestId('btn-toggle-openclaw');
    await expect(openclawBtn).toBeVisible({ timeout: 10_000 });
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'openclaw-visibility-header-on.png') });

    // Open the drawer, then Settings — the right-edge slot is shared/mutually
    // exclusive (App.tsx), so opening Settings auto-closes the drawer; that's
    // expected, not something this test asserts against.
    await openclawBtn.click();
    await expect(window.getByTestId('openclaw-panel')).toBeVisible();

    await window.getByTestId('btn-toggle-settings').click();
    await expect(window.getByTestId('settings-panel')).toBeVisible();
    await expect(window.getByTestId('openclaw-panel')).toHaveCount(0);

    const autoRadio = window.getByTestId('settings-openclaw-mode-auto');
    await expect(autoRadio).toBeChecked({ timeout: 10_000 });
    await autoRadio.scrollIntoViewIfNeeded();
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'openclaw-visibility-settings-section.png') });

    // A plain click, not locator.check(): SettingsPanel's radio handler
    // updates local state optimistically (same click before setOpenClawMode()'s
    // IPC round trip actually lands), so the DOM flips synchronously.
    const offRadio = window.getByTestId('settings-openclaw-mode-off');
    await offRadio.click();
    await expect(offRadio).toBeChecked();
    await expect(openclawBtn).toHaveCount(0, { timeout: 10_000 });

    // Close Settings for a clean header-only shot symmetric to header-on.
    await window.getByTestId('btn-toggle-settings').click();
    await expect(window.getByTestId('settings-panel')).toHaveCount(0);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'openclaw-visibility-header-off.png') });

    // Flip back to on -> the button reappears. Settings unmounts/remounts on
    // each toggle (App.tsx: `{settingsOpen && <SettingsPanel .../>}`), so its
    // openclawMode local state re-fetches via IPC — wait for the radio to
    // actually render before clicking it.
    await window.getByTestId('btn-toggle-settings').click();
    const onRadio = window.getByTestId('settings-openclaw-mode-on');
    await expect(onRadio).toBeVisible({ timeout: 10_000 });
    await onRadio.click();
    await expect(openclawBtn).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    await gateway.stop();
  }
});
