import { test, expect } from './test';

import { launchApp } from './launch-app';

// Quick Open command mode (Ctrl+Shift+P). Filtering is a case-insensitive subsequence
// match, so "split r" matches "Split right" but not "Split down" (no 'r' after the
// shared "split " prefix) — the single match is selected by default, so Enter runs
// it deterministically.

test('quick open: Ctrl+Shift+P opens command mode, filters, and runs an action', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  await window.keyboard.press('Control+Shift+KeyP');
  const quickOpen = window.getByTestId('quick-open-modal');
  await expect(quickOpen).toBeVisible();

  await window.getByTestId('quick-open-input').fill('split r');
  await expect(window.getByTestId('quick-open-row-action-split-right')).toBeVisible();
  await expect(window.getByTestId('quick-open-row-action-split-down')).toHaveCount(0);

  await window.keyboard.press('Enter');
  await expect(quickOpen).toHaveCount(0);
  await expect(panes).toHaveCount(2);

  await app.close();
});

test('Ctrl+K opens from chrome but remains readline kill-to-end in the terminal composer', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const quickOpen = window.getByTestId('quick-open-modal');

  await window.getByTestId('btn-new-tab').focus();
  await window.keyboard.press('Control+KeyK');
  await expect(quickOpen).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(quickOpen).toHaveCount(0);

  const composer = window.getByTestId('cmd-input');
  await composer.fill('echo retained');
  await composer.evaluate((element) => {
    (element as HTMLInputElement).setSelectionRange(5, 5);
  });
  await composer.press('Control+KeyK');
  await expect(composer).toHaveValue('echo ');
  await expect(quickOpen).toHaveCount(0);

  await app.close();
});
