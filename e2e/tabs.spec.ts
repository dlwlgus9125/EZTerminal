import { test, expect, type Page } from './test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const visibleInput = (window: Page) => window.locator('[data-testid="cmd-input"]:visible');
const visibleRun = (window: Page) => window.locator('[data-testid="btn-run"]:visible');
const visiblePromptCwd = (window: Page) => window.locator('[data-testid="prompt-cwd"]:visible');

async function runInVisible(window: Page, command: string): Promise<void> {
  await visibleInput(window).fill(command);
  await visibleRun(window).click();
}

async function clickTab(window: Page, title: string): Promise<void> {
  await window.locator('.dv-tab', { hasText: title }).click();
}

test('tabs: sessions stay isolated across switching and closing removes one', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await expect(window.getByTestId('pane')).toHaveCount(1);

  await runInVisible(window, 'cd C:\\Windows');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\Windows', { timeout: 10_000 });
  await window.getByTestId('btn-new-tab').click();
  await expect(window.getByTestId('pane')).toHaveCount(2);
  await expect(visiblePromptCwd(window)).not.toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });
  await runInVisible(window, 'cd C:\\');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });

  await clickTab(window, 'Terminal 1');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\Windows', { timeout: 10_000 });
  await clickTab(window, 'Terminal 2');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });

  await window.locator('.dv-tab', { hasText: 'Terminal 2' }).locator('.dv-default-tab-action').click();
  await expect(window.getByTestId('pane')).toHaveCount(1);
  await app.close();
});

test('tabs: a live PTY survives a tab switch', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await runInVisible(window, `!node ${ECHO_FIXTURE}`);
  const visiblePty = window.locator('[data-testid="pty-block"]:visible');
  await expect(visiblePty).toBeVisible();
  await expect.poll(() => readXtermBuffer(visiblePty), { timeout: 15_000 }).toContain('READY');

  await window.getByTestId('btn-new-tab').click();
  await expect(window.getByTestId('pane')).toHaveCount(2);
  await clickTab(window, 'Terminal 1');
  await expect(visiblePty).toBeVisible();
  await expect.poll(() => readXtermBuffer(visiblePty), { timeout: 15_000 }).toContain('READY');
  await expect(window.locator('[data-testid="block-status"]:visible')).toHaveText('running');
  await app.close();
});
