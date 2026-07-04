import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// E1: built-in themes with persistence. The theme button cycles
// dark -> light -> high-contrast -> matrix -> dark, applies immediately (data-theme
// attribute + the --term-* CSS vars actually changing), and the choice
// persists to settings.json so it survives a relaunch.

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-theme-e2e-'));
}

test('theme button applies immediately and persists across relaunch', async () => {
  const dir = tempUserData();

  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  const btn = w1.getByTestId('btn-theme');
  await expect(btn).toHaveText('Theme: dark');

  const darkBg = await w1.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
  );

  await btn.click();
  await expect(btn).toHaveText('Theme: light');
  await expect
    .poll(() => w1.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('light');

  // A CSS var actually changed under the new attribute, not just the label.
  const lightBg = await w1.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
  );
  expect(lightBg).not.toBe(darkBg);

  await app1.close();

  // Relaunch with the SAME userData dir — the persisted choice must survive.
  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect(w2.getByTestId('btn-theme')).toHaveText('Theme: light', { timeout: 15_000 });
  await expect
    .poll(() => w2.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('light');
  await app2.close();
});

test('theme cycles dark -> light -> high-contrast -> matrix -> dark', async () => {
  const dir = tempUserData();
  const app = await launchApp(dir);
  const w = await app.firstWindow();
  const btn = w.getByTestId('btn-theme');

  await expect(btn).toHaveText('Theme: dark');
  await btn.click();
  await expect(btn).toHaveText('Theme: light');
  await btn.click();
  await expect(btn).toHaveText('Theme: high-contrast');
  await btn.click();
  await expect(btn).toHaveText('Theme: matrix');
  await btn.click();
  await expect(btn).toHaveText('Theme: dark');

  await app.close();
});
