import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';
import {
  buildFixtureState,
  startFakeGateway,
  writeFakeCliShim,
  writeFixtureFiles,
  type FakeGatewayHandle,
} from './fixtures/openclaw-fixtures';

// openclaw-management M3: the desktop 'openclaw-chat' singleton dockview panel
// + the main-owned WebContentsView it drives (App.tsx's openOpenClawChat,
// OpenClawChatPanel.tsx's placeholder, main.ts's openclaw:chat-* IPC arms,
// openclaw-chat-view.ts's OpenClawChatViewManager). Reuses the SAME fake
// gateway/CLI fixtures as openclaw-panel.spec.ts (fake-openclaw-gateway.mjs
// already serves the real anti-embed headers + "OpenClaw Control" title) —
// the real gateway that may be running on this machine at 127.0.0.1:18789 is
// never dialed or perturbed.

const SCREENSHOT_DIR = path.join(
  process.env.TEMP ?? process.env.TMP ?? '.',
  'claude',
  'ezterminal-openclaw-chat-screenshots',
);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-chat-e2e-'));
}

/** WebContentsView children of the (single) main window, as reported by the
 * main process — the placeholder panel never renders chat content itself, so
 * this is the only way to observe whether the embed exists/what it loaded. */
async function chatViewInfo(
  app: import('@playwright/test').ElectronApplication,
): Promise<Array<{ url: string; title: string; visible: boolean }>> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.contentView.children.map((child) => {
      const view = child as Electron.WebContentsView;
      return { url: view.webContents.getURL(), title: view.webContents.getTitle(), visible: view.getVisible() };
    });
  });
}

test('running: chat panel opens exactly one correctly-addressed WebContentsView, hidden behind the drawer, shown once closed (AC2)', async () => {
  const state = buildFixtureState({ running: true });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toContainText('실행 중', { timeout: 10_000 });

    await window.getByTestId('btn-openclaw-open-chat').click();
    await expect(window.getByTestId('openclaw-chat-panel')).toBeVisible({ timeout: 10_000 });

    // The view is created lazily once the panel observes status==='running',
    // then navigates async — poll until the load has actually landed.
    await expect
      .poll(async () => (await chatViewInfo(app))[0]?.url ?? '', { timeout: 10_000 })
      .toContain('#token=e2e-fake-token');
    const [view] = await chatViewInfo(app);
    expect(await chatViewInfo(app)).toHaveLength(1);
    expect(view.url.startsWith(`http://127.0.0.1:${gateway.port}`)).toBe(true);
    expect(view.title).toBe('OpenClaw Control');

    // (b) The drawer is still open from clicking the chat button above — it
    // sits above the dockview area, so the native view must be force-hidden
    // (architecture decision (a)'s z-order rule) even though the panel itself
    // reports isVisible from dockview's point of view.
    await expect.poll(async () => (await chatViewInfo(app))[0]?.visible).toBe(false);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-drawer-open-hidden.png') });

    await window.getByTestId('openclaw-close').click();
    await expect.poll(async () => (await chatViewInfo(app))[0]?.visible, { timeout: 10_000 }).toBe(true);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-drawer-closed-visible.png') });
  } finally {
    await app.close();
    await gateway.stop();
  }
});

test('persistence round-trip: the chat panel restores after relaunch and re-requests its view (AC2)', async () => {
  const dir = tempUserData();
  const state = buildFixtureState({ running: true });
  const { dir: fixtureDir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(fixtureDir);
  const gateway: FakeGatewayHandle = await startFakeGateway(statePath);
  const extraEnv = {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  };

  try {
    const app1 = await launchApp(dir, extraEnv);
    const w1 = await app1.firstWindow();
    await w1.getByTestId('btn-toggle-openclaw').click();
    await expect(w1.getByTestId('openclaw-state')).toContainText('실행 중', { timeout: 10_000 });
    await w1.getByTestId('btn-openclaw-open-chat').click();
    await expect(w1.getByTestId('openclaw-chat-panel')).toBeVisible({ timeout: 10_000 });

    await w1.evaluate(() => {
      const seam = globalThis as unknown as { __ezLayoutFlush?: () => Promise<void> };
      if (!seam.__ezLayoutFlush) throw new Error('__ezLayoutFlush seam missing');
      return seam.__ezLayoutFlush();
    });
    await app1.close();

    // ── relaunch: same userData dir, same fixture gateway/CLI still alive ──
    const app2 = await launchApp(dir, extraEnv);
    const w2 = await app2.firstWindow();
    await expect(w2.getByTestId('openclaw-chat-panel')).toBeVisible({ timeout: 15_000 });

    // Restored + visible + status running -> re-requests the view on its own,
    // with no user interaction needed this run.
    await expect
      .poll(async () => (await chatViewInfo(app2)).length, { timeout: 10_000 })
      .toBe(1);
    await w2.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-restored-after-relaunch.png') });
    await app2.close();
  } finally {
    await gateway.stop();
  }
});

test('stopped: chat panel shows guidance placeholder, no WebContentsView is ever created (AC6)', async () => {
  const state = buildFixtureState({ running: false });
  const { dir, statePath, configPath } = writeFixtureFiles(state);
  const cliShim = writeFakeCliShim(dir);
  const gateway = await startFakeGateway(statePath);

  const app = await launchApp(undefined, {
    EZTERMINAL_OPENCLAW_CLI: cliShim,
    EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${gateway.port}`,
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
    EZTERM_E2E_OPENCLAW_STATE: statePath,
  });
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect(window.getByTestId('openclaw-state')).toContainText('중지됨', { timeout: 10_000 });

    await window.getByTestId('btn-openclaw-open-chat').click();
    await expect(window.getByTestId('openclaw-chat-guidance')).toBeVisible({ timeout: 10_000 });
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-guidance-stopped.png') });

    expect(await chatViewInfo(app)).toHaveLength(0);
  } finally {
    await app.close();
    await gateway.stop();
  }
});
