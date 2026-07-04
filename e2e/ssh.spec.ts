import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server, utils as ssh2Utils } from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';

import { launchApp } from './launch-app';

// E5: `ssh-connect` — hermetic e2e against a REAL ssh2 `Server` on 127.0.0.1
// (design §5 / gate B4): no system sshd, no network, no real credentials.
// Scenarios: ① password prompt -> typed round-trip through the remote shell
// ② TOFU accept persists to known_hosts.json -> a relaunch with the same
// userData does not re-prompt ③ a rotated host key hard-fails with old/new
// fingerprints ④ cancelling while a prompt is outstanding settles `cancelled`.

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-ssh-e2e-'));
}

/** Concatenated text currently rendered in the xterm grid (mirrors pty.spec.ts). */
async function terminalText(window: Page): Promise<string> {
  return window.locator('.pty-block .xterm-rows').innerText();
}

const HOST_KEY_A = ssh2Utils.generateKeyPairSync('ed25519', {}).private;
const HOST_KEY_B = ssh2Utils.generateKeyPairSync('ed25519', {}).private; // deliberately DIFFERENT — for the rotation test

interface TestServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Start a throwaway ssh2 Server: accepts the given password (any username),
 * allocates a pty, and echoes shell input as `ECHO:<input>` by default. */
