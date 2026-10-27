import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createRegisteredE2eTempDir, expect, test, type Page } from './test';
import { launchApp } from './launch-app';

// I4-10: a new install starts in Matrix; an install from before that never saved a theme keeps the Dark it showed
// (the first start writes it, marked as the default); a theme already saved is never touched.

function settingsOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

async function themeOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

test('a new profile starts in Matrix and records that the default wrote it', async () => {
  const dir = createRegisteredE2eTempDir('ezterm-theme-default-new-');
  const app = await launchApp(dir, {}, { profileAsIs: true });
  const page = await app.firstWindow();
  await expect.poll(() => themeOf(page), { timeout: 20_000 }).toBe('matrix');
  expect(settingsOf(dir)).toMatchObject({ theme: 'matrix', themeSource: 'default' });
  await app.close();

  // The second start reads the theme the first one wrote: it stays Matrix.
  const again = await launchApp(dir, {}, { profileAsIs: true });
  const second = await again.firstWindow();
  await expect.poll(() => themeOf(second), { timeout: 20_000 }).toBe('matrix');
  await again.close();
});

test('a profile from before that never saved a theme keeps Dark', async () => {
  const dir = createRegisteredE2eTempDir('ezterm-theme-default-old-');
  // An earlier build's settings: startup and boot intro, no theme.
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, bootIntro: false }), 'utf8');
  const app = await launchApp(dir, {}, { profileAsIs: true });
  const page = await app.firstWindow();
  await expect.poll(() => themeOf(page), { timeout: 20_000 }).toBe('dark');
  expect(settingsOf(dir)).toMatchObject({ theme: 'dark', themeSource: 'default', bootIntro: false });
  await app.close();
});

test('a theme already saved is kept as it is', async () => {
  for (const theme of ['light', 'matrix', 'dark'] as const) {
    const dir = createRegisteredE2eTempDir(`ezterm-theme-default-${theme}-`);
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, bootIntro: false, theme }), 'utf8');
    const app = await launchApp(dir, {}, { profileAsIs: true });
    const page = await app.firstWindow();
    await expect.poll(() => themeOf(page), { timeout: 20_000 }).toBe(theme);
    const saved = settingsOf(dir);
    expect(saved.theme).toBe(theme);
    expect(saved.themeSource).toBeUndefined();
    await app.close();
  }
});
