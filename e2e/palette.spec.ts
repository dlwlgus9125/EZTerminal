import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

// E2: command palette (Ctrl+Shift+P). Filtering is a case-insensitive subsequence
// match, so "split r" matches "Split right" but not "Split down" (no 'r' after the
// shared "split " prefix) — the single match is selected by default, so Enter runs
// it deterministically.

test('palette: Ctrl+Shift+P opens, subsequence filter + Enter runs the action', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  await window.keyboard.press('Control+Shift+KeyP');
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await window.getByTestId('palette-input').fill('split r');
  await expect(window.getByTestId('palette-item-split-right')).toBeVisible();
  await expect(window.getByTestId('palette-item-split-down')).toHaveCount(0);

  await window.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(panes).toHaveCount(2);

  await app.close();
});

test('palette: Escape closes it and typing goes back to the cmd-input normally', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.keyboard.press('Control+Shift+KeyP');
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  const input = window.getByTestId('pane').getByTestId('cmd-input');
  await input.fill('echo hi');
  await expect(input).toHaveValue('echo hi');

  await app.close();
});

test('palette: Alt+Shift+= still splits when the palette is closed (no regression)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);
  await expect(window.getByTestId('command-palette')).toHaveCount(0);

  await window.keyboard.press('Alt+Shift+Equal');
  await expect(panes).toHaveCount(2);

  await app.close();
});
