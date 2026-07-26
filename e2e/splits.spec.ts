import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

async function runIn(pane: ReturnType<Page['getByTestId']>, command: string): Promise<void> {
  await pane.getByTestId('cmd-input').fill(command);
  await pane.getByTestId('btn-run').click();
}

async function splitFromWorkspace(window: Page, direction: 'right' | 'down'): Promise<void> {
  await window.getByTestId('btn-workspace-menu').click();
  await window.getByTestId(`btn-split-${direction}`).click();
}

test('splits: sessions stay isolated and closing a split tears its session down', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  await runIn(panes.nth(0), 'cd C:\\Windows');
  await expect(panes.nth(0).getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });
  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const first = panes.nth(0);
  const second = panes.nth(1);
  await expect(second.getByTestId('prompt-cwd')).not.toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });
  await runIn(second, 'cd C:\\');
  await expect(second.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });
  await expect(first.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows');

  await window.locator('.dv-tab', { hasText: 'Terminal 2' }).locator('.dv-default-tab-action').click();
  await expect(panes).toHaveCount(1);
  await expect.poll(() => window.evaluate(() => {
    const seam = globalThis as unknown as { __ezSessions?: () => number };
    return seam.__ezSessions ? seam.__ezSessions() : -1;
  })).toBe(1);
  await runIn(panes.nth(0), 'gen-rows 1');
  await expect(panes.nth(0).getByTestId('block-status').last()).toHaveText('done', { timeout: 10_000 });
  await app.close();
});

test('splits: a live PTY renders in a split pane while the sibling stays normal', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');
  await splitFromWorkspace(window, 'down');
  await expect(panes).toHaveCount(2);

  const first = panes.nth(0);
  const second = panes.nth(1);
  await runIn(second, `!node ${ECHO_FIXTURE}`);
  await expect(second.getByTestId('pty-block')).toBeVisible();
  await expect.poll(() => readXtermBuffer(second.getByTestId('pty-block')), {
    timeout: 15_000,
  }).toContain('READY');
  await expect(first.getByTestId('pty-block')).toHaveCount(0);
  await app.close();
});

test('splits: Alt+Shift+= splits the active pane while preserving its draft', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  const input = panes.nth(0).getByTestId('cmd-input');
  await input.fill('echo hi');
  await window.keyboard.press('Alt+Shift+Equal');
  await expect(panes).toHaveCount(2);
  await expect(input).toHaveValue('echo hi');
  await app.close();
});
