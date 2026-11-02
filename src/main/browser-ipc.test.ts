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
  const view = { updateSurface: vi.fn(), state: vi.fn(() => ({ conversationId: 'chat', url: '', loading: false, canBack: false, canForward: false, ai: 'none' as const })) };
  installBrowserIpc({ ipc, view: () => view, mainWebContents: () => app });
  return { listeners, handlers, app, view };
}

const surface = (patch: Partial<BrowserSurfaceSnapshot> = {}): BrowserSurfaceSnapshot => ({
  conversationId: 'chat', instanceId: 'instance-1', revision: 1, mounted: true, windowName: 'main', bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true, ...patch,
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
