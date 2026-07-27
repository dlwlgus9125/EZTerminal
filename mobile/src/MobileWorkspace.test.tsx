// No @testing-library/react in this repo — real React root + native DOM
// events + FakeSocket, same harness as MobileOpenClawView.test.tsx (this
// repo's precedent for a full-component mobile test).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileWorkspace } from './MobileWorkspace';
import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './transport/ws-ezterminal';
import { REMOTE_PROTOCOL_VERSION } from '../../src/shared/remote-protocol';

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
    const normalized = (msg as { kind?: string })?.kind === 'auth-ok'
      ? { protocolVersion: REMOTE_PROTOCOL_VERSION, hostVersion: '1.0.0-test', ...(msg as Record<string, unknown>) }
      : msg;
    const data = JSON.stringify(normalized);
    for (const h of this.handlers.message) h({ data } as never);
  }

  sentKinds(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
  }
}

function makeAuthedTransport(capabilities: readonly string[] = []): { transport: WsEzTerminalTransport; socket: FakeSocket } {
  let socket: FakeSocket;
  const createSocket: CreateSocket = () => {
    socket = new FakeSocket();
    return socket;
  };
  const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
  socket!.triggerMessage({ kind: 'auth-ok', capabilities });
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

describe('MobileWorkspace — remote hub root', () => {
  it('lands on the hub with every existing top-level capability reachable', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    expect(el.querySelector('[data-testid="mobile-remote-hub"]')).toBeTruthy();
    for (const testId of [
      'hub-pc-control',
      'hub-terminal',
      'hub-sessions',
      'hub-agents',
      'hub-files',
      'hub-stats',
      'hub-appearance',
      'hub-settings',
    ]) {
      expect(el.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
    }
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(true);
    expect(socket.sentKinds()).not.toContain('desktop-control-start');
  });

  it('keeps PC Control idle on arrival even when the host advertises support', () => {
    const { transport, socket } = makeAuthedTransport(['desktop-control-v1']);
    const el = renderWorkspace(transport);

    expect(el.querySelector<HTMLButtonElement>('[data-testid="hub-pc-control"]')?.disabled).toBe(false);
    expect(socket.sentKinds()).not.toContain('desktop-control-start');
  });

  it('updates the lightweight session count without opening Monitor', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="hub-session-count"]')?.textContent).toBe('0');

    await act(async () => {
      socket.triggerMessage({
        kind: 'session-list',
        sessions: [
          { sessionId: 'session-a', cwd: '/a' },
          { sessionId: 'session-b', cwd: '/b' },
        ],
      });
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="hub-session-count"]')?.textContent).toBe('2');
    expect(socket.sentKinds()).not.toContain('stats-subscribe');
  });

  it('opens the preserved terminal with a compact semantic header and returns to the hub', () => {
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="hub-terminal"]')!.click());

    expect(el.querySelector('[data-testid="mobile-remote-hub"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
    for (const [testId, label, className] of [
      ['workspace-hub-btn', 'Back', 'ez-ui-icon-button'],
      ['tab-add-btn', 'New tab', 'ez-ui-button'],
      ['menu-btn', 'Sessions', 'ez-ui-button'],
    ] as const) {
      const button = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      expect(button?.classList.contains(className)).toBe(true);
      expect(button?.getAttribute('aria-label')).toBe(label);
    }

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="workspace-hub-btn"]')!.click());
    expect(el.querySelector('[data-testid="mobile-remote-hub"]')).toBeTruthy();
  });

  it('mode "on" shows OpenClaw on the hub regardless of availability', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeTruthy();
  });

  it('mode "off" hides OpenClaw even if availability is pushed true', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: true }));
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeNull();
  });

  it('mode "auto" follows the availability push', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeNull();

    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: true }));
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeTruthy();

    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: false }));
    expect(el.querySelector('[data-testid="hub-openclaw"]')).toBeNull();
  });

  it('reflects the pushed OpenClaw status without opening its detailed page', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    const state = (): string | null => (
      el.querySelector('[data-testid="hub-openclaw"] .mobile-hub-action__status')?.textContent ?? null
    );
    expect(state()).toBeNull();
    act(() => socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } }));
    expect(state()).toBe('running');
    act(() => socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } }));
    expect(state()).toBe('stopped');
  });

  it('opens the lazy OpenClaw page directly from the hub with immediate feedback', async () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="hub-openclaw"]')!.click());
    expect(el.querySelector('[data-testid="mobile-page-shell"]')).toBeTruthy();
    await act(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (el.querySelector('[data-testid="mobile-openclaw-view"]')) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    });
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
    expect(el.querySelector('[data-testid="workspace-hub-btn"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="stats-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="theme-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="menu-btn"]')?.classList.contains('workspace-wide-action')).toBe(false);
    expect(el.querySelector('[data-testid="files-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="agents-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="workspace-more-btn"]')).toBeNull();

    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    act(() => window.dispatchEvent(new Event('resize')));
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="workspace-hub-btn"]')!.click());
    expect(el.querySelector('[data-testid="hub-sessions"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="hub-files"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="hub-stats"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="hub-appearance"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="hub-settings"]')).toBeTruthy();
  });
});
