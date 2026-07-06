import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// v0.2.0 M6: the Settings drawer (D5) — theme radios + UI scale stepper +
// remote toggle, sharing the stats/pairing right-slot mutual exclusion. Theme
// selection and UI scale are exercised here directly against the drawer (as
// opposed to theme.spec.ts's header cycle button); both persist to
// settings.json (layout-store.ts's setTheme/setUiScale) and must survive a
// relaunch against the SAME userData dir.

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-settings-e2e-'));
}

test('settings drawer: theme select + UI scale stepper apply live and persist across relaunch', async () => {
  const dir = tempUserData();

  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  await expect(w1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await w1.getByTestId('btn-toggle-settings').click();
  await expect(w1.getByTestId('settings-panel')).toBeVisible();

  // Theme: selecting "light" applies data-theme immediately.
  await w1.getByTestId('settings-theme-light').check();
  await expect
    .poll(() => w1.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('light');

  // UI scale: 100% -> 110% -> 120%, root font-size = 13px * 1.2 = 15.6px.
  await w1.getByTestId('settings-scale-inc').click();
  await expect(w1.getByTestId('settings-scale-value')).toHaveText('110%');
  await w1.getByTestId('settings-scale-inc').click();
  await expect(w1.getByTestId('settings-scale-value')).toHaveText('120%');
  await expect
    .poll(() => w1.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .toBe('15.6px');

  await app1.close();

  // Relaunch against the SAME userData dir — both choices must survive.
  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect
    .poll(() => w2.evaluate(() => document.documentElement.getAttribute('data-theme')), {
      timeout: 15_000,
    })
    .toBe('light');
  await expect
    .poll(() => w2.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .toBe('15.6px');
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
