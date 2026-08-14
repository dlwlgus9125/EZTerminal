import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type WindowOpenHandler = (details: { url: string }) => { action: 'deny' };

  const loadURL = vi.fn<(url: string) => Promise<void>>();
  const openExternal = vi.fn<(url: string) => Promise<void>>();
  const instances: MockWebContentsView[] = [];
  const behavior = { failViewSetup: false, loadingMainFrame: true };

  class MockWebContents {
    readonly close = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    readonly isLoadingMainFrame = vi.fn(() => behavior.loadingMainFrame);
    readonly reload = vi.fn();
    readonly setWindowOpenHandler = vi.fn<(handler: WindowOpenHandler) => void>(() => {
      if (behavior.failViewSetup) throw new Error('view setup failed');
    });
    private readonly listeners = new Map<string, Listener[]>();

    readonly loadURL = loadURL;

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class MockWebContentsView {
    readonly webContents = new MockWebContents();
    readonly setBounds = vi.fn();
    readonly setVisible = vi.fn();

    constructor() {
      instances.push(this);
    }
  }

  return {
    instances,
    behavior,
    loadURL,
    openExternal,
    MockWebContentsView,
  };
});

vi.mock('electron', () => ({
  shell: { openExternal: electronMocks.openExternal },
  WebContentsView: electronMocks.MockWebContentsView,
}));

import type { BrowserWindow } from 'electron';

import { OpenClawChatViewManager } from './openclaw-chat-view';

function makeWindow(): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  } as unknown as BrowserWindow;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  electronMocks.instances.length = 0;
  electronMocks.behavior.failViewSetup = false;
  electronMocks.behavior.loadingMainFrame = true;
  electronMocks.loadURL.mockReset();
  electronMocks.loadURL.mockResolvedValue(undefined);
  electronMocks.openExternal.mockReset();
  electronMocks.openExternal.mockResolvedValue(undefined);
});

