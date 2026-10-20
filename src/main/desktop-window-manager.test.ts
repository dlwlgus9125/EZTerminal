import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  screen: {
    getDisplayMatching: () => ({ id: 1, scaleFactor: 1 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  shell: {},
}));

import type { BrowserWindow } from 'electron';
import { DesktopWindowManager } from './desktop-window-manager';
import { packagedRendererUrl } from '../shared/desktop-window';

function nativeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as BrowserWindow;
}

describe('DesktopWindowManager window-name resolution', () => {
  it('resolves only configured, live main and auxiliary hosts', () => {
    const main = nativeWindow();
    const auxiliary = nativeWindow();
    const destroyed = nativeWindow(true);
    const manager = Object.create(DesktopWindowManager.prototype) as DesktopWindowManager;
    const internals = manager as unknown as {
      windows: Set<BrowserWindow>;
      windowKinds: WeakMap<BrowserWindow, 'main' | 'auxiliary'>;
      auxiliaryNames: WeakMap<BrowserWindow, string>;
    };
    internals.windows = new Set([main, auxiliary, destroyed]);
    internals.windowKinds = new WeakMap([
      [main, 'main'],
      [auxiliary, 'auxiliary'],
      [destroyed, 'auxiliary'],
    ]);
    internals.auxiliaryNames = new WeakMap([
      [auxiliary, 'dockview-2'],
      [destroyed, 'stale-window'],
    ]);

    expect(manager.resolveWindowName('main')).toBe(main);
    expect(manager.resolveWindowName('dockview-2')).toBe(auxiliary);
    expect(manager.resolveWindowName('stale-window')).toBeNull();
    expect(manager.resolveWindowName('unknown')).toBeNull();
  });

  it('delegates main close policy unless an explicit app quit is already in progress', () => {
    const manager = Object.create(DesktopWindowManager.prototype) as DesktopWindowManager;
    let quitting = false;
    const handleMainWindowClose = vi.fn();
    const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
    const window = {
      on: vi.fn((event: string, listener: (value: { preventDefault: () => void }) => void) => {
        handlers.set(event, listener);
      }),
    } as unknown as BrowserWindow;
    const internals = manager as unknown as {
      options: {
        isAppQuitting: () => boolean;
        handleMainWindowClose: typeof handleMainWindowClose;
      };
      configureWindow: (window: BrowserWindow, kind: 'main') => void;
    };
    internals.options = { isAppQuitting: () => quitting, handleMainWindowClose };
    internals.configureWindow = vi.fn();
    manager.configureMainWindow(window);

    const preventDefault = vi.fn();
    handlers.get('close')?.({ preventDefault });
    expect(handleMainWindowClose).toHaveBeenCalledOnce();
    expect(handleMainWindowClose).toHaveBeenCalledWith(window, { preventDefault });

    quitting = true;
    preventDefault.mockClear();
    handleMainWindowClose.mockClear();
    handlers.get('close')?.({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(handleMainWindowClose).not.toHaveBeenCalled();
  });
});

function rendererWindow() {
  const state = { focused: true, visible: true, minimized: false, throttling: true };
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getBackgroundThrottling: () => state.throttling,
    setBackgroundThrottling: vi.fn((allowed: boolean) => { state.throttling = allowed; }),
  });
  const native = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isFocused: () => state.focused,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setMenuBarVisibility: vi.fn(),
    setAutoHideMenuBar: vi.fn(),
    setBounds: vi.fn(),
  });
  return { state, native, window: native as unknown as BrowserWindow };
}

describe('DesktopWindowManager native throttling transitions', () => {
  it('leaves the render-widget policy alone on focus changes and only changes it for visible popouts', () => {
    const main = rendererWindow();
    const auxiliary = rendererWindow();
    const manager = new DesktopWindowManager({
      auxiliaryRendererUrl: packagedRendererUrl(true),
      preloadPath: 'preload.js',
      isAllowedNavigation: () => true,
      getMainWindow: () => main.window,
      isAppQuitting: () => false,
      handleMainWindowClose: vi.fn(),
    });
    manager.configureMainWindow(main.window);
    for (let index = 0; index < 10; index++) {
      main.state.focused = false;
      main.native.emit('blur');
      main.state.focused = true;
      main.native.emit('focus');
    }
    expect(main.native.webContents.setBackgroundThrottling).not.toHaveBeenCalled();
    main.native.webContents.emit('did-create-window', auxiliary.window, {
      url: packagedRendererUrl(true), frameName: 'popout',
    });
    main.state.minimized = true;
    main.native.emit('minimize');
    expect(main.native.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
    auxiliary.state.focused = false;
    auxiliary.native.emit('blur');
    auxiliary.state.focused = true;
    auxiliary.native.emit('focus');
    expect(main.native.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
    auxiliary.state.visible = false;
    auxiliary.native.emit('hide');
    expect(main.native.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
    main.state.minimized = false;
    main.native.emit('restore');
    expect(main.native.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
  });
});

describe('DesktopWindowManager subframe navigation', () => {
  it('lets frames inside the app navigate only to isolated Results previews, and popouts get the PDF viewer', () => {
    const main = rendererWindow();
    const manager = new DesktopWindowManager({
      auxiliaryRendererUrl: packagedRendererUrl(true),
      preloadPath: 'preload.js',
      isAllowedNavigation: () => true,
      getMainWindow: () => main.window,
      isAppQuitting: () => false,
      handleMainWindowClose: vi.fn(),
    });
    manager.configureMainWindow(main.window);
    const navigate = (url: string, isMainFrame = false) => {
      const event = { url, isMainFrame, preventDefault: vi.fn() };
      main.native.webContents.emit('will-frame-navigate', event);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(navigate('ezartifact://0123456789abcdef0123456789abcdef/report.html')).toBe(false);
    expect(navigate('about:blank')).toBe(false);
    expect(navigate('https://attacker.example/')).toBe(true);
    expect(navigate('file:///C:/Windows/win.ini')).toBe(true);
    // The main frame keeps its own will-navigate policy.
    expect(navigate('https://attacker.example/', true)).toBe(false);

    const handler = vi.mocked(main.native.webContents.setWindowOpenHandler).mock.calls[0]![0] as (details: { url: string }) => {
      overrideBrowserWindowOptions?: { webPreferences?: { plugins?: boolean; sandbox?: boolean } };
    };
    const popout = handler({ url: packagedRendererUrl(true) });
    expect(popout.overrideBrowserWindowOptions?.webPreferences).toMatchObject({ plugins: true, sandbox: true });
  });
});
