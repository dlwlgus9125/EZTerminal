import { BrowserWindow } from 'electron';
import { type OpenClawMode } from '../shared/layout-schema';
import {
  isOpenClawChatSurfaceSnapshot,
  type OpenClawAutostartAction,
  type OpenClawControlSnapshot,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleReceipt,
  type OpenClawVisibility,
} from '../shared/openclaw';
import { DesktopWindowManager } from './desktop-window-manager';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { LayoutStore } from './layout-store';
import { OpenClawChatSurfaceRevisionGate } from './openclaw-chat-surface-revisions';
import { OpenClawChatViewManager } from './openclaw-chat-view';
import { OpenClawService } from './openclaw-service';
import { resolveOpenClawVisibility } from './openclaw-visibility';

interface InstallOpenClawManagementIpcOptions {
  readonly ipc: FeatureIpc;
  readonly openclaw: OpenClawService;
  readonly getOpenClawControl: (force?: boolean) => Promise<OpenClawControlSnapshot>;
  readonly requestOpenClawLifecycle: (action: OpenClawLifecycleAction) => Promise<OpenClawLifecycleReceipt>;
}

export function installOpenClawManagementIpc(dependencies: InstallOpenClawManagementIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('openclaw:get-status', (_event, force?: boolean) => dependencies.openclaw.getStatus(force));
    ipcMain.handle('openclaw:get-control', (_event, force?: boolean) => dependencies.getOpenClawControl(force));
    ipcMain.handle('openclaw:lifecycle', (_event, action: OpenClawLifecycleAction) => dependencies.requestOpenClawLifecycle(action));
    ipcMain.handle('openclaw:list-sessions', () => dependencies.openclaw.listAgentSessions());
    ipcMain.handle('openclaw:get-config', () => dependencies.openclaw.getCoreConfig());
    ipcMain.handle('openclaw:set-config', (_event, key: string, value: string) => dependencies.openclaw.setCoreConfig(key, value));
    ipcMain.handle('openclaw:chat-available', async () => (await dependencies.openclaw.getChatToken()) !== null);
    // autostart (openclaw-management #9) — `gateway install|uninstall`, serialized
    // on the same CLI lane as start/stop/restart (see OpenClawService.runAutostart).
    ipcMain.handle('openclaw:autostart', (_event, action: OpenClawAutostartAction) => dependencies.openclaw.runAutostart(action));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallOpenClawVisibilityIpcOptions {
  readonly ipc: FeatureIpc;
  readonly storeReady: Promise<void>;
  readonly layoutStore: LayoutStore;
  readonly applyOpenClawVisibility: (visibility: OpenClawVisibility) => void;
  readonly openclaw: OpenClawService;
}

export function installOpenClawVisibilityIpc(dependencies: InstallOpenClawVisibilityIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('settings:get-openclaw-mode', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getOpenClawMode();
    });
    ipcMain.handle('settings:set-openclaw-mode', async (_event, mode: OpenClawMode) => {
      if (mode !== 'auto' && mode !== 'on' && mode !== 'off') return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setOpenClawMode(mode);
      dependencies.applyOpenClawVisibility({
        mode,
        visible: await resolveOpenClawVisibility(mode, () => dependencies.openclaw.isInstalled()),
      });
    });
    ipcMain.handle('openclaw:get-visibility', async (): Promise<OpenClawVisibility> => {
      await dependencies.storeReady;
      const mode = await dependencies.layoutStore.getOpenClawMode();
      return { mode, visible: await resolveOpenClawVisibility(mode, () => dependencies.openclaw.isInstalled()) };
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallOpenClawChatIpcOptions {
  readonly ipc: FeatureIpc;
  readonly openClawChatView: OpenClawChatViewManager | null;
  readonly mainWindowRef: BrowserWindow | null;
  readonly desktopWindowManager: DesktopWindowManager | null;
  readonly openclaw: OpenClawService;
  readonly openExternalForUser: (url: string) => Promise<void>;
}

export function installOpenClawChatIpc(dependencies: InstallOpenClawChatIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.on('openclaw:chat-open', () => {
      void dependencies.openClawChatView?.ensureView();
    });
    const openClawChatSurfaceRevisions = new OpenClawChatSurfaceRevisionGate();
    ipcMain.on('openclaw:chat-surface', (event, surface: unknown) => {
      const mainWindow = dependencies.mainWindowRef;
      if (
        !mainWindow
        || mainWindow.isDestroyed()
        || event.sender !== mainWindow.webContents
        || !isOpenClawChatSurfaceSnapshot(surface)
      ) return;
      const host = surface.mounted
        ? dependencies.desktopWindowManager?.resolveWindowName(surface.windowName)
        : null;
      if (surface.mounted && !host) return;
      if (!openClawChatSurfaceRevisions.accept(surface)) return;
      if (!surface.mounted) {
        dependencies.openClawChatView?.destroy();
        return;
      }
      if (!host) return;
      dependencies.openClawChatView?.updateSurface(host, surface);
    });
    ipcMain.on('openclaw:chat-reload', () => {
      void dependencies.openClawChatView?.reload();
    });
    // "브라우저로 열기" escape hatch (openclaw-stabilization M6) — resolves the
    // SAME token'd chat URL the embedded view uses and hands it to the OS
    // default browser instead, for when the WebContentsView embed misbehaves.
    ipcMain.handle('openclaw:chat-open-external', async (): Promise<boolean> => {
      const url = await dependencies.openclaw.getChatUrl();
      if (!url) return false;
      try {
        await dependencies.openExternalForUser(url);
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
