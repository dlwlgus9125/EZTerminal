// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IDockviewPanelProps } from 'dockview-react';

import type { BrowserSurfaceSnapshot, BrowserViewState } from '../shared/browser';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { BrowserPanel, browserPaneBody, browserPaneStrip, type BrowserPanelParams } from './BrowserPanel';
import type { CapabilityAccess } from './capability-access';
import { OpenClawOverlayContext } from './OpenClawChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): ResizeObserverEntry[] { return []; }
  unobserve(): void {}
}

const state = (patch: Partial<BrowserViewState> = {}): BrowserViewState => ({
  conversationId: 'chat', url: 'http://localhost:5173/cart', site: 'local', loading: false, canBack: true, canForward: false, ai: 'none', ...patch,
});

let container: HTMLDivElement;
let root: Root;

function harness() {
  let push: (next: BrowserViewState) => void = () => undefined;
  const setSurface = vi.fn<(surface: BrowserSurfaceSnapshot) => boolean>(() => true);
  const stop = vi.fn();
  const observe = vi.fn((_id: string, listener: (next: BrowserViewState) => void) => { push = listener; return stop; });
  const sendCommand = vi.fn<(command: DaemonCommand) => Promise<DaemonCommandReceipt>>(async (command) => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 2, eventSequence: 2 }) as DaemonCommandReceipt);
  const capabilities = {
    browserPane: { setSurface, observe, onOpenPane: vi.fn(() => vi.fn()) },
    daemon: { getSnapshot: vi.fn(async () => ({ revision: 1 }) as DaemonSnapshot), sendCommand },
  } as unknown as CapabilityAccess;
  const api = { isVisible: true, onDidVisibilityChange: vi.fn(() => ({ dispose: vi.fn() })) };
  const props = { api, params: { conversationId: 'chat' } } as unknown as IDockviewPanelProps<BrowserPanelParams>;
  return { capabilities, props, api, setSurface, sendCommand, stop, push: (next: BrowserViewState) => { act(() => push(next)); } };
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('browserPaneBody', () => {
  it('shows the page only when there is one', () => {
    expect(browserPaneBody(null).kind).toBe('empty');
    expect(browserPaneBody(state({ url: '' })).kind).toBe('empty');
    expect(browserPaneBody(state())).toEqual({ kind: 'page' });
    expect(browserPaneBody(state({ fault: 'server-down' }))).toEqual({ kind: 'server-down', origin: 'http://localhost:5173' });
    expect(browserPaneBody(state({ fault: 'gone' })).kind).toBe('gone');
  });

  it('keeps an address after a restart, and asks before loading it', () => {
    expect(browserPaneBody(state({ needsReopen: true })).kind).toBe('gone');
  });

  it('says the app ended a page that answered from where it must not: no crash happened', () => {
    const suspect = { origin: 'https://staging.example', reason: 'rebind-suspected' as const, serial: 1 };
    expect(browserPaneBody(state({ needsReopen: true, blocked: suspect }))).toEqual({ kind: 'gone', ended: 'rebind-suspected' });
    expect(browserPaneBody(state({ needsReopen: true, blocked: { ...suspect, reason: 'site-not-allowed' } }))).toEqual({ kind: 'gone' });
  });
});

describe('browserPaneStrip', () => {
  it('says what stopped something first', () => {
    expect(browserPaneStrip(state({ ai: 'driving', blocked: { origin: 'https://evil.example', reason: 'site-not-allowed', serial: 1 } }))).toEqual({ kind: 'blocked', origin: 'https://evil.example' });
  });

  it('says who is at the page', () => {
    expect(browserPaneStrip(state({ ai: 'driving' }))).toEqual({ kind: 'driving' });
    expect(browserPaneStrip(state({ ai: 'stopped' }))).toEqual({ kind: 'stopped' });
    expect(browserPaneStrip(state())).toBeUndefined();
  });

  it('reads the class of the current URL: an external page is one the AI does not read', () => {
    expect(browserPaneStrip(state({ url: 'https://elsewhere.example/a', site: 'external' }))).toEqual({ kind: 'not-read', origin: 'https://elsewhere.example' });
    expect(browserPaneStrip(state({ url: 'https://staging.example/a', site: 'allowed' }))).toBeUndefined();
  });

  it.each([
    ['a suspected rebind', { origin: 'https://staging.example', reason: 'rebind-suspected' as const, serial: 1 }],
    ['a download', { origin: 'http://localhost:5173', reason: 'download-blocked' as const, serial: 1 }],
    ['the app\'s own port', { origin: 'http://127.0.0.1:7420', reason: 'site-not-allowed' as const, serial: 1 }],
    ['a file outside the folders', { origin: 'file:///C:/secret.txt', reason: 'site-not-allowed' as const, serial: 1 }],
  ])('offers nothing a person could wave through for %s', (_name, blocked) => {
    expect(browserPaneStrip(state({ blocked }))).toBeUndefined();
  });

  it('keeps a closed bar closed, and opens for the next stop', () => {
    const first = state({ blocked: { origin: 'https://evil.example', reason: 'site-not-allowed', serial: 1 } });
    expect(browserPaneStrip(first, { blocked: 1 })).toBeUndefined();
    expect(browserPaneStrip(state({ blocked: { origin: 'https://evil.example', reason: 'site-not-allowed', serial: 2 } }), { blocked: 1 })?.kind).toBe('blocked');
  });

  it('says a site was just allowed, until it is closed', () => {
    expect(browserPaneStrip(state({ allowed: 'https://evil.example' }))).toEqual({ kind: 'allowed', origin: 'https://evil.example' });
    expect(browserPaneStrip(state({ allowed: 'https://evil.example' }), { allowed: 'https://evil.example' })).toBeUndefined();
  });
});

