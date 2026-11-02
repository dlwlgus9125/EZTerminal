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
});

describe('browserPaneStrip', () => {
  it('says what stopped something first', () => {
    expect(browserPaneStrip(state({ ai: 'driving', blocked: { origin: 'https://evil.example', reason: 'site-not-allowed' } }))).toEqual({ kind: 'blocked', origin: 'https://evil.example' });
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

  it('hands what later steps own to their seam', async () => {
    const { capabilities, props, sendCommand, push } = harness();
    const onSeam = vi.fn();
    await render(<BrowserPanel {...props} capabilities={capabilities} onSeam={onSeam} />);
    push(state({ blocked: { origin: 'https://evil.example', reason: 'site-not-allowed' } }));
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="browser-allow-open"]')!.click(); });
    expect(onSeam).toHaveBeenCalledWith({ kind: 'allow-site', origin: 'https://evil.example' });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
