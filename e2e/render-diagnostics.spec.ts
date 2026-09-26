import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';

test('render diagnostics records a manual incident and restore without terminal content', async () => {
  const profile = createRegisteredE2eTempDir('ezterm-render-diagnostics-');
  const app = await launchApp(profile, { EZTERMINAL_RENDER_DIAGNOSTICS: '1' });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const input = page.getByTestId('cmd-input');
  const draft = 'PRIVATE-DIAGNOSTIC-TEST-DRAFT';
  await input.fill(draft);
  const logPath = path.join(profile, 'logs', 'render-diagnostics.log');
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const native = await app.browserWindow(page);
  // CDP keyboard events bypass Electron's before-input-event hook. Exercise
  // the native webContents input route used by this main-process shortcut.
  await native.evaluate((window) => {
    window.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12', modifiers: ['control', 'shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F12', modifiers: ['control', 'shift'] });
  });
  await expect.poll(log).toContain('user-black-screen-marker');
  await expect(input).toHaveValue(draft);
  await native.evaluate((window) => window.minimize());
  await page.waitForTimeout(300);
  await native.evaluate((window) => { window.restore(); window.focus(); });
  await expect.poll(log).toContain('"reason":"restore"');
  await expect.poll(log).toContain('"phase":"renderer"');
  expect(log()).not.toContain(draft);
  await expect(input).toHaveValue(draft);
  await app.close();
});
