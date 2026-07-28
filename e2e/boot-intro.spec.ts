import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createRegisteredE2eTempDir, expect, test } from './test';

import { launchApp } from './launch-app';

test('harness seed suppresses the intro and is not quarantined', async () => {
  const dir = createRegisteredE2eTempDir('ezterm-seed-');
  const app = await launchApp(dir);
  const window = await app.firstWindow();
  await window.waitForSelector('[data-testid="cmd-input"]');
  // Long enough that a playing overlay would certainly be on screen.
  await window.waitForTimeout(1200);
  await expect(window.getByTestId('boot-intro')).toHaveCount(0);
  // The seed has to satisfy SettingsSchema. If it does not, the store
  // quarantines it and the flag is silently lost, which is how this regressed
  // the first time: the overlay played over every spec and the suite still
  // passed because Playwright waits it out.
  expect(readdirSync(dir).filter((name) => name.startsWith('settings'))).toEqual(['settings.json']);
  expect(existsSync(path.join(dir, 'settings.json.corrupt'))).toBe(false);
  await app.close();
});

test('a spec can still opt the intro back in', async () => {
  const dir = createRegisteredE2eTempDir('ezterm-optin-');
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
