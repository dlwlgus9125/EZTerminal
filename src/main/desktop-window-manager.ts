import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type DidCreateWindowDetails,
  type Event as ElectronEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

import {
  isAuxiliaryCloseResolution,
  isDesktopWindowAction,
  type AuxiliaryCloseRequest,
  type DesktopWindowKind,
  type DesktopWindowState,
} from '../shared/desktop-window';
import { normalizeExternalHttpUrl } from '../shared/external-url';
import { isAuxiliaryRendererUrl } from './app-renderer-protocol';
import {
  AUXILIARY_WINDOW_MIN_HEIGHT,
  AUXILIARY_WINDOW_MIN_WIDTH,
  clampWindowBounds,
} from './window-bounds';

const DEFAULT_LAYOUT_FLUSH_TIMEOUT_MS = 1_500;

interface PendingAuxiliaryClose {
  readonly request: AuxiliaryCloseRequest;
  readonly window: BrowserWindow;
}

interface PendingLayoutFlush {
  readonly sender: WebContents;
  readonly finish: () => void;
}

export interface DesktopWindowManagerOptions {
  readonly auxiliaryRendererUrl: string;
  readonly preloadPath: string;
  readonly isAllowedNavigation: (url: string) => boolean;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly isAppQuitting: () => boolean;
  readonly quitApp: () => void;
  readonly onWindowConfigured?: (
    window: BrowserWindow,
    kind: DesktopWindowKind,
  ) => void;
  readonly reportError?: (context: string, error: unknown) => void;
}

/**
 * Owns frameless native-window behavior without exposing BrowserWindow ids to
 * the renderer. Dockview still owns panel movement and popout DOM lifetimes.
 */
export class DesktopWindowManager {
  private readonly configuredWindows = new WeakSet<BrowserWindow>();
  private readonly windowKinds = new WeakMap<BrowserWindow, DesktopWindowKind>();
  private readonly auxiliaryNames = new WeakMap<BrowserWindow, string>();
  private readonly approvedAuxiliaryCloses = new WeakSet<BrowserWindow>();
  private readonly pendingAuxiliaryByWindow = new Map<BrowserWindow, PendingAuxiliaryClose>();
  private readonly pendingAuxiliaryById = new Map<string, PendingAuxiliaryClose>();
  private readonly pendingLayoutFlushes = new Map<string, PendingLayoutFlush>();

  public constructor(private readonly options: DesktopWindowManagerOptions) {
    this.installIpc();
  }

  public configureMainWindow(window: BrowserWindow): void {
    this.configureWindow(window, 'main');
    window.on('close', (event) => {
      if (this.options.isAppQuitting()) return;
      event.preventDefault();
      this.options.quitApp();
    });
  }

