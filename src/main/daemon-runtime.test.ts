import { describe, expect, it, vi } from 'vitest';

import { DaemonLifecycleSettingsController } from './daemon-lifecycle-settings';
import { DaemonRuntime, type DaemonMainWindow } from './daemon-runtime';

function harness(initial = { keepRunning: false, startAtLogin: false }) {
  let persisted = { ...initial };
  let loginEnabled = initial.startAtLogin;
  const settings = new DaemonLifecycleSettingsController({
    store: {
      read: async () => persisted,
      write: async (next) => { persisted = { ...next }; },
    },
    loginItem: {
      readEnabled: () => loginEnabled,
      writeEnabled: (enabled) => { loginEnabled = enabled; },
    },
  });
  const window = {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
  } satisfies DaemonMainWindow;
  const processes = { stopAll: vi.fn(async () => undefined) };
  const requestAppQuit = vi.fn();
  const runtime = new DaemonRuntime({
    settings,
    processes,
    getMainWindow: () => window,
    createMainWindow: () => window,
    requestAppQuit,
  });
  return { runtime, settings, window, processes, requestAppQuit };
}

describe('DaemonRuntime window lifecycle', () => {
  it('turns the default native close into an orderly application Quit', async () => {
    const h = harness();
    await h.runtime.initialize();
    const event = { preventDefault: vi.fn() };

    h.runtime.handleMainWindowClose(event, h.window);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.requestAppQuit).toHaveBeenCalledOnce();
    expect(h.window.hide).not.toHaveBeenCalled();
  });

  it('hides the main window only when keep-running is enabled', async () => {
    const h = harness({ keepRunning: true, startAtLogin: false });
    await h.runtime.initialize();
    const event = { preventDefault: vi.fn() };

    h.runtime.handleMainWindowClose(event, h.window);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.window.hide).toHaveBeenCalledOnce();
    expect(h.requestAppQuit).not.toHaveBeenCalled();
  });

  it('explicit Quit ignores keep-running and drains process ownership once', async () => {
    const h = harness({ keepRunning: true, startAtLogin: true });
    await h.runtime.initialize();

    h.runtime.requestExplicitQuit();
    h.runtime.requestExplicitQuit();
    await Promise.all([h.runtime.shutdown(), h.runtime.shutdown()]);

    expect(h.requestAppQuit).toHaveBeenCalledTimes(2);
    expect(h.processes.stopAll).toHaveBeenCalledOnce();
    expect(h.processes.stopAll).toHaveBeenCalledWith('app-quit');
  });
});