describe('BrowserPanel', () => {
  it('reports the plate, and shows the native view only over a page', async () => {
    const { capabilities, props, setSurface, push } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'chat', mounted: true, windowName: 'main', visible: false }));
    push(state());
    await settle();
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    push(state({ fault: 'server-down' }));
    await settle();
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  });

  it('parks the view under an overlay: a native view paints over the DOM', async () => {
    const { capabilities, props, setSurface, push } = harness();
    await render(<OpenClawOverlayContext.Provider value><BrowserPanel {...props} capabilities={capabilities} /></OpenClawOverlayContext.Provider>);
    push(state());
    await settle();
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ mounted: true, visible: false }));
  });

  it('parks the view when its tab is behind another', async () => {
    const { capabilities, props, api, setSurface, push } = harness();
    api.isVisible = false;
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    push(state());
    await settle();
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  });

  it('says it left when it unmounts', async () => {
    const { capabilities, props, setSurface, stop } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    await act(async () => { root.render(<div />); });
    expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ mounted: false, visible: false }));
    expect(stop).toHaveBeenCalled();
  });

  it('sends the address bar as the person\'s navigation', async () => {
    const { capabilities, props, sendCommand, push } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    push(state());
    await settle();
    const input = container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'localhost:3000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser.action', payload: { sessionId: 'chat', action: 'navigate', target: 'localhost:3000' } }));
  });

  it('stops the AI\'s use of the page with one press, and the turn goes on', async () => {
    const { capabilities, props, sendCommand, push } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    push(state({ ai: 'driving' }));
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-stop"]')!.click(); });
    await settle();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser.action', payload: { sessionId: 'chat', action: 'stop' } }));
  });

  it('asks before reloading a page after a restart', async () => {
    const { capabilities, props, sendCommand, push } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    push(state({ needsReopen: true }));
    await settle();
    expect(sendCommand).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-retry"]')!.click(); });
    await settle();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: 'chat', action: 'navigate', target: 'http://localhost:5173/cart' } }));
  });

  describe('allowing a site', () => {
    const blocked = { origin: 'https://staging.cart-kit.example', reason: 'site-not-allowed' as const, serial: 1 };
    const open = async () => {
      const h = harness();
      vi.mocked(h.capabilities.daemon.getSnapshot).mockResolvedValue({
        revision: 1,
        sessions: [{ id: 'chat', projectId: 'project-1' }],
        projects: [{ id: 'project-1', name: 'cart-kit' }],
        agents: [{ sessionId: 'chat', permissionPreset: 'full-access' }],
      } as unknown as DaemonSnapshot);
      await render(<BrowserPanel {...h.props} capabilities={h.capabilities} />);
      h.push(state({ blocked }));
      await settle();
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-allow-open"]')!.click(); });
      await settle();
      return h;
    };
    const sheet = () => document.querySelector('[data-testid="browser-allow-sheet"]');

    it('names the exact origin and the project, and warns at full access', async () => {
      await open();
      expect(sheet()?.textContent).toContain('https://staging.cart-kit.example');
      expect(sheet()?.textContent).toContain('cart-kit');
      expect(document.querySelector('[data-testid="browser-allow-warning"]')?.getAttribute('data-level')).toBe('full');
    });

    it('takes the page away while it is open: a native view paints over the DOM', async () => {
      const { setSurface } = await open();
      expect(setSurface).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    });

    it('sends one exact origin for that project, on the person\'s press', async () => {
      const { sendCommand } = await open();
      expect(sendCommand).not.toHaveBeenCalled();
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="browser-allow-confirm"]')!.click(); });
      await settle();
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser.site', payload: { projectId: 'project-1', origin: 'https://staging.cart-kit.example', action: 'allow' } }));
      expect(sheet()).toBeNull();
    });

    it('sends nothing on cancel, with focus back at the bar', async () => {
      const { sendCommand } = await open();
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="browser-allow-cancel"]')!.click(); });
      await settle();
      expect(sendCommand).not.toHaveBeenCalled();
      expect(sheet()).toBeNull();
    });
  });

  it('closes the bar for this stop', async () => {
    const { capabilities, props, push } = harness();
    await render(<BrowserPanel {...props} capabilities={capabilities} />);
    push(state({ blocked: { origin: 'https://evil.example', reason: 'site-not-allowed', serial: 3 } }));
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-dismiss"]')!.click(); });
    expect(container.querySelector('[data-testid="browser-strip"]')).toBeNull();
    push(state({ loading: true, blocked: { origin: 'https://evil.example', reason: 'site-not-allowed', serial: 3 } }));
    await settle();
    expect(container.querySelector('[data-testid="browser-strip"]'), 'the same stop, pushed again').toBeNull();
  });

  it('hands what later steps own to their seam', async () => {
    const { capabilities, props, sendCommand, push } = harness();
    const onSeam = vi.fn();
    await render(<BrowserPanel {...props} capabilities={capabilities} onSeam={onSeam} />);
    push(state());
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-pick"]')!.click(); });
    expect(onSeam).toHaveBeenCalledWith({ kind: 'pick' });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
