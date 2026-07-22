import path from 'node:path';
import { expect, test } from '@playwright/test';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const FAKE_CODEX = path.resolve(__dirname, 'fixtures', 'fake-codex', 'codex');
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('direct Codex uses terminal-safe keys and Windows-style clipboard routing', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  await input.fill(FAKE_CODEX);
  await input.press('Enter');

  const run = window.getByTestId('block').last();
  const output = run.getByTestId('text-output');
  await expect(run.getByTestId('pty-plain-block')).toBeVisible();
  await expect.poll(() => output.innerText(), { timeout: 15_000 }).toContain('FAKE-CODEX-READY');
  await expect(window.getByTestId('btn-cancel')).toHaveText('Force stop');

  await input.click();
  await window.keyboard.press('Control+c');
  await expect(window.getByText('Codex keeps running')).toBeVisible();
  await window.keyboard.press('Control+c');
  await expect(window.locator('.ez-ui-toast')).toHaveCount(1);
  await window.keyboard.press('Control+d');

  await window.keyboard.press('Escape');
  await expect.poll(() => output.innerText()).toContain('ESC-RECEIVED');
  await expect(output).not.toContainText('CTRL-C-RECEIVED');
  await expect(output).not.toContainText('CTRL-D-RECEIVED');

  await app.evaluate(({ clipboard, nativeImage }, dataUrl) => {
    clipboard.write({
      text: 'TEXT-FALLBACK',
      image: nativeImage.createFromDataURL(dataUrl),
    });
  }, ONE_PIXEL_PNG);
  await window.keyboard.press('Control+v');
  await expect.poll(() => output.innerText()).toContain('CTRL-V-RECEIVED');
  await expect.poll(() => output.innerText()).not.toContain('TEXT:"TEXT-FALLBACK"');

  await window.keyboard.press('Control+Shift+v');
  await expect.poll(() => output.innerText()).toContain('TEXT:"TEXT-FALLBACK"');

  await app.evaluate(({ BrowserWindow, clipboard }) => {
    clipboard.writeText('NATIVE-PASTE');
    BrowserWindow.getAllWindows()[0]?.webContents.paste();
  });
  await expect.poll(() => output.innerText()).toContain('TEXT:"NATIVE-PASTE"');

  await app.evaluate(({ clipboard }) => clipboard.writeText('first\nsecond'));
  await window.keyboard.press('Control+v');
  const warning = window.getByTestId('terminal-paste-warning-dialog');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('2 lines');
  await expect(window.getByTestId('terminal-paste-warning-cancel')).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(warning).toHaveCount(0);
  await expect(input).toBeFocused();

  await window.keyboard.press('Control+v');
  await window.getByTestId('terminal-paste-warning-confirm').click();
  await expect.poll(() => output.innerText()).toContain('MULTILINE-PASTE-RECEIVED');

  await output.evaluate((element) => {
    document.querySelector<HTMLElement>('[data-testid="cmd-input"]')?.focus();
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await window.keyboard.press('Control+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('COPY-ME');

  await input.click();
  await window.keyboard.press('Control+u');
  await window.keyboard.type('/exit');
  await window.keyboard.press('Enter');
  await expect.poll(() => output.innerText()).toContain('EXPLICIT-EXIT');
  await expect(run.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

test('direct Codex keeps the same safety policy after upgrading to xterm', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  await input.fill(`${FAKE_CODEX} --xterm`);
  await input.press('Enter');

  const run = window.getByTestId('block').last();
  const terminal = run.getByTestId('pty-block');
  await expect(terminal).toBeVisible();
  await expect.poll(() => readXtermBuffer(terminal), { timeout: 15_000 }).toContain('FAKE-CODEX-READY');
  await terminal.click();

  await window.keyboard.press('Control+c');
  await expect(window.getByText('Codex keeps running')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect.poll(() => readXtermBuffer(terminal)).toContain('ESC-RECEIVED');
  await expect.poll(() => readXtermBuffer(terminal)).not.toContain('CTRL-C-RECEIVED');

  await window.keyboard.press('Control+p');
  await expect.poll(() => readXtermBuffer(terminal)).toContain('CTRL-P-RECEIVED');
  await window.keyboard.press('Control+f');
  await expect.poll(() => readXtermBuffer(terminal)).toContain('CTRL-F-RECEIVED');
  await window.keyboard.press('Control+Shift+f');
  await expect(window.getByTestId('terminal-find-bar')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('terminal-find-bar')).toHaveCount(0);

  await app.evaluate(({ clipboard, nativeImage }, dataUrl) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  }, ONE_PIXEL_PNG);
  await window.keyboard.press('Control+v');
  await expect.poll(() => readXtermBuffer(terminal)).toContain('CTRL-V-RECEIVED');

  await expect(run.getByTestId('block-cancel')).toHaveText('Force stop');
  await run.getByTestId('block-cancel').click();
  await expect(run.getByTestId('block-status')).not.toHaveText('running', { timeout: 10_000 });
  await app.close();
});
