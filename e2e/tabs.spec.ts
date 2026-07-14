import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

// Track A M3: dockview tabs. Each tab is an independent TerminalPane with its own
// shell session (cwd/env/variables/history). Inactive tabs stay MOUNTED
// (renderer:'always'), so a live PTY survives tab switches. Only the visible pane is
// interactable — scope actions with :visible and switch tabs via the dockview header.

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

const visibleInput = (w: Page) => w.locator('[data-testid="cmd-input"]:visible');
const visibleRun = (w: Page) => w.locator('[data-testid="btn-run"]:visible');
const visiblePromptCwd = (w: Page) => w.locator('[data-testid="prompt-cwd"]:visible');

/** Run a command in the currently visible (active) pane. */
async function runInVisible(w: Page, command: string): Promise<void> {
  await visibleInput(w).fill(command);
  await visibleRun(w).click();
}

/** Click a dockview tab by its title text. */
async function clickTab(w: Page, title: string): Promise<void> {
  await w.locator('.dv-tab', { hasText: title }).click();
}

test('tabs: a new tab is an independent session; cwd is isolated and survives switching', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Exactly one tab by default.
  await expect(window.getByTestId('pane')).toHaveCount(1);

  // Tab 1 → cd C:\Windows.
  await runInVisible(window, 'cd C:\\Windows');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\Windows', { timeout: 10_000 });

  // Open a second tab — it becomes active and is a FRESH session (not C:\Windows).
  await window.getByTestId('btn-new-tab').click();
  await expect(window.getByTestId('pane')).toHaveCount(2);
  await expect(visiblePromptCwd(window)).not.toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  // Tab 2 → cd C:\.
  await runInVisible(window, 'cd C:\\');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });

  // Switch back to Tab 1: its session STILL remembers C:\Windows (isolation).
  await clickTab(window, 'Terminal 1');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\Windows', { timeout: 10_000 });

  // Switch to Tab 2: still C:\.
  await clickTab(window, 'Terminal 2');
  await expect(visiblePromptCwd(window)).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });

  await app.close();
});

test('tabs: closing a tab removes its pane', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await expect(window.getByTestId('pane')).toHaveCount(1);

  await window.getByTestId('btn-new-tab').click();
  await expect(window.getByTestId('pane')).toHaveCount(2);

  // Close Terminal 2 via its tab's close action (the default-tab X button).
  await window
    .locator('.dv-tab', { hasText: 'Terminal 2' })
    .locator('.dv-default-tab-action')
    .click();
  await expect(window.getByTestId('pane')).toHaveCount(1);

  await app.close();
});

test('tabs: a live PTY survives a tab switch (renderer:always keeps the pane mounted)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Tab 1: start an interactive PTY program and wait for its startup output.
  await runInVisible(window, `!node ${ECHO_FIXTURE}`);
  await expect(window.locator('[data-testid="pty-block"]:visible')).toBeVisible();
  await expect
    .poll(() => readXtermBuffer(window.locator('[data-testid="pty-block"]:visible')), { timeout: 15_000 })
    .toContain('READY');

  // Open a second tab (Tab 1 goes hidden but stays mounted), then switch back.
  await window.getByTestId('btn-new-tab').click();
  await expect(window.getByTestId('pane')).toHaveCount(2);
  await clickTab(window, 'Terminal 1');

  // The same xterm is still there with its output — never unmounted/disposed — and the
  // PTY child is still running (survived the switch).
  await expect(window.locator('[data-testid="pty-block"]:visible')).toBeVisible();
  await expect
    .poll(() => readXtermBuffer(window.locator('[data-testid="pty-block"]:visible')), { timeout: 15_000 })
    .toContain('READY');
  await expect(window.locator('[data-testid="block-status"]:visible')).toHaveText('running');

  await app.close();
});