function startTestServer(opts: { hostKey?: string; password: string; port?: number }): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = new Server({ hostKeys: [opts.hostKey ?? HOST_KEY_A] }, (client: Connection) => {
      // The rotation test deliberately makes the CLIENT reject the (changed) host
      // key mid-KEX; from the server's side that surfaces as a 'error' on this
      // Connection (e.g. KEY_EXCHANGE_FAILED). An EventEmitter 'error' with no
      // listener crashes the whole Node process — swallow it, it's expected here.
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === opts.password) ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) => {
            const channel: ServerChannel = acceptShell();
            // Buffer to a line before echoing (a real interactive shell only
            // acts once Enter is pressed) — `keyboard.type()` sends one
            // keystroke per SSH data chunk, so echoing per-chunk would never
            // produce the contiguous "ECHO:<line>" substring the tests assert.
            let lineBuffer = '';
            channel.on('data', (data: Buffer) => {
              lineBuffer += data.toString('utf8');
              const nl = lineBuffer.indexOf('\r');
              if (nl === -1) return;
              const line = lineBuffer.slice(0, nl);
              lineBuffer = lineBuffer.slice(nl + 1);
              channel.write(`ECHO:${line}\r\n`);
            });
          });
        });
      });
    });
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('server failed to bind to a port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test('ssh-connect: password prompt, then typed input round-trips through the remote shell', async () => {
  const testServer = await startTestServer({ password: 'sekrit' });
  try {
    const app = await launchApp();
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await window.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${testServer.port}`);
    await window.getByTestId('btn-run').click();

    // A fresh (random) userData dir means this host is unknown — TOFU fires
    // FIRST (host verification precedes authentication), then the password prompt.
    await expect(window.getByTestId('ssh-prompt-accept')).toBeVisible({ timeout: 15_000 });
    await window.getByTestId('ssh-prompt-accept').click();

    await expect(window.getByTestId('ssh-prompt-input')).toBeVisible({ timeout: 15_000 });
    await window.getByTestId('ssh-prompt-input').fill('sekrit');
    await window.getByTestId('ssh-prompt-submit').click();

    const ptyBlock = window.getByTestId('pty-block');
    await expect(ptyBlock).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('ssh-prompt')).toHaveCount(0);

    await ptyBlock.click();
    await window.keyboard.type('hello-ssh');
    await window.keyboard.press('Enter');
    await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ECHO:hello-ssh');

    await app.close();
  } finally {
    await testServer.close();
  }
});

test('ssh-connect: TOFU accept persists — a relaunch with the same userData does not re-prompt for the host key', async () => {
  const testServer = await startTestServer({ password: 'sekrit' });
  const userDataDir = tempUserData();
  try {
    const app1 = await launchApp(userDataDir);
    const w1 = await app1.firstWindow();
    await expect(w1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await w1.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${testServer.port}`);
    await w1.getByTestId('btn-run').click();

    // Unknown host on first contact: TOFU fingerprint prompt, then Accept.
    await expect(w1.getByTestId('ssh-prompt-fingerprint')).toBeVisible({ timeout: 15_000 });
    await w1.getByTestId('ssh-prompt-accept').click();

    await expect(w1.getByTestId('ssh-prompt-input')).toBeVisible({ timeout: 15_000 });
    await w1.getByTestId('ssh-prompt-input').fill('sekrit');
    await w1.getByTestId('ssh-prompt-submit').click();
    await expect(w1.getByTestId('pty-block')).toBeVisible({ timeout: 15_000 });

    await app1.close();

    // Second launch, SAME userData dir: known_hosts.json persisted the key —
    // straight to the password prompt, no host-key confirmation this time.
    const app2 = await launchApp(userDataDir);
    const w2 = await app2.firstWindow();
    await expect(w2.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await w2.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${testServer.port}`);
    await w2.getByTestId('btn-run').click();

    await expect(w2.getByTestId('ssh-prompt-input')).toBeVisible({ timeout: 15_000 });
    await expect(w2.getByTestId('ssh-prompt-fingerprint')).toHaveCount(0);
    await w2.getByTestId('ssh-prompt-input').fill('sekrit');
    await w2.getByTestId('ssh-prompt-submit').click();
    await expect(w2.getByTestId('pty-block')).toBeVisible({ timeout: 15_000 });

    await app2.close();
  } finally {
    await testServer.close();
  }
});

test('ssh-connect: a rotated host key hard-fails with the old and new fingerprints', async () => {
  const userDataDir = tempUserData();
  const firstServer = await startTestServer({ hostKey: HOST_KEY_A, password: 'sekrit' });
  try {
    const app1 = await launchApp(userDataDir);
    const w1 = await app1.firstWindow();
    await expect(w1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await w1.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${firstServer.port}`);
    await w1.getByTestId('btn-run').click();
    await expect(w1.getByTestId('ssh-prompt-accept')).toBeVisible({ timeout: 15_000 });
    await w1.getByTestId('ssh-prompt-accept').click();
    await expect(w1.getByTestId('ssh-prompt-input')).toBeVisible({ timeout: 15_000 });
    await w1.getByTestId('ssh-prompt-input').fill('sekrit');
    await w1.getByTestId('ssh-prompt-submit').click();
    await expect(w1.getByTestId('pty-block')).toBeVisible({ timeout: 15_000 });

    await app1.close();
  } finally {
    await firstServer.close();
  }

  // A second server on the SAME port with a DIFFERENT host key — simulates a
  // reinstalled host / key rotation (or a MITM, which is exactly why this must
  // hard-fail rather than silently re-prompt).
  const rotatedServer = await startTestServer({ hostKey: HOST_KEY_B, password: 'sekrit', port: firstServer.port });
  try {
    const app2 = await launchApp(userDataDir);
    const w2 = await app2.firstWindow();
    await expect(w2.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await w2.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${rotatedServer.port}`);
    await w2.getByTestId('btn-run').click();

    await expect(w2.getByTestId('block-status')).toHaveText('error', { timeout: 15_000 });
    const errorText = await w2.getByTestId('block-error').innerText();
    expect(errorText).toMatch(/mismatch|changed/i);
    expect(errorText).toContain('known_hosts.json');
    // No prompt should ever appear for a rejected/rotated host key.
    await expect(w2.getByTestId('ssh-prompt')).toHaveCount(0);

    await app2.close();
  } finally {
    await rotatedServer.close();
  }
});

test('ssh-connect: cancelling while a prompt is outstanding settles cancelled', async () => {
  const testServer = await startTestServer({ password: 'sekrit' });
  try {
    const app = await launchApp();
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await window.getByTestId('cmd-input').fill(`ssh-connect tester@127.0.0.1 --port ${testServer.port}`);
    await window.getByTestId('btn-run').click();

    await expect(window.getByTestId('ssh-prompt')).toBeVisible({ timeout: 15_000 });
    await window.getByTestId('block-cancel').click();
    await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
    await expect(window.getByTestId('ssh-prompt')).toHaveCount(0);

    await app.close();
  } finally {
    await testServer.close();
  }
});
