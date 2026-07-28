import {
  createRegisteredE2eTempDir,
  expect,
  test,
  type Locator,
  type Page,
} from './test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const CUSTOM_THEME_MOD = {
  schemaVersion: 1,
  id: 'neon-mod',
  name: 'Neon Mod',
  cssVars: { '--term-bg': '#123456' },
  xterm: { background: '#123456', foreground: '#abcdef' },
  fontFamily: '"Fira Code", monospace',
};

function tempUserData(): string {
  return createRegisteredE2eTempDir('ezterm-theme-effects-font-e2e-');
}

function seededThemesDir(): string {
  const dir = createRegisteredE2eTempDir('ezterm-themes-seeded-');
  writeFileSync(path.join(dir, `${CUSTOM_THEME_MOD.id}.json`), JSON.stringify(CUSTOM_THEME_MOD), 'utf8');
  return dir;
}

function emptyThemesDir(): string {
  return createRegisteredE2eTempDir('ezterm-themes-empty-');
}

function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

async function terminalFontFamily(ptyBlock: Locator): Promise<string> {
  return ptyBlock.evaluate((element) => {
    const host = element as HTMLElement & {
      __ezTerm?: { options: { fontFamily?: string } };
    };
    return host.__ezTerm?.options.fontFamily ?? '';
  });
}

async function openXtermBlock(target: Page | Locator): Promise<Locator> {
  await target.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await target.getByTestId('btn-run').click();
  const ptyBlock = target.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 }).toContain('READY');
  return ptyBlock;
}

async function openAppearanceSettings(window: Page): Promise<void> {
  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-category-appearance').click();
}

test('custom theme mod folder-scanned at startup appears in the picker; selecting it applies cssVars and the xterm surface', async () => {
  const app = await launchApp(tempUserData(), { EZTERMINAL_THEMES_DIR: seededThemesDir() });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await openXtermBlock(window);
  await openAppearanceSettings(window);

  const themeSelect = window.getByTestId('settings-theme-select');
  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(1);
  await themeSelect.selectOption('neon-mod');
  await expect.poll(() => window.evaluate(
    () => document.documentElement.getAttribute('data-theme'),
  )).toBe('neon-mod');
  await expect.poll(() => window.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
  )).toBe('#123456');
  await expect.poll(() => window
    .locator('.pty-block .xterm-scrollable-element')
    .evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(hexToRgb('#123456'));
  await app.close();
});

test('importing a theme mod via the Settings UI persists it and adds it to the picker', async () => {
  const app = await launchApp(tempUserData(), { EZTERMINAL_THEMES_DIR: emptyThemesDir() });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await openAppearanceSettings(window);

  const themeSelect = window.getByTestId('settings-theme-select');
  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(0);
  const importDir = createRegisteredE2eTempDir('ezterm-theme-import-fixture-');
  const importFile = path.join(importDir, 'neon-mod.json');
  writeFileSync(importFile, JSON.stringify(CUSTOM_THEME_MOD), 'utf8');
  await window.getByTestId('settings-theme-import-file').setInputFiles(importFile);
  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(1, { timeout: 10_000 });
  await expect(window.getByTestId('settings-theme-import-error')).toHaveCount(0);
  await app.close();
});

test('font selection updates the live terminal and a pane opened afterward', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const existingPty = await openXtermBlock(window);
  await openAppearanceSettings(window);
  await window.getByTestId('settings-font-select').selectOption('fira-code');
  await expect.poll(() => terminalFontFamily(existingPty)).toContain('Fira Code');
  await window.getByTestId('btn-toggle-settings').click();

  await window.getByTestId('btn-new-tab').click();
  const futurePane = window.getByTestId('pane').last();
  const futurePty = await openXtermBlock(futurePane);
  await expect.poll(() => terminalFontFamily(futurePty)).toContain('Fira Code');
  await app.close();
});

test('the bundled self-hosted fonts actually load under the packaged CSP (AC-F4)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  for (const family of ['Share Tech Mono', 'JetBrains Mono', 'Fira Code']) {
    const loaded = await window.evaluate(async (fontFamily) => {
      await document.fonts.load(`13px "${fontFamily}"`);
      await document.fonts.ready;
      return document.fonts.check(`13px "${fontFamily}"`);
    }, family);
    expect(loaded).toBe(true);
  }
  await app.close();
});