  public async requestLayoutFlush(
    timeoutMs = DEFAULT_LAYOUT_FLUSH_TIMEOUT_MS,
  ): Promise<void> {
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;

    const requestId = randomUUID();
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pendingLayoutFlushes.delete(requestId);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, timeoutMs));
      this.pendingLayoutFlushes.set(requestId, {
        sender: mainWindow.webContents,
        finish,
      });
      mainWindow.webContents.send('desktop-window:flush-layout', requestId);
    });
  }

  private installIpc(): void {
    ipcMain.handle('desktop-window:get-state', (event) => {
      const window = this.resolveConfiguredSender(event);
      return window ? this.windowState(window) : null;
    });
    ipcMain.handle('desktop-window:perform-action', (event, action: unknown) => {
      const window = this.resolveConfiguredSender(event);
      if (!window || !isDesktopWindowAction(action)) return;
      if (action === 'minimize') {
        window.minimize();
      } else if (action === 'toggle-maximize') {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      } else if (this.windowKinds.get(window) === 'main') {
        this.options.quitApp();
      } else {
        window.close();
      }
    });
    ipcMain.handle(
      'desktop-window:resolve-aux-close',
      (event, requestId: unknown, resolution: unknown) => {
        const mainWindow = this.options.getMainWindow();
        if (
          !mainWindow
          || event.sender !== mainWindow.webContents
          || typeof requestId !== 'string'
          || !isAuxiliaryCloseResolution(resolution)
        ) {
          return;
        }
        const pending = this.pendingAuxiliaryById.get(requestId);
        if (!pending) return;
        this.clearPendingAuxiliaryClose(pending);
        if (resolution === 'cancel' || pending.window.isDestroyed()) return;
        this.approvedAuxiliaryCloses.add(pending.window);
        pending.window.close();
      },
    );
    ipcMain.on('desktop-window:layout-flushed', (event, requestId: unknown) => {
      if (typeof requestId !== 'string') return;
      const pending = this.pendingLayoutFlushes.get(requestId);
      if (!pending || pending.sender !== event.sender) return;
      pending.finish();
    });
  }

  private resolveConfiguredSender(event: IpcMainInvokeEvent): BrowserWindow | null {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !this.windowKinds.has(window) || window.isDestroyed()) return null;
    return window;
  }

  private configureWindow(window: BrowserWindow, kind: DesktopWindowKind, name?: string): void {
    if (this.configuredWindows.has(window)) return;
    this.configuredWindows.add(window);
    this.windowKinds.set(window, kind);
    if (name) this.auxiliaryNames.set(window, name);
    window.setMenuBarVisibility(false);
    window.setAutoHideMenuBar(true);
    this.options.onWindowConfigured?.(window, kind);

    const sendState = (): void => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('desktop-window:state-changed', this.windowState(window));
      }
    };
    window.on('maximize', sendState);
    window.on('unmaximize', sendState);
    window.on('enter-full-screen', sendState);
    window.on('leave-full-screen', sendState);

    window.webContents.on('will-navigate', (event, url) => {
      if (!this.options.isAllowedNavigation(url)) event.preventDefault();
    });
    this.configureWindowOpen(window);

    if (kind === 'auxiliary') {
      const display = screen.getDisplayNearestPoint({
        x: window.getBounds().x + Math.round(window.getBounds().width / 2),
        y: window.getBounds().y + Math.round(window.getBounds().height / 2),
      });
      window.setBounds(clampWindowBounds(window.getBounds(), display.workArea), false);
      window.on('close', (event) => this.handleAuxiliaryClose(window, event));
    }

    window.on('closed', () => {
      const pending = this.pendingAuxiliaryByWindow.get(window);
      if (pending) this.clearPendingAuxiliaryClose(pending);
    });
  }

  private configureWindowOpen(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAuxiliaryRendererUrl(url, this.options.auxiliaryRendererUrl)) {
        const overrideBrowserWindowOptions: BrowserWindowConstructorOptions = {
          minWidth: AUXILIARY_WINDOW_MIN_WIDTH,
          minHeight: AUXILIARY_WINDOW_MIN_HEIGHT,
          frame: false,
          autoHideMenuBar: true,
          backgroundColor: '#0c0c0c',
          title: 'EZTerminal',
          webPreferences: {
            preload: this.options.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            navigateOnDragDrop: false,
          },
        };
        return {
          action: 'allow' as const,
          outlivesOpener: false,
          overrideBrowserWindowOptions,
        };
      }
      const external = normalizeExternalHttpUrl(url);
      if (external) void shell.openExternal(external);
      return { action: 'deny' as const };
    });
    window.webContents.on(
      'did-create-window',
      (childWindow: BrowserWindow, details: DidCreateWindowDetails) => {
        if (!isAuxiliaryRendererUrl(details.url, this.options.auxiliaryRendererUrl)) {
          childWindow.destroy();
          return;
        }
        this.configureWindow(childWindow, 'auxiliary', details.frameName);
      },
    );
  }

  private handleAuxiliaryClose(window: BrowserWindow, event: ElectronEvent): void {
    if (this.options.isAppQuitting() || this.approvedAuxiliaryCloses.has(window)) return;
    event.preventDefault();
    if (this.pendingAuxiliaryByWindow.has(window)) return;

    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const request: AuxiliaryCloseRequest = {
      requestId: randomUUID(),
      windowName: this.auxiliaryNames.get(window) ?? '',
    };
    const pending = { request, window };
    this.pendingAuxiliaryByWindow.set(window, pending);
    this.pendingAuxiliaryById.set(request.requestId, pending);
    mainWindow.webContents.send('desktop-window:aux-close-requested', request);
  }

  private clearPendingAuxiliaryClose(pending: PendingAuxiliaryClose): void {
    if (this.pendingAuxiliaryByWindow.get(pending.window) === pending) {
      this.pendingAuxiliaryByWindow.delete(pending.window);
    }
    if (this.pendingAuxiliaryById.get(pending.request.requestId) === pending) {
      this.pendingAuxiliaryById.delete(pending.request.requestId);
    }
  }

  private windowState(window: BrowserWindow): DesktopWindowState {
    return {
      kind: this.windowKinds.get(window) ?? 'auxiliary',
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    };
  }
}
