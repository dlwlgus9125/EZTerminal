import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// v0.2.0 M6: the Settings drawer (D5) — UI scale stepper + remote toggle,
// sharing the stats/pairing right-slot mutual exclusion. UI scale is
// exercised here directly against the drawer; it persists to settings.json
// (layout-store.ts's setUiScale) and must survive a relaunch against the
// SAME userData dir. Theme switching is not part of this drawer (removed in
// M8 as a duplicate of the header cycle button) — see theme.spec.ts.

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-settings-e2e-'));
}

test('settings drawer: UI scale stepper applies live and persists across relaunch', async () => {
  const dir = tempUserData();

  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  await expect(w1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await w1.getByTestId('btn-toggle-settings').click();
  await expect(w1.getByTestId('settings-panel')).toBeVisible();

  // UI scale: 100% -> 110% -> 120%. Product chrome uses the canonical 16px
  // semantic-token root, so the theme-independent result is 16px * 1.2 = 19.2px.
  await w1.getByTestId('settings-scale-inc').click();
  await expect(w1.getByTestId('settings-scale-value')).toHaveText('110%');
  await w1.getByTestId('settings-scale-inc').click();
  await expect(w1.getByTestId('settings-scale-value')).toHaveText('120%');
  await expect
    .poll(() => w1.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .toBe('19.2px');

  await app1.close();

  // Relaunch against the SAME userData dir — the choice must survive.
  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect
    .poll(() => w2.evaluate(() => getComputedStyle(document.documentElement).fontSize), {
      timeout: 15_000,
    })
    .toBe('19.2px');
  await app2.close();
});

test('settings drawer: mutually exclusive with the stats panel (shared right-slot drawer)', async () => {
  const app = await launchApp();
  const w = await app.firstWindow();
  await expect(w.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await w.getByTestId('btn-toggle-settings').click();
  await expect(w.getByTestId('settings-panel')).toBeVisible();

  await w.getByTestId('btn-toggle-stats').click();
  await expect(w.getByTestId('status-panel')).toBeVisible();
  await expect(w.getByTestId('settings-panel')).toHaveCount(0);

  await app.close();
});

test('terminal paste warnings default on and persist independently', async () => {
  const dir = tempUserData();
  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  await expect(w1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await w1.getByTestId('btn-toggle-settings').click();
  await w1.getByTestId('settings-category-terminal').click();
  const multiline = w1.getByTestId('settings-warn-multiline-paste');
  const large = w1.getByTestId('settings-warn-large-paste');
  await expect(multiline).toBeChecked();
  await expect(large).toBeChecked();
  await multiline.click();
  await expect(multiline).not.toBeChecked();
  await app1.close();

  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect(w2.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await w2.getByTestId('btn-toggle-settings').click();
  await w2.getByTestId('settings-category-terminal').click();
  await expect(w2.getByTestId('settings-warn-multiline-paste')).not.toBeChecked();
  await expect(w2.getByTestId('settings-warn-large-paste')).toBeChecked();
  await app2.close();
});
