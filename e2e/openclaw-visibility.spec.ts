import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRegisteredE2eTempDir, test, expect } from './test';

import { launchApp } from './launch-app';
import {
  buildFixtureState,
  startFakeGateway,
  writeFakeCliShim,
  writeFixtureFiles,
} from './fixtures/openclaw-fixtures';

function seedSettings(dir: string, openclawMode: 'auto' | 'on' | 'off'): void {
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, openclawMode }),
    'utf8',
  );
}

test('auto mode shows UI with the CLI present; a runtime toggle to off rips the UI out, and back to on restores it', async () => {
  const state = buildFixtureState({ running: true });
  const { dir: fixtureDir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(fixtureDir);
  const gateway = await startFakeGateway(statePath);
  const userDataDir = createRegisteredE2eTempDir(
    'ezterm-openclaw-visibility-auto-e2e-',
  );
  seedSettings(userDataDir, 'auto');

  const app = await launchApp(userDataDir, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    const openclawButton = window.getByTestId('btn-toggle-openclaw');
    await expect(openclawButton).toBeVisible({ timeout: 10_000 });

    await openclawButton.click();
    await expect(window.getByTestId('openclaw-panel')).toBeVisible();
    await window.getByTestId('btn-toggle-settings').click();
    await expect(window.getByTestId('settings-panel')).toBeVisible();
    await window.getByTestId('settings-category-integrations').click();
    await expect(window.getByTestId('openclaw-panel')).toHaveCount(0);

    await expect(window.getByTestId('settings-openclaw-mode-auto')).toBeChecked({ timeout: 10_000 });
    const offRadio = window.getByTestId('settings-openclaw-mode-off');
    await offRadio.click();
    await expect(offRadio).toBeChecked();
    await expect(openclawButton).toHaveCount(0, { timeout: 10_000 });

    await window.getByTestId('btn-toggle-settings').click();
    await expect(window.getByTestId('settings-panel')).toHaveCount(0);
    await window.getByTestId('btn-toggle-settings').click();
    await window.getByTestId('settings-category-integrations').click();
    const onRadio = window.getByTestId('settings-openclaw-mode-on');
    await expect(onRadio).toBeVisible({ timeout: 10_000 });
    await onRadio.click();
    await expect(openclawButton).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    await gateway.stop();
  }
});
