import path from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
} from './test';
import { launchApp } from './launch-app';
import { readXtermAllBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
type BrowserWindowHandle = Awaited<ReturnType<ElectronApplication['browserWindow']>>;

async function rendererValue<T>(window: BrowserWindowHandle, expression: string): Promise<T> {
  return window.evaluate(
    (browserWindow, source) => browserWindow.webContents.executeJavaScript(source),
    expression,
  ) as Promise<T>;
}

const visibleInputValueExpression = String.raw`(() => {
  const input = [...document.querySelectorAll('[data-testid="cmd-input"]')]
    .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
  return input instanceof HTMLInputElement ? input.value : null;
})()`;

const visibleXtermTextExpression = String.raw`(() => {
  const element = [...document.querySelectorAll('[data-testid="pty-block"]')]
    .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
  const terminal = element?.__ezTerm;
  if (!terminal) return '';
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
})()`;

test('renderer crash restores layout, session surfaces, draft, and a live PTY run', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const firstPane = page.locator('[data-testid="pane"]:visible');
  await expect(firstPane).toHaveAttribute('data-session-id', /.+/, { timeout: 15_000 });
  const firstSessionId = await firstPane.getAttribute('data-session-id');
  await firstPane.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await firstPane.getByTestId('btn-run').click();
  const firstPty = firstPane.getByTestId('pty-block');
  await expect.poll(() => readXtermAllBuffer(firstPty), { timeout: 15_000 }).toContain('READY');

  await page.getByTestId('btn-new-tab').click();
  await expect(page.getByTestId('pane')).toHaveCount(2);
  const secondPane = page.locator('[data-testid="pane"]:visible');
  await expect(secondPane).toHaveAttribute('data-session-id', /.+/, { timeout: 15_000 });
  const secondSessionId = await secondPane.getAttribute('data-session-id');
  expect(secondSessionId).not.toBe(firstSessionId);
  const draft = 'draft-survives-renderer-crash';
  await secondPane.getByTestId('cmd-input').fill(draft);

  const checkpoint = await page.evaluate(() => {
    const flush = (globalThis as unknown as {
      __ezRendererRecoveryFlush?: () => Promise<{
        panes: readonly { panelId: string; draft: string }[];
      } | null>;
    }).__ezRendererRecoveryFlush;
    if (!flush) throw new Error('__ezRendererRecoveryFlush seam missing');
    return flush();
  });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.panes.find((pane) => pane.panelId === 'tab-2')?.draft).toBe(draft);
  const crashed = page.waitForEvent('crash');
  const browserWindow = await app.browserWindow(page);
  const reloaded = browserWindow.evaluate((window) => new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer did not finish reloading')), 30_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
    window.webContents.forcefullyCrashRenderer();
  }));
  await Promise.all([crashed, reloaded]);

  // Playwright intentionally leaves a crashed CDP Page terminal. The native
  // BrowserWindow and its reloaded webContents remain observable from Electron
  // main, so use that boundary for post-crash assertions.
  await expect.poll(async () => {
    try {
      return await rendererValue<boolean>(browserWindow, String.raw`Boolean(
        document.querySelector('h1')?.textContent?.includes('EZTerminal')
        && globalThis.__ezDock
      )`);
    } catch {
      return false;
    }
  }, { timeout: 30_000 }).toBe(true);
  await expect.poll(() => rendererValue<number>(browserWindow, String.raw`
    document.querySelectorAll('[data-testid="pane"]').length
  `), { timeout: 30_000 }).toBe(2);
  const recoveredSessionIds = await rendererValue<string[]>(browserWindow, String.raw`
    [...document.querySelectorAll('[data-testid="pane"]')]
      .map((pane) => pane instanceof HTMLElement ? (pane.dataset.sessionId ?? '') : '')
  `);
  expect(new Set(recoveredSessionIds)).toEqual(new Set([firstSessionId, secondSessionId]));
  await expect.poll(() => rendererValue<string | null>(
    browserWindow,
    visibleInputValueExpression,
  ), { timeout: 20_000 }).toBe(draft);

  await rendererValue<void>(browserWindow, String.raw`
    globalThis.__ezDock.getPanel('tab-1').api.setActive()
  `);
  await expect.poll(() => rendererValue<string | null>(browserWindow, String.raw`(() => {
    const element = [...document.querySelectorAll('[data-testid="pty-block"]')]
      .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
    return element instanceof HTMLElement ? (element.dataset.presentationMode ?? null) : null;
  })()`), { timeout: 20_000 }).toBe('live');
  await expect.poll(
    () => rendererValue<string>(browserWindow, visibleXtermTextExpression),
    { timeout: 20_000 },
  ).toContain('READY');
  await rendererValue<boolean>(browserWindow, String.raw`(() => {
    const element = [...document.querySelectorAll('[data-testid="pty-block"]')]
      .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
    const terminal = element?.__ezTerm;
    if (!terminal) return false;
    terminal.paste('after-crash\r');
    return true;
  })()`);
  await expect.poll(
    () => rendererValue<string>(browserWindow, visibleXtermTextExpression),
    { timeout: 20_000 },
  ).toContain('ECHO:after-crash');

  await app.close();
});
