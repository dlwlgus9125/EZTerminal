import path from 'node:path';
import { test, expect } from './test';
import { launchApp } from './launch-app';
import { readXtermAllBuffer } from './xterm-buffer';

test('live terminal keeps its graphics across focus changes and releases them only when parked', async () => {
  test.setTimeout(120_000);
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page.getByTestId('pane')).toHaveCount(1);
  // Quoted EZTerminal command strings treat backslashes as escapes.
  const fixture = path.resolve(__dirname, 'fixtures', 'render-lifecycle-output.js').replace(/\\/gu, '/');
  await page.getByTestId('cmd-input').fill(`!node "${fixture}"`);
  await page.getByTestId('btn-run').click();
  const surface = page.getByTestId('pty-block');
  await expect(surface).toHaveAttribute('data-xterm-renderer', 'webgl', { timeout: 15_000 });
  await expect.poll(() => readXtermAllBuffer(surface)).toContain('FRAME');
  const canvas = await surface.locator('canvas').first().elementHandle();
  const terminal = await surface.evaluateHandle((element) => (
    element as HTMLElement & { __ezTerm?: unknown }
  ).__ezTerm);

  // Deliver controlled native-state snapshots to the real preload/provider.
  // This tests the rendering contract, not OS focus or blackout reproduction.
  let sequence = 1_000_000;
  const deliverState = async (focused: boolean, visible = true): Promise<void> => {
    await app.evaluate(({ BrowserWindow }, update) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.send('desktop-window:states-changed', {
        sequence: update.sequence,
        windows: [{
          windowName: 'main', kind: 'main', focused: update.focused, visible: update.visible,
          minimized: !update.visible, maximized: false, fullscreen: false,
          displayId: '1', scaleFactor: 1, sequence: update.sequence,
        }],
      });
    }, { focused, visible, sequence: sequence++ });
  };
  for (let cycle = 0; cycle < 5; cycle++) {
    await deliverState(false);
    await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', 'passive');
    await expect(surface).toHaveAttribute('data-xterm-renderer', 'webgl');
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    await deliverState(true);
    await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', 'active');
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  }
  await deliverState(false, false);
  await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', 'parked', { timeout: 40_000 });
  await expect(surface).toHaveAttribute('data-xterm-renderer', 'dom');
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(false);
  const parkedOutput = await readXtermAllBuffer(surface);
  await expect.poll(() => readXtermAllBuffer(surface)).not.toBe(parkedOutput);
  await deliverState(true);
  await expect(surface).toHaveAttribute('data-xterm-renderer', 'webgl');
  expect(await surface.evaluate((element, saved) => (
    element as HTMLElement & { __ezTerm?: unknown }
  ).__ezTerm === saved, terminal)).toBe(true);
  await expect(surface).toBeVisible();
  const resumedOutput = await readXtermAllBuffer(surface);
  await expect.poll(() => readXtermAllBuffer(surface)).not.toBe(resumedOutput);
  await page.getByTestId('block-cancel').click();
  await expect(page.getByTestId('block-status')).toHaveText('cancelled');
  await app.close();
});
