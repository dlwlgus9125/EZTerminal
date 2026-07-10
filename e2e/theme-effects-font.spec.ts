import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// theme-effects-font M3 (Wave 3 desktop): custom theme mods (folder-scan +
// Import via the Settings drawer), the Font picker, and per-effect toggles.
// Built-in theme cycling itself is covered by theme.spec.ts — this file is
// scoped to what M3 adds on top of it.

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
  return mkdtempSync(path.join(tmpdir(), 'ezterm-theme-effects-font-e2e-'));
}

/** A themes dir pre-seeded with CUSTOM_THEME_MOD (the folder-scan path). */
function seededThemesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-themes-seeded-'));
  writeFileSync(path.join(dir, `${CUSTOM_THEME_MOD.id}.json`), JSON.stringify(CUSTOM_THEME_MOD), 'utf8');
  return dir;
}

/** An empty (but isolated) themes dir — nothing folder-scanned yet. */
function emptyThemesDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-themes-empty-'));
}

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Concatenated text currently rendered in the xterm grid (post-upgrade) — mirrors pty.spec.ts. */
async function terminalText(window: Page): Promise<string> {
  return window.locator('.pty-block .xterm-rows').innerText();
}

/** Force an xterm-backed pty block open (`!node <fixture>`) and wait for its startup output. */
async function openXtermBlock(window: Page): Promise<void> {
  await window.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('pty-block')).toBeVisible();
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('READY');
}

test('custom theme mod folder-scanned at startup appears in the picker; selecting it applies cssVars and the xterm surface', async () => {
  const app = await launchApp(tempUserData(), { EZTERMINAL_THEMES_DIR: seededThemesDir() });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await openXtermBlock(window);

  await window.getByTestId('btn-toggle-settings').click();
  const themeSelect = window.getByTestId('settings-theme-select');
  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(1);

  await themeSelect.selectOption('neon-mod');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('neon-mod');
  await expect
    .poll(() =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
      ),
    )
    .toBe('#123456');

  // The xterm surface itself (not just the CSS var) reflects the mod: xterm.js
  // sets an INLINE background-color straight from `theme.background` on its
  // internal scrollable-element wrapper (`.xterm-viewport`'s sibling, NOT the
  // viewport div itself, which stays at xterm.css's static black default) —
  // confirmed by inspecting the live DOM, not by reading xterm's minified
  // source, since that wrapper is an undocumented implementation detail.
  await expect
    .poll(() =>
      window
        .locator('.pty-block .xterm-scrollable-element')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe(hexToRgb('#123456'));

  await app.close();
});

test('importing a theme mod via the Settings UI persists it and adds it to the picker', async () => {
  const app = await launchApp(tempUserData(), { EZTERMINAL_THEMES_DIR: emptyThemesDir() });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('btn-toggle-settings').click();
  const themeSelect = window.getByTestId('settings-theme-select');
  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(0);

  const importDir = mkdtempSync(path.join(tmpdir(), 'ezterm-theme-import-fixture-'));
  const importFile = path.join(importDir, 'neon-mod.json');
  writeFileSync(importFile, JSON.stringify(CUSTOM_THEME_MOD), 'utf8');
  await window.getByTestId('settings-theme-import-file').setInputFiles(importFile);

  await expect(themeSelect.locator('option', { hasText: 'Neon Mod' })).toHaveCount(1, { timeout: 10_000 });
  await expect(window.getByTestId('settings-theme-import-error')).toHaveCount(0);

  await app.close();
});

test('selecting a font from the picker changes the terminal fontFamily live', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await openXtermBlock(window);

  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-font-select').selectOption('fira-code');

  await expect
    .poll(() =>
      window.locator('.pty-block .xterm-rows').evaluate((el) => getComputedStyle(el).fontFamily),
    )
    .toContain('Fira Code');

  await app.close();
});

test('the bundled self-hosted fonts actually load under the packaged CSP (AC-F4)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Cascadia Code is exempt — it's the system/default face with no @font-face,
  // so `document.fonts.check` for it says nothing about the CSP/bundling this
  // test is actually verifying.
  for (const family of ['Share Tech Mono', 'JetBrains Mono', 'Fira Code']) {
    const ok = await window.evaluate(async (fam) => {
      // `.check` alone can be false for an @font-face never yet requested —
      // `.load` first forces the fetch so `.check` reflects whether it
      // actually resolved (bundled woff2 under 'self') rather than just
      // whether some earlier paint happened to touch it.
      await document.fonts.load('13px "' + fam + '"');
      await document.fonts.ready;
      return document.fonts.check('13px "' + fam + '"');
    }, family);
    expect(ok).toBe(true);
  }

  await app.close();
});

test('a font selected in the picker is applied to a pane opened AFTER the selection, not just already-open ones (AC-F3)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-font-select').selectOption('fira-code');
  await window.getByTestId('btn-toggle-settings').click(); // close the drawer — it overlays btn-run

  // No pty block is open yet at this point — opening one now exercises the
  // xterm Terminal's INITIAL construction (PtyBlock.tsx's mount effect), not
  // the live 'ez:theme' re-apply path already covered by the test above.
  await openXtermBlock(window);

  await expect
    .poll(() => window.locator('.pty-block .xterm-rows').evaluate((el) => getComputedStyle(el).fontFamily))
    .toContain('Fira Code');

  await app.close();
});

test('toggling an effect on the Matrix theme flips the data-effect attribute on <html>', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-theme-select').selectOption('matrix');

  const scanlinesToggle = window.getByTestId('settings-effect-scanlines');
  await expect(scanlinesToggle).toBeChecked(); // Matrix defaults scanlines ON (desktop)
  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-effect-scanlines')))
    .toBe('on');

  await scanlinesToggle.uncheck();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-effect-scanlines')))
    .toBeNull();

  await scanlinesToggle.check();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-effect-scanlines')))
    .toBe('on');

  await app.close();
});

test('Matrix theme shows scanlines by default on desktop (EFFECT_CATALOG defaultOn wiring, no Settings interaction)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  // Matrix IS the boot default now — no interaction at all before the
  // defaultOn wiring must already have applied the effects.
  const themeBtn = window.getByTestId('btn-theme');
  await expect(themeBtn).toHaveText('Theme: matrix');

  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-effect-scanlines')))
    .toBe('on');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.getAttribute('data-effect-phosphor-glow')))
    .toBe('on');

  await app.close();
});
