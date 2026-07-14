import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

async function clickTab(window: Page, title: string): Promise<void> {
  await window.locator('.dv-tab', { hasText: title }).click();
}

test('Ctrl+Tab previews MRU panes, commits on Ctrl release, and never reaches PTY', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();
  const firstPty = window.getByTestId('pty-block');
  await expect.poll(() => readXtermBuffer(firstPty), { timeout: 15_000 }).toContain('READY');

  await window.getByTestId('btn-new-tab').click();
  await clickTab(window, 'Terminal 1');
  await firstPty.click();

  await window.keyboard.down('Control');
  await window.keyboard.press('Tab');
  const switcher = window.getByTestId('recent-panel-switcher');
  await expect(switcher).toBeVisible();
  await expect(switcher.locator('[role="option"][aria-selected="true"]')).toContainText('Terminal 2');
  await expect(window.locator('.dv-tab.dv-active-tab')).toContainText('Terminal 1');

  await window.keyboard.up('Control');
  await expect(switcher).toBeHidden();
  await expect(window.locator('.dv-tab.dv-active-tab')).toContainText('Terminal 2');
  await expect(window.locator('[data-testid="cmd-input"]:visible')).toBeFocused();

  await clickTab(window, 'Terminal 1');
  await expect.poll(() => readXtermBuffer(firstPty)).not.toContain('ECHO:');

  await firstPty.click();
  await window.keyboard.down('Control');
  await window.keyboard.press('Tab');
  await expect(switcher).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
  await window.keyboard.up('Control');
  await expect(window.locator('.dv-tab.dv-active-tab')).toContainText('Terminal 1');
  await expect.poll(() => readXtermBuffer(firstPty)).not.toContain('ECHO:');

  await window.getByTestId('block-cancel').click();
  await app.close();
});
