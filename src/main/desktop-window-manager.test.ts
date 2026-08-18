import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: {},
  screen: {},
  shell: {},
}));

import type { BrowserWindow } from 'electron';
import { DesktopWindowManager } from './desktop-window-manager';

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

  it('hides the main window on close unless an explicit app quit is already in progress', () => {
    const manager = Object.create(DesktopWindowManager.prototype) as DesktopWindowManager;
    let quitting = false;
    const quitApp = vi.fn();
    const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
    const hide = vi.fn();
    const window = {
      on: vi.fn((event: string, listener: (value: { preventDefault: () => void }) => void) => {
        handlers.set(event, listener);
      }),
      hide,
    } as unknown as BrowserWindow;
    const internals = manager as unknown as {
      options: {
        isAppQuitting: () => boolean;
        quitApp: () => void;
      };
      configureWindow: (window: BrowserWindow, kind: 'main') => void;
    };
    internals.options = { isAppQuitting: () => quitting, quitApp };
    internals.configureWindow = vi.fn();
    manager.configureMainWindow(window);

    const preventDefault = vi.fn();
    handlers.get('close')?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    expect(quitApp).not.toHaveBeenCalled();

    quitting = true;
    preventDefault.mockClear();
    hide.mockClear();
    handlers.get('close')?.({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
});
