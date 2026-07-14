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

  sentKinds(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
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
  delete (window as unknown as { ezterminal?: WsEzTerminalTransport }).ezterminal;
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
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

describe('MobileWorkspace — background pause (openclaw-stabilization M6)', () => {
  // jsdom's `document.visibilityState` is a read-only getter — shadow it
  // with an own property (per-test, reset in afterEach) to simulate the
  // Capacitor WebView backgrounding/foregrounding the app.
  function setPageVisible(visible: boolean): void {
    Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  afterEach(() => setPageVisible(true));

  it('releases the entry-button status subscription while backgrounded and re-acquires it when foregrounded', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    renderWorkspace(transport);
    expect(socket.sentKinds().filter((k) => k === 'openclaw-status-subscribe')).toHaveLength(1);

    setPageVisible(false);
    expect(socket.sentKinds().filter((k) => k === 'openclaw-status-unsubscribe')).toHaveLength(1);

    setPageVisible(true);
    expect(socket.sentKinds().filter((k) => k === 'openclaw-status-subscribe')).toHaveLength(2);
  });
});

describe('MobileWorkspace — dead status subscription self-heals on availability flip (architect-review fix)', () => {
  // Root cause: remote-bridge.ts silently drops an `openclaw-status-subscribe`
  // sent while the desktop is hidden (its `openclawVisible()` gate `break`s
  // without ever attaching a listener). Under mode='on', `effectiveOpenClaw
  // Visible` is a constant `true`, so without `openclawAvailable` in the
  // status effect's deps a desktop hidden->visible flip would never re-send
  // the subscribe — the entry dot would stay stuck forever. This asserts the
  // fix: a false->true availability push re-sends the subscribe.
  it('mode "on": a false->true availability push re-sends openclaw-status-subscribe', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    renderWorkspace(transport);
    expect(socket.sentKinds().filter((k) => k === 'openclaw-status-subscribe')).toHaveLength(1);

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-availability', visible: true });
    });

    expect(socket.sentKinds().filter((k) => k === 'openclaw-status-subscribe')).toHaveLength(2);
  });
});

describe('MobileWorkspace - worktree open', () => {
  it('creates and selects a normal terminal tab rooted at the validated path', async () => {
    const { transport, socket } = makeAuthedTransport();
    Object.defineProperty(window, 'ezterminal', { value: transport, configurable: true });
    const el = renderWorkspace(transport);
    const worktree = {
      worktreeId: 'wt-1',
      repoId: 'repo-1',
      path: '/safe/feature',
      branch: 'feature',
      head: 'abc123',
      main: false,
      locked: false,
      managed: true,
      prunable: false,
    } as const;

    let openPromise!: ReturnType<WsEzTerminalTransport['executeWorktree']>;
    act(() => {
      openPromise = transport.executeWorktree({ action: 'open', cwd: '/repo', worktreeId: 'wt-1' });
    });
    const openRequest = socket.sent
      .map((value) => JSON.parse(value) as { kind: string; requestId?: string })
      .findLast((message) => message.kind === 'worktree-request');
    if (!openRequest?.requestId) throw new Error('worktree request not sent');

    await act(async () => {
      socket.triggerMessage({
        kind: 'worktree-reply',
        requestId: openRequest.requestId,
        result: { ok: true, action: 'open', worktrees: [worktree], opened: worktree },
      });
      await openPromise;
    });
    const createRequest = socket.sent
      .map((value) => JSON.parse(value) as { kind: string; requestId?: string; cwd?: string })
      .findLast((message) => message.kind === 'create-session');
    expect(createRequest).toMatchObject({ kind: 'create-session', cwd: '/safe/feature' });
    if (!createRequest?.requestId) throw new Error('session create request not sent');

    await act(async () => {
      socket.triggerMessage({
        kind: 'session-created',
        requestId: createRequest.requestId,
        session: { sessionId: 'session-wt', cwd: '/safe/feature' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(el.querySelector('[data-testid="mobile-session-view"]')).toBeTruthy();
    expect(el.querySelectorAll('[data-testid="tab-pill"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="workspace-more-btn"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="stats-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="theme-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="menu-btn"]')?.classList.contains('workspace-wide-action')).toBe(true);
    expect(el.querySelector('[data-testid="files-btn"]')?.classList.contains('workspace-wide-action')).toBe(true);

    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    act(() => window.dispatchEvent(new Event('resize')));
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="workspace-more-btn"]')!.click());
    expect(el.querySelector('[data-testid="more-sessions"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-files"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-stats"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-theme"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-settings"]')).toBeTruthy();
  });
});
