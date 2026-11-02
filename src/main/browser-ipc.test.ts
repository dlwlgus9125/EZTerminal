import { describe, expect, it, vi } from 'vitest';

import type { BrowserSurfaceSnapshot } from '../shared/browser';
import { installBrowserIpc } from './browser-ipc';
import type { FeatureIpc } from './ipc-registration';

type Listener = (event: { sender: unknown }, ...args: unknown[]) => unknown;

function harness() {
  const listeners = new Map<string, Listener>();
  const handlers = new Map<string, Listener>();
  const ipc = {
    on: vi.fn((channel: string, listener: Listener) => { listeners.set(channel, listener); }),
    removeListener: vi.fn(),
    handle: vi.fn((channel: string, listener: Listener) => { handlers.set(channel, listener); }),
    removeHandler: vi.fn(),
  } as unknown as FeatureIpc;
  const app = { id: 'app-window' };
  const settings = {
    load: vi.fn(async () => ({ settings: { enabled: false, autoCheck: false }, sites: [] })),
    save: vi.fn(async (next: unknown) => next as { enabled: boolean; autoCheck: boolean }),
    revokeSite: vi.fn(async () => []),
    clearData: vi.fn(async () => undefined),
  };
  const view = { updateSurface: vi.fn(), state: vi.fn(() => ({ conversationId: 'chat', url: '', loading: false, canBack: false, canForward: false, ai: 'none' as const })) };
  installBrowserIpc({ ipc, view: () => view, mainWebContents: () => app, settings });
  return { listeners, handlers, app, view, settings };
}

const surface = (patch: Partial<BrowserSurfaceSnapshot> = {}): BrowserSurfaceSnapshot => ({
  conversationId: 'chat', instanceId: 'instance-1', revision: 1, mounted: true, windowName: 'main', bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true, ...patch,
});

describe('installBrowserIpc: Settings › 내장 브라우저', () => {
  it('answers the app\'s window', async () => {
    const { handlers, app, settings } = harness();
    await handlers.get('browser:settings')!({ sender: app });
    expect(settings.load).toHaveBeenCalledTimes(1);
    await handlers.get('browser:set-settings')!({ sender: app }, { enabled: true, autoCheck: true });
    expect(settings.save).toHaveBeenCalledWith({ enabled: true, autoCheck: true });
    await handlers.get('browser:revoke-site')!({ sender: app }, 'project', 'https://staging.example');
    expect(settings.revokeSite).toHaveBeenCalledWith('project', 'https://staging.example');
    await handlers.get('browser:clear-data')!({ sender: app });
    expect(settings.clearData).toHaveBeenCalledTimes(1);
  });

  it('refuses anyone else, and a malformed save', async () => {
    const { handlers, app, settings } = harness();
    const page = { sender: { id: 'a-page' } };
    await expect(handlers.get('browser:settings')!(page)).rejects.toThrow();
    await expect(handlers.get('browser:set-settings')!(page, { enabled: true, autoCheck: true })).rejects.toThrow();
    await expect(handlers.get('browser:revoke-site')!(page, 'project', 'https://staging.example')).rejects.toThrow();
    await expect(handlers.get('browser:clear-data')!(page)).rejects.toThrow();
    for (const bad of [{ enabled: 'yes', autoCheck: true }, { enabled: true }, null, { enabled: true, autoCheck: true, extra: 1 }]) {
      await expect(handlers.get('browser:set-settings')!({ sender: app }, bad)).rejects.toThrow();
    }
    await expect(handlers.get('browser:revoke-site')!({ sender: app }, 7, 'x')).rejects.toThrow();
    expect(settings.load).not.toHaveBeenCalled();
    expect(settings.save).not.toHaveBeenCalled();
    expect(settings.revokeSite).not.toHaveBeenCalled();
    expect(settings.clearData).not.toHaveBeenCalled();
  });
});

describe('installBrowserIpc', () => {
  it('takes the place of the pane from the app\'s window', () => {
    const { listeners, app, view } = harness();
    listeners.get('browser:surface')!({ sender: app }, surface());
    expect(view.updateSurface).toHaveBeenCalledWith('chat', { mounted: true, bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true });
  });

  it('hears nothing from anywhere else: a page has no channel, but no sender is trusted anyway', () => {
    const { listeners, handlers, view } = harness();
    listeners.get('browser:surface')!({ sender: { id: 'a-page' } }, surface());
    expect(handlers.get('browser:state')!({ sender: { id: 'a-page' } }, 'chat')).toBeNull();
    expect(view.updateSurface).not.toHaveBeenCalled();
    expect(view.state).not.toHaveBeenCalled();
  });

  it('drops malformed and stale surfaces', () => {
    const { listeners, app, view } = harness();
    const send = (value: unknown) => listeners.get('browser:surface')!({ sender: app }, value);
    send({ conversationId: 'chat' });
    send(surface({ conversationId: '' }));
    send(surface({ bounds: { x: 0, y: 0, width: 1.5, height: 2 } }));
    expect(view.updateSurface).not.toHaveBeenCalled();
    send(surface({ revision: 5 }));
    send(surface({ revision: 4 }));
    expect(view.updateSurface).toHaveBeenCalledTimes(1);
  });

  it('ignores a retired renderer after a reload', () => {
    const { listeners, app, view } = harness();
    listeners.get('browser:surface')!({ sender: app }, surface({ instanceId: 'old', revision: 9 }));
    listeners.get('browser:surface')!({ sender: app }, surface({ instanceId: 'new', revision: 1 }));
    listeners.get('browser:surface')!({ sender: app }, surface({ instanceId: 'old', revision: 10 }));
    expect(view.updateSurface).toHaveBeenCalledTimes(2);
  });

  it('keeps a page out of a window it cannot live in', () => {
    const { listeners, app, view } = harness();
    listeners.get('browser:surface')!({ sender: app }, surface({ windowName: 'popout-1' }));
    expect(view.updateSurface).toHaveBeenCalledWith('chat', expect.objectContaining({ visible: false }));
  });
});
