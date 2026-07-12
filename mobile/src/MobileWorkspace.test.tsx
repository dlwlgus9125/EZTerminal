// No @testing-library/react in this repo — real React root + native DOM
// events + FakeSocket, same harness as MobileOpenClawView.test.tsx (this
// repo's precedent for a full-component mobile test).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileWorkspace } from './MobileWorkspace';
import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './transport/ws-ezterminal';

// Silences React's "not configured to support act()" warning for this file's
// synchronous createRoot().render() calls below.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fake socket (kept local/self-contained per this repo's convention of not
// sharing fakes across test files — mirrors MobileOpenClawView.test.tsx's own) ──
type Handler = (...args: never[]) => void;

class FakeSocket implements WsLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    this.handlers[type].push(listener as Handler);
  }

  triggerMessage(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const h of this.handlers.message) h({ data } as never);
  }
}

function makeAuthedTransport(): { transport: WsEzTerminalTransport; socket: FakeSocket } {
  let socket: FakeSocket;
  const createSocket: CreateSocket = () => {
    socket = new FakeSocket();
    return socket;
  };
  const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
  socket!.triggerMessage({ kind: 'auth-ok' });
  return { transport, socket: socket! };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderWorkspace(transport: WsEzTerminalTransport): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MobileWorkspace transport={transport} onDisconnect={vi.fn()} />);
  });
  return container;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

// MobileWorkspace mounts with zero tabs (initialTabsState), so every test
// below exercises the zero-tab SessionSwitcher('page') screen — the
// OpenClaw entry point's ONLY home before any session/tab exists (M4).
describe('MobileWorkspace — zero-tab OpenClaw entry (openclaw-stabilization M3/M4)', () => {
  it('mode "on": shows the 🤖 entry button on the zero-tab screen regardless of availability', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeTruthy();
  });

  it('mode "off": hides the 🤖 entry button even if availability is pushed true', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-availability', visible: true });
    });

    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeFalsy();
  });

  it('mode "auto" + availability:true: shows the entry button', () => {
    // Nothing persisted -> defaults to 'auto' (openclaw-mode.ts).
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeFalsy(); // not yet available

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-availability', visible: true });
    });

    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeTruthy();
  });

  it('mode "auto" + no availability push (or availability:false): hides the entry button', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeFalsy();

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-availability', visible: false });
    });
    expect(el.querySelector('[data-testid="btn-toggle-openclaw"]')).toBeFalsy();
  });

  it('the status dot starts pending, then reflects a pushed openclaw-status', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    expect(el.querySelector('[data-testid="openclaw-entry-dot"]')?.className).toContain('openclaw-entry-dot--pending');

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });
    expect(el.querySelector('[data-testid="openclaw-entry-dot"]')?.className).toContain('openclaw-entry-dot--running');

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } });
    });
    expect(el.querySelector('[data-testid="openclaw-entry-dot"]')?.className).toContain('openclaw-entry-dot--stopped');
  });

  it('tapping the entry button opens the OpenClaw view', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="btn-toggle-openclaw"]')!.click());

    expect(el.querySelector('[data-testid="mobile-openclaw-view"]')).toBeTruthy();
  });
});
