import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

import { launchApp } from './launch-app';
import { TestWsClient } from './ws-client';

const REMOTE_PORT = 17421;
const LOOPBACK_REMOTE_ENV = { EZTERMINAL_REMOTE_VPN_INTERFACE: '127.0.0.1' } as const;

test('remote toggle: enabling binds; disabling closes the live client and refuses new ones; re-enabling rebinds cleanly', async () => {
  const app = await launchApp(undefined, {
    ...LOOPBACK_REMOTE_ENV,
    EZTERMINAL_REMOTE_PORT: String(REMOTE_PORT),
  });
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const token = await win.evaluate(() => window.ezterminal.getRemoteToken());
  await win.getByTestId('btn-toggle-settings').click();
  await expect(win.getByTestId('settings-panel')).toBeVisible();
  await win.getByTestId('settings-category-integrations').click();

  const toggle = win.getByTestId('settings-remote-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const client = await TestWsClient.connectAuthed(`ws://127.0.0.1:${REMOTE_PORT}`, token);

  try {
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await client.waitForClose();

    const refused = new WebSocket(`ws://127.0.0.1:${REMOTE_PORT}`);
    const outcome = await new Promise<'error' | 'open'>((resolve) => {
      refused.once('error', () => resolve('error'));
      refused.once('open', () => resolve('open'));
    });
    expect(outcome).toBe('error');
    refused.removeAllListeners();

    await toggle.click();
    await expect(toggle).toBeChecked();
    const client2 = await TestWsClient.connectAuthed(`ws://127.0.0.1:${REMOTE_PORT}`, token);
    client2.close();
  } finally {
    client.close();
    await app.close();
  }
});
