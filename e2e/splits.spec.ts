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

test('splits: terminal context menu opens from an empty split pane background', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await splitPane.getByTestId('cmd-input').focus();
  await splitPane.getByTestId('block-list').click({ button: 'right' });

  await expect(window.getByTestId('terminal-context-menu')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('terminal-context-menu')).toHaveCount(0);
  await expect(splitPane.getByTestId('cmd-input')).toBeFocused();
  await app.close();
});

test('splits: terminal context menu opens from a vertically split pane', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'down');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await splitPane.getByTestId('block-list').click({ button: 'right' });

  await expect(window.getByTestId('terminal-context-menu')).toBeVisible();
  await app.close();
});

test('splits: pane context menu routes input and output actions to the invoking pane', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  const input = splitPane.getByTestId('cmd-input');
  const menu = window.getByTestId('terminal-context-menu');
  await input.fill('alphabeta');

  await window.evaluate((text) => navigator.clipboard.writeText(text), ' ');
  await input.evaluate((element) => {
    const inputElement = element as HTMLInputElement;
    inputElement.focus();
    inputElement.setSelectionRange(5, 5);
    const rect = inputElement.getBoundingClientRect();
    inputElement.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('term-ctx-copy')).toBeDisabled();
  await menu.getByTestId('term-ctx-paste').click();
  await expect(input).toHaveValue('alpha beta');
  await expect.poll(() => input.evaluate((element) => (element as HTMLInputElement).selectionStart))
    .toBe(6);

  await input.evaluate((element) => {
    const inputElement = element as HTMLInputElement;
    inputElement.focus();
    inputElement.setSelectionRange(0, 5);
    const rect = inputElement.getBoundingClientRect();
    inputElement.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await expect(menu.getByTestId('term-ctx-copy')).toBeEnabled();
  await menu.getByTestId('term-ctx-copy').click();
  await expect.poll(() => window.evaluate(() => navigator.clipboard.readText())).toBe('alpha');

  await input.press('Shift+F10');
  await expect(menu).toBeVisible();
  await menu.getByTestId('term-ctx-select-all').click();
  await expect.poll(() => input.evaluate((element) => {
    const inputElement = element as HTMLInputElement;
    return [inputElement.selectionStart, inputElement.selectionEnd, inputElement.value.length];
  })).toEqual([0, 10, 10]);

  await runIn(splitPane, 'gen-rows 1');
  await expect(splitPane.getByTestId('block-status').last()).toHaveText('done', {
    timeout: 10_000,
  });
  const commandOutput = splitPane.getByTestId('block-command').last();
  await commandOutput.evaluate((element) => {
    const textNode = element.firstChild;
    if (!textNode) throw new Error('missing block command text');
    const selection = globalThis.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textNode);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await expect(menu.getByTestId('term-ctx-copy')).toBeEnabled();
  await menu.getByTestId('term-ctx-copy').click();
  await expect.poll(() => window.evaluate(() => navigator.clipboard.readText())).toBe('gen-rows 1');

  await input.fill('draft');
  await input.evaluate((element) => {
    const inputElement = element as HTMLInputElement;
    inputElement.setSelectionRange(5, 5);
  });
  await window.evaluate((text) => navigator.clipboard.writeText(text), '-tail');
  await splitPane.getByTestId('block-list').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await menu.getByTestId('term-ctx-paste').click();
  await expect(input).toHaveValue('draft-tail');

  await splitPane.getByTestId('block-list').click({ button: 'right' });
  await menu.getByTestId('term-ctx-select-all').click();
  await expect.poll(() => window.evaluate(() => globalThis.getSelection()?.toString() ?? ''))
    .toContain('gen-rows 1');
  await app.close();
});

test('splits: xterm keeps one menu and an outside pane click keeps its focus', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const first = panes.nth(0);
  const second = panes.nth(1);
  await runIn(second, `!node ${ECHO_FIXTURE}`);
  await expect(second.locator('.xterm-screen')).toBeVisible();
  await second.locator('.xterm-screen').click({ button: 'right' });

  await expect(window.getByTestId('terminal-context-menu')).toHaveCount(1);
  await expect(window.getByTestId('term-ctx-find')).toBeVisible();
  await first.getByTestId('cmd-input').click();
  await expect(window.getByTestId('terminal-context-menu')).toHaveCount(0);
  await expect(first.getByTestId('cmd-input')).toBeFocused();
  await app.close();
});
