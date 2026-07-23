import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { createServer } from 'node:net';

import { launchApp } from './launch-app';
import { TestWsClient } from './ws-client';

// v0.2.0 M6: the Settings drawer's remote on/off toggle (D2). The load-bearing
// property is main.ts's async `stop()` (remote-bridge.ts): disabling must
// actually terminate live client sockets AND fully release the port before
// resolving, so a rapid re-enable never races an EADDRINUSE. Drives the REAL
// remote-bridge.ts with a Node `ws` client, the same way session-mirror.spec.ts
// does — this port is dedicated to this spec so it never collides with
// another instance's default-port bridge.
const REMOTE_PORT = 17421;
const LOOPBACK_REMOTE_ENV = { EZTERMINAL_REMOTE_VPN_INTERFACE: '127.0.0.1' } as const;
test('remote runtime: bind failure preserves desired state, reports EADDRINUSE, and retry recovers', async () => {
  const occupiedPort = 17422;
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(occupiedPort, '127.0.0.1', resolve);
  });
  const app = await launchApp(undefined, {
    ...LOOPBACK_REMOTE_ENV,
    EZTERMINAL_REMOTE_PORT: String(occupiedPort),
  });

  try {
    const win = await app.firstWindow();
    const failed = await win.evaluate(() => window.ezterminal.setRemoteEnabled(true));
    expect(failed).toMatchObject({
      desiredEnabled: true,
      state: 'error',
      port: occupiedPort,
      errorCode: 'EADDRINUSE',
    });
    expect(await win.evaluate(() => window.ezterminal.getRemoteEnabled())).toBe(true);

    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
    const recovered = await win.evaluate(() => window.ezterminal.retryRemoteRuntime());
    expect(recovered).toMatchObject({ desiredEnabled: true, state: 'running', port: occupiedPort });
  } finally {
    if (blocker.listening) {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    await app.close();
  }
});

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
  // Remote control is OFF by default (opt-in, security review): the toggle
  // starts unchecked and nothing is listening yet.
  await expect(toggle).not.toBeChecked();

  // ── Enable → the bridge binds and accepts an authed client ─────────────────
  // A plain click, not locator.check(): the checkbox is React-controlled and
  // its onChange only flips state after an async IPC round trip (the real
  // bridge start/stop), so check()/uncheck()'s single immediate post-click
  // state check fails — expect(...).toBeChecked() polls until it settles.
  await toggle.click();
  await expect(toggle).toBeChecked();
  const client = await TestWsClient.connectAuthed(`ws://127.0.0.1:${REMOTE_PORT}`, token);

  try {
    // ── Toggle OFF ───────────────────────────────────────────────────────────
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // The already-connected client's socket must actually be terminated, not
    // just orphaned.
    await client.waitForClose();

    // A fresh connect attempt must be refused outright (port fully released
    // by the listener, not just no-longer-authenticating).
    const refused = new WebSocket(`ws://127.0.0.1:${REMOTE_PORT}`);
    const outcome = await new Promise<'error' | 'open'>((resolve) => {
      refused.once('error', () => resolve('error'));
      refused.once('open', () => resolve('open'));
    });
    expect(outcome).toBe('error');
    refused.removeAllListeners();

    // ── Toggle back ON ───────────────────────────────────────────────────────
    // A clean rebind of the SAME port — no EADDRINUSE from the just-stopped listener.
    await toggle.click();
    await expect(toggle).toBeChecked();

    const client2 = await TestWsClient.connectAuthed(`ws://127.0.0.1:${REMOTE_PORT}`, token);
    client2.close();
  } finally {
    client.close();
    await app.close();
  }
});