describe('OpenClawChatViewManager fail-closed visibility', () => {
  it('rehosts the same native view when the dock panel moves to another window', async () => {
    const main = makeWindow();
    const auxiliary = makeWindow();
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      onStateChange: vi.fn(),
    });
    manager.attach(main);
    await manager.ensureView();
    const view = electronMocks.instances[0]!;

    manager.updateSurface(auxiliary, {
      surfaceId: 'openclaw-chat',
      instanceId: '00000000-0000-4000-8000-000000000001',
      revision: 2,
      mounted: true,
      windowName: 'dockview-2',
      bounds: { x: 12, y: 34, width: 640, height: 480 },
      visible: true,
    });

    expect(main.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(auxiliary.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 12, y: 34, width: 640, height: 480 });
    expect(electronMocks.instances).toHaveLength(1);
  });

  it('routes external window opens through the injected out-of-job handoff', async () => {
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      openExternal,
      onStateChange: vi.fn(),
    });
    manager.attach(makeWindow());
    await manager.ensureView();

    const handler = electronMocks.instances[0]!.webContents.setWindowOpenHandler.mock.calls[0]![0];
    expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    await flushMicrotasks();

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(electronMocks.openExternal).not.toHaveBeenCalled();
  });

  it('hides the native view while its main-frame navigation is loading', async () => {
    let resolveLoad!: () => void;
    const pendingLoad = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    electronMocks.loadURL.mockReturnValue(pendingLoad);
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    const opening = manager.ensureView();
    await flushMicrotasks();
    const view = electronMocks.instances[0];
    expect(view).toBeDefined();

    view!.webContents.emit('did-start-loading');

    expect(states.at(-1)).toEqual({ hasError: false, loading: true });
    expect(view!.setVisible).toHaveBeenLastCalledWith(false);

    view!.webContents.emit('did-finish-load');
    resolveLoad();
    await opening;
  });

  it('keeps the loaded native view visible during a later subresource loading cycle', async () => {
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    await manager.ensureView();
    const view = electronMocks.instances[0]!;
    view.webContents.emit('did-finish-load');
    expect(states.at(-1)).toEqual({ hasError: false, loading: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    electronMocks.behavior.loadingMainFrame = false;
    view.webContents.emit('did-start-loading');

    expect(states.at(-1)).toEqual({ hasError: false, loading: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('reports URL creation failure and lets reload retry from a missing view', async () => {
    let url: string | null = null;
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => url,
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    await manager.ensureView();

    expect(electronMocks.instances).toHaveLength(0);
    expect(states.at(-1)).toEqual({ hasError: true, loading: false });

    url = 'http://127.0.0.1:18789/#token=fixture';
    await manager.reload();

    expect(electronMocks.instances).toHaveLength(1);
    expect(electronMocks.instances[0]!.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('turns a loadURL rejection without did-fail-load into an explicit retry state', async () => {
    electronMocks.loadURL.mockRejectedValue(new Error('navigation rejected'));
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    await manager.ensureView();

    expect(states.at(-1)).toEqual({ hasError: true, loading: false });
    expect(electronMocks.instances[0]!.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('invalidates an in-flight create when the panel closes and lets a reopen create immediately', async () => {
    let resolveFirstUrl!: (url: string | null) => void;
    const firstUrl = new Promise<string | null>((resolve) => {
      resolveFirstUrl = resolve;
    });
    const getChatUrl = vi.fn()
      .mockReturnValueOnce(firstUrl)
      .mockResolvedValue('http://127.0.0.1:18789/#token=reopened');
    const manager = new OpenClawChatViewManager({
      getChatUrl,
      onStateChange: vi.fn(),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    const staleOpening = manager.ensureView();
    await flushMicrotasks();
    manager.destroy();
    const reopened = manager.ensureView();
    await flushMicrotasks();

    expect(getChatUrl).toHaveBeenCalledTimes(2);
    await reopened;
    expect(electronMocks.instances).toHaveLength(1);

    resolveFirstUrl('http://127.0.0.1:18789/#token=stale');
    await staleOpening;
    expect(electronMocks.instances).toHaveLength(1);
  });

  it('contains native view setup failure and can retry with a fresh view', async () => {
    electronMocks.behavior.failViewSetup = true;
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'http://127.0.0.1:18789/#token=fixture',
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());
    manager.setVisible(true);

    await expect(manager.ensureView()).resolves.toBeUndefined();
    expect(states.at(-1)).toEqual({ hasError: true, loading: false });
    expect(electronMocks.instances[0]!.webContents.close).toHaveBeenCalledOnce();

    electronMocks.behavior.failViewSetup = false;
    await manager.reload();
    expect(electronMocks.instances).toHaveLength(2);
  });

  it('does not recreate a closed existing view after a late origin recheck', async () => {
    let resolveRecheck!: (url: string | null) => void;
    const pendingRecheck = new Promise<string | null>((resolve) => {
      resolveRecheck = resolve;
    });
    const getChatUrl = vi.fn()
      .mockResolvedValueOnce('http://127.0.0.1:18789/#token=initial')
      .mockReturnValueOnce(pendingRecheck);
    const manager = new OpenClawChatViewManager({
      getChatUrl,
      onStateChange: vi.fn(),
    });
    manager.attach(makeWindow());

    await manager.ensureView();
    const rechecking = manager.ensureView();
    await flushMicrotasks();
    manager.destroy();
    resolveRecheck('http://127.0.0.1:19000/#token=late');
    await rechecking;

    expect(electronMocks.instances).toHaveLength(1);
    expect(electronMocks.instances[0]!.webContents.close).toHaveBeenCalledOnce();
  });

  it('rejects a non-HTTP chat target before creating a native view', async () => {
    const states: Array<{ hasError: boolean; loading: boolean }> = [];
    const manager = new OpenClawChatViewManager({
      getChatUrl: async () => 'file:///C:/sensitive.html#token=fixture',
      onStateChange: (state) => states.push(state),
    });
    manager.attach(makeWindow());

    await manager.ensureView();

    expect(electronMocks.instances).toHaveLength(0);
    expect(states.at(-1)).toEqual({ hasError: true, loading: false });
  });
});
