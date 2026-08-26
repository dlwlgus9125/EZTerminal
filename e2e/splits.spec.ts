import { test, expect, type Page } from './test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const LINE_PROMPT = path.resolve(__dirname, 'fixtures', 'line-prompt.js');

async function rejectRendererClipboardWrites(window: Page): Promise<void> {
  await window.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __ezRejectedClipboardWrites?: string[];
    };
    scope.__ezRejectedClipboardWrites = [];
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        scope.__ezRejectedClipboardWrites?.push(text);
        throw new DOMException('Renderer clipboard writes are unavailable.', 'NotAllowedError');
      },
    });
  });
}

async function selectContents(element: ReturnType<Page['getByTestId']>): Promise<string> {
  return element.evaluate((target) => {
    const selection = target.ownerDocument.defaultView?.getSelection();
    const range = target.ownerDocument.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? '';
  });
}

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

test('splits: new pane context Copy and Ctrl+C update the OS clipboard when renderer writes reject', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await runIn(splitPane, `node ${LINE_PROMPT}`);
  const output = splitPane.getByTestId('text-output').last();
  await expect.poll(() => output.innerText(), { timeout: 15_000 }).toContain('name: ');
  const selectedText = await selectContents(output);
  expect(selectedText).toContain('name: ');
  await rejectRendererClipboardWrites(window);

  await app.evaluate(({ clipboard }) => clipboard.writeText('context-sentinel'));
  await output.evaluate((target) => {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await window.getByTestId('term-ctx-copy').click();
  const contextResult = await app.evaluate(({ clipboard }) => clipboard.readText());
  await expect(window.locator('.ez-ui-toast').filter({ hasText: 'Copied to clipboard' }).last())
    .toBeVisible();

  await app.evaluate(({ clipboard }) => clipboard.writeText('keyboard-sentinel'));
  await splitPane.getByTestId('cmd-input').focus();
  await selectContents(output);
  await window.keyboard.press('Control+c');
  const keyboardResult = await app.evaluate(({ clipboard }) => clipboard.readText());
  const rendererWriteAttempts = await window.evaluate(() => (
    (globalThis as typeof globalThis & { __ezRejectedClipboardWrites?: string[] })
      .__ezRejectedClipboardWrites ?? []
  ));

  await expect(output).not.toContainText('SIGINT');
  await expect(splitPane.getByTestId('block-status').last()).toHaveText('running');
  expect({ contextResult, keyboardResult, rendererWriteAttempts }).toEqual({
    contextResult: selectedText,
    keyboardResult: selectedText,
    rendererWriteAttempts: [],
  });
  await splitPane.getByTestId('block-cancel').click();
  await app.close();
});

test('splits: an OS clipboard write failure preserves clipboard contents and shows safe feedback', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await runIn(splitPane, 'gen-rows 1');
  await expect(splitPane.getByTestId('block-status').last()).toHaveText('done', {
    timeout: 10_000,
  });
  const output = splitPane.getByTestId('block-command').last();
  await selectContents(output);
  await rejectRendererClipboardWrites(window);
  await app.evaluate(({ clipboard }) => clipboard.writeText('failure-sentinel'));
  await app.evaluate(({ clipboard }) => {
    clipboard.writeText = () => {
      throw new Error('forced test clipboard failure');
    };
  });

  await output.evaluate((target) => {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await window.getByTestId('term-ctx-copy').click();

  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('failure-sentinel');
  const toast = window.locator('.ez-ui-toast').filter({ hasText: 'Could not copy to clipboard' });
  await expect(toast).toContainText('Try again');
  await expect(toast).not.toContainText('gen-rows 1');
  expect(await window.evaluate(() => (
    (globalThis as typeof globalThis & { __ezRejectedClipboardWrites?: string[] })
      .__ezRejectedClipboardWrites ?? []
  ))).toEqual([]);
  await app.close();
});

test('splits: completed output context Copy updates the OS clipboard when renderer writes reject', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await runIn(splitPane, 'gen-rows 1');
  await expect(splitPane.getByTestId('block-status').last()).toHaveText('done', {
    timeout: 10_000,
  });
  const output = splitPane.getByTestId('block-command').last();
  const selectedText = await selectContents(output);
  expect(selectedText).toBe('gen-rows 1');
  await rejectRendererClipboardWrites(window);
  await app.evaluate(({ clipboard }) => clipboard.writeText('sentinel'));

  await output.evaluate((target) => {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await window.getByTestId('term-ctx-copy').click();

  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(selectedText);
  expect(await window.evaluate(() => (
    (globalThis as typeof globalThis & { __ezRejectedClipboardWrites?: string[] })
      .__ezRejectedClipboardWrites ?? []
  ))).toEqual([]);
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

test('splits: xterm context Copy and Ctrl+Shift+C use the main OS clipboard boundary', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const panes = window.getByTestId('pane');

  await splitFromWorkspace(window, 'right');
  await expect(panes).toHaveCount(2);
  const splitPane = panes.nth(1);
  await runIn(splitPane, `!node ${ECHO_FIXTURE}`);
  const ptyBlock = splitPane.getByTestId('pty-block');
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 }).toContain('READY');
  const selectedText = await ptyBlock.evaluate((target) => {
    const terminal = (target as HTMLDivElement & {
      __ezTerm?: { selectAll(): void; getSelection(): string };
    }).__ezTerm;
    if (!terminal) throw new Error('xterm diagnostic seam missing');
    terminal.selectAll();
    return terminal.getSelection();
  });
  expect(selectedText).toContain('READY');
  await rejectRendererClipboardWrites(window);

  await app.evaluate(({ clipboard }) => clipboard.writeText('xterm-menu-sentinel'));
  await splitPane.locator('.xterm-screen').evaluate((target) => {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await expect(window.getByTestId('term-ctx-copy')).toBeEnabled();
  await window.getByTestId('term-ctx-copy').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(selectedText);

  await ptyBlock.evaluate((target) => {
    const terminal = (target as HTMLDivElement & {
      __ezTerm?: { selectAll(): void };
    }).__ezTerm;
    if (!terminal) throw new Error('xterm diagnostic seam missing');
    terminal.selectAll();
  });
  await app.evaluate(({ clipboard }) => clipboard.writeText('xterm-keyboard-sentinel'));
  await splitPane.locator('.xterm-helper-textarea').focus();
  await window.keyboard.press('Control+Shift+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(selectedText);
  expect(await window.evaluate(() => (
    (globalThis as typeof globalThis & { __ezRejectedClipboardWrites?: string[] })
      .__ezRejectedClipboardWrites ?? []
  ))).toEqual([]);
  await splitPane.getByTestId('block-cancel').click();
  await app.close();
});
