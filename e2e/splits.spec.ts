import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

// Track A follow-up ①: split panes. A split opens another self-contained TerminalPane in
// a NEW dockview grid group, so multiple panes are visible AT ONCE (unlike tabs, where
// only the active pane is visible). Because of that, tabs.spec.ts's `:visible` helpers do
// NOT apply here — they would match 2 elements and trip Playwright strict mode. We scope
// every action to a specific pane by index: getByTestId('pane').nth(i). dockview renders
// grid groups left→right / top→bottom, so nth(0) is the original (reference) pane and
// nth(1) is the newly-split one for a 'right'/'below' split.

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

/** Run a command inside a specific pane (both panes are visible, so scope by container). */
async function runIn(pane: ReturnType<Page['getByTestId']>, command: string): Promise<void> {
  await pane.getByTestId('cmd-input').fill(command);
  await pane.getByTestId('btn-run').click();
}

async function splitFromWorkspace(window: Page, direction: 'right' | 'down'): Promise<void> {
  await window.getByTestId('btn-workspace-menu').click();
  await window.getByTestId(`btn-split-${direction}`).click();
}

test('splits: Split → creates two simultaneous independent sessions (cwd isolation)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  // Original pane → cd C:\Windows.
  await runIn(panes.nth(0), 'cd C:\\Windows');
  await expect(panes.nth(0).getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  // Split right → a second pane appears; BOTH visible at once (no tab switch).
  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const pane0 = panes.nth(0); // original, still C:\Windows
  const pane1 = panes.nth(1); // fresh split session

  // Asserted concurrently: original keeps its cwd, the split is a DIFFERENT session.
  await expect(pane0.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });
  await expect(pane1.getByTestId('prompt-cwd')).not.toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  // cd in the split changes ONLY the split; the original is untouched (no shared cwd).
  await runIn(pane1, 'cd C:\\');
  await expect(pane1.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\', { timeout: 10_000 });
  await expect(pane0.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  await app.close();
});

test('splits: a live PTY renders in a split pane while the sibling stays a normal pane', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  // Split down, then run an interactive PTY program in the new (bottom) pane.
  await splitFromWorkspace(window, 'down');
  await expect(panes).toHaveCount(2);
  const pane0 = panes.nth(0);
  const pane1 = panes.nth(1);

  await runIn(pane1, `!node ${ECHO_FIXTURE}`);

  // The PTY block renders and reaches READY inside the split pane (both panes visible, so
  // the 0×0 refit guard did NOT suppress the split pane's fit).
  await expect(pane1.getByTestId('pty-block')).toBeVisible();
  await expect
    .poll(() => readXtermBuffer(pane1.getByTestId('pty-block')), { timeout: 15_000 })
    .toContain('READY');

  // The sibling pane stayed a normal (non-PTY) pane.
  await expect(pane0.getByTestId('pty-block')).toHaveCount(0);

  await app.close();
});

test('splits: closing a split pane returns to one pane and tears down its session', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);

  // Close the split (Terminal 2) via its group tab's close action (dockview auto-removes
  // the emptied group; the surviving group grows to fill).
  await window
    .locator('.dv-tab', { hasText: 'Terminal 2' })
    .locator('.dv-default-tab-action')
    .click();
  await expect(panes).toHaveCount(1);

  // The survivor is still a live, interactive session.
  await runIn(panes.nth(0), 'cd C:\\');
  await expect(panes.nth(0).getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\', {
    timeout: 10_000,
  });

  await app.close();
});

test('splits: Alt+Shift+= splits the active pane even when the cmd-input is focused', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  // Type a known draft into the command input, then fire the keyboard shortcut. The
  // capture-phase listener must intercept it — split the pane WITHOUT appending '=' to
  // the draft (fill also focuses the input, so the keydown targets it).
  const input = panes.nth(0).getByTestId('cmd-input');
  await input.fill('echo hi');
  await window.keyboard.press('Alt+Shift+Equal');

  await expect(panes).toHaveCount(2);
  await expect(input).toHaveValue('echo hi');

  await app.close();
});
