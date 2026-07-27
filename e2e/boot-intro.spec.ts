import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { launchApp } from './launch-app';

test('harness seed suppresses the intro and is not quarantined', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-seed-'));
  const app = await launchApp(dir);
  const window = await app.firstWindow();
  await window.waitForSelector('[data-testid="cmd-input"]');
  await window.waitForTimeout(1200);
  console.log('SEEDCHECK intro=', await window.getByTestId('boot-intro').count());
  console.log('SEEDCHECK files=', JSON.stringify(readdirSync(dir).filter((f) => f.startsWith('settings'))));
  await expect(window.getByTestId('boot-intro')).toHaveCount(0);
  expect(existsSync(path.join(dir, 'settings.json.corrupt'))).toBe(false);
  await app.close();
});

test('a spec can still opt the intro back in', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-optin-'));
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, bootIntro: true }),
    'utf8',
  );
  const app = await launchApp(dir);
  const window = await app.firstWindow();
  await expect(window.getByTestId('boot-intro')).toBeVisible();
  await expect(window.getByTestId('boot-intro')).toHaveCount(0, { timeout: 6000 });
  await expect(window.getByTestId('cmd-input')).toBeVisible();
  await app.close();
});
