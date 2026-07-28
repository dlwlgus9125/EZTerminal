import { test, expect, type Page } from './test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const ECHO_CMD_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.cmd');

async function terminalText(window: Page): Promise<string> {
  return readXtermBuffer(window.getByTestId('pty-block'));
}

async function plainText(window: Page): Promise<string> {
  return window.getByTestId('text-output').innerText();
}

test('PTY: `!node <fixture>` runs an interactive program in an xterm block and round-trips input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const ptyBlock = window.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect(window.getByTestId('block-status')).toHaveText('running');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('READY');

  await ptyBlock.click();
  await window.keyboard.type('hi');
  await window.keyboard.press('Enter');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ECHO:');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
  await app.close();
});

test('PTY: `!fixture.cmd` (M1 batch shim) runs an interactive program in an xterm block and round-trips input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!${ECHO_CMD_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const ptyBlock = window.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect(window.getByTestId('block-status')).toHaveText('running');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('READY');

  await ptyBlock.click();
  await window.keyboard.type('hi');
  await window.keyboard.press('Enter');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ECHO:');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
  await app.close();
});

test('PTY: a non-batch external WITHOUT `!` auto-routes to PTY execution, rendered PLAIN (M2 routing + M3 adaptive render)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('node --version');
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toMatch(/v?\d+\.\d+\.\d+/);
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await app.close();
});

test('AC-3: bare `node` REPL auto-routes to PTY, rendered PLAIN — prompt, evaluate, exit via plain input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('node');
  await window.getByTestId('btn-run').click();

  const plainBlock = window.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('>');

  await window.getByTestId('cmd-input').click();
  await window.keyboard.type('21 + 21');
  await window.keyboard.press('Enter');
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('42');

  await window.keyboard.type('.exit');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await app.close();
});
