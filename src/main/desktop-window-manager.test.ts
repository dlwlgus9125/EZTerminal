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
