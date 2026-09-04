import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRegisteredE2eTempDir, test, expect } from './test';

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
  return createRegisteredE2eTempDir('ezterm-openclaw-chat-e2e-');
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

async function chatViewHosts(
  app: import('@playwright/test').ElectronApplication,
): Promise<Array<{ url: string; viewIds: number[] }>> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((win) => {
    const hostContents = win.webContents;
    if (win.isDestroyed() || hostContents.isDestroyed()) return [];
    const viewIds = win.contentView.children.flatMap((child) => {
      const childContents = (child as Electron.WebContentsView).webContents;
      return childContents.isDestroyed() ? [] : [childContents.id];
    });
    return [{ url: hostContents.getURL(), viewIds }];
  }));
}

test('running: opening chat from the drawer auto-closes the drawer and shows exactly one correctly-addressed WebContentsView (AC2)', async () => {
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
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 10_000,
    });

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

    // (b) The [채팅 열기] button lives INSIDE the drawer, and the drawer feeds
    // the chat panel's z-order hide rule — so opening chat must AUTO-CLOSE the
    // drawer, otherwise the freshly-opened view stays force-hidden behind it
    // (the blank-panel bug: a user clicks 채팅 열기 and sees nothing). Assert
    // the drawer is gone and the native view is visible with NO manual close.
    await expect(window.getByTestId('openclaw-panel')).toHaveCount(0);
    await expect.poll(async () => (await chatViewInfo(app))[0]?.visible, { timeout: 10_000 }).toBe(true);
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-visible-on-open.png') });

    // The z-order defense itself still holds: re-opening the drawer OVER the
    // chat hides the native view again, and closing it restores it.
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect.poll(async () => (await chatViewInfo(app))[0]?.visible, { timeout: 10_000 }).toBe(false);
    // The single-sidebar workbench intentionally removes the drawer's duplicate
    // close button. The active rail destination is the canonical close control.
    await window.getByTestId('btn-toggle-openclaw').click();
    await expect.poll(async () => (await chatViewInfo(app))[0]?.visible, { timeout: 10_000 }).toBe(true);
  } finally {
    await app.close();
    await gateway.stop();
  }
});

test('detaching and redocking chat rehosts the same native WebContentsView', async () => {
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
    const main = await app.firstWindow();
    await main.getByTestId('btn-toggle-openclaw').click();
    await expect(main.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 10_000,
    });
    await main.getByTestId('btn-openclaw-open-chat').click();
    await expect(main.getByTestId('openclaw-chat-panel')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await chatViewHosts(app))
      .find((host) => !host.url.includes('ez-popout=1'))?.viewIds.length ?? 0).toBe(1);
    const originalViewId = (await chatViewHosts(app))
      .find((host) => !host.url.includes('ez-popout=1'))!.viewIds[0]!;

    const opened = await main.evaluate(async () => {
      type Panel = { id: string };
      type DockApi = {
        panels: Panel[];
        addPopoutGroup(panel: Panel): Promise<boolean>;
      };
      const api = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
      const panel = api?.panels.find((candidate) => candidate.id === 'openclaw-chat');
      if (!api || !panel) throw new Error('OpenClaw panel test seam missing');
      return api.addPopoutGroup(panel);
    });
    expect(opened).toBe(true);

    await expect.poll(async () => {
      const hosts = await chatViewHosts(app);
      const mainHost = hosts.find((host) => !host.url.includes('ez-popout=1'));
      const auxiliaryHost = hosts.find((host) => host.url.includes('ez-popout=1'));
      return {
        mainViews: mainHost?.viewIds.length ?? -1,
        auxiliaryViews: auxiliaryHost?.viewIds ?? [],
      };
    }, { timeout: 15_000 }).toEqual({ mainViews: 0, auxiliaryViews: [originalViewId] });

    await main.evaluate(() => {
      type DockApi = {
        getPopouts(): Array<{ group: { api: { moveTo(options: { position: 'right' }): void } } }>;
      };
      const api = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
      const popout = api?.getPopouts()[0];
      if (!popout) throw new Error('OpenClaw popout test seam missing');
      popout.group.api.moveTo({ position: 'right' });
    });

    await expect.poll(async () => {
      const hosts = await chatViewHosts(app);
      return {
        auxiliaryCount: hosts.filter((host) => host.url.includes('ez-popout=1')).length,
        mainViews: hosts.find((host) => !host.url.includes('ez-popout=1'))?.viewIds ?? [],
      };
    }, { timeout: 15_000 }).toEqual({ auxiliaryCount: 0, mainViews: [originalViewId] });
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
    await expect(w1.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'running', {
      timeout: 10_000,
    });
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
    await expect(window.getByTestId('openclaw-state')).toHaveAttribute('data-state', 'stopped', {
      timeout: 10_000,
    });

    await window.getByTestId('btn-openclaw-open-chat').click();
    await expect(window.getByTestId('openclaw-chat-guidance')).toBeVisible({ timeout: 10_000 });
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'chat-guidance-stopped.png') });

    expect(await chatViewInfo(app)).toHaveLength(0);
  } finally {
    await app.close();
    await gateway.stop();
  }
});
