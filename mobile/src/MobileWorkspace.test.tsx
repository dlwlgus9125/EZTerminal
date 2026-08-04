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

  triggerClose(): void {
    this.closed = true;
    for (const h of this.handlers.close) h();
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

function tap(el: HTMLElement, testId: string): void {
  const target = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!target) throw new Error(`missing [data-testid="${testId}"]`);
  act(() => target.click());
}

async function waitForTestId(
  el: HTMLElement,
  testId: string,
  timeoutMs = 2_000,
): Promise<HTMLElement> {
  const selector = `[data-testid="${testId}"]`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = el.querySelector<HTMLElement>(selector);
    if (match) return match;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${selector}`);
}

/** The More sheet renders in the overlay host, outside `container`'s page
 * shell but inside the same React tree — query the document for it. */
function openMoreSheet(el: HTMLElement): void {
  tap(el, 'shell-tab-more');
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

describe('MobileWorkspace — tab-bar shell root', () => {
  it('lands on Home with every existing top-level capability reachable', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeTruthy();
    for (const testId of [
      'shell-tab-home',
      'shell-tab-terminal',
      'shell-tab-pc',
      'shell-tab-agents',
      'shell-tab-more',
      'shell-rail-settings',
      'home-pc-control',
    ]) {
      expect(el.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
    }

    openMoreSheet(el);
    for (const testId of ['more-sessions', 'more-files', 'more-stats', 'more-theme', 'more-settings']) {
      expect(el.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
    }
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeNull();

    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(true);
    expect(socket.sentKinds()).not.toContain('desktop-control-start');
  });

  it('keeps PC Control idle on arrival even when the host advertises support', () => {
    const { transport, socket } = makeAuthedTransport(['desktop-control-v1']);
    const el = renderWorkspace(transport);

    expect(el.querySelector<HTMLButtonElement>('[data-testid="home-pc-control"]')?.disabled).toBe(false);
    expect(socket.sentKinds()).not.toContain('desktop-control-start');
  });

  it('lists live sessions on Home without opening Monitor', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelectorAll('[data-testid="home-session-row"]')).toHaveLength(0);
    expect(el.querySelector('[data-testid="home-sessions-empty"]')).toBeTruthy();

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
    expect(el.querySelectorAll('[data-testid="home-session-row"]')).toHaveLength(2);
    expect(socket.sentKinds()).not.toContain('stats-subscribe');
  });

  it('replays session deltas that arrive while the initial snapshot is in flight', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    act(() => {
      socket.triggerMessage({
        kind: 'session-added',
        session: { sessionId: 'session-new', cwd: '/new' },
      });
    });
    expect(el.querySelectorAll('[data-testid="home-session-row"]')).toHaveLength(1);

    await act(async () => {
      // This snapshot was captured before session-new was added.
      socket.triggerMessage({ kind: 'session-list', sessions: [] });
      await Promise.resolve();
    });

    expect(el.querySelectorAll('[data-testid="home-session-row"]')).toHaveLength(1);
    expect(el.textContent).toContain('/new');
  });

  it('opens the preserved terminal with a compact semantic header and returns Home', () => {
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    tap(el, 'shell-tab-terminal');

    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
    for (const [testId, label] of [
      ['workspace-hub-btn', 'Back'],
      ['tab-add-btn', 'New tab'],
      ['menu-btn', 'Sessions'],
    ] as const) {
      expect(el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.getAttribute('aria-label')).toBe(label);
    }

    tap(el, 'workspace-hub-btn');
    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeTruthy();
  });

  it('routes to the Agents tab and back to Home without unmounting the terminal', async () => {
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-agent-view');
    expect(el.querySelector('[data-testid="mobile-agent-view"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(true);

    tap(el, 'mobile-agent-close');
    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeTruthy();
  });

  it('replaces a stale agent snapshot with the authoritative seed after desktop restart', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const transport = new WsEzTerminalTransport({
        url: 'ws://x',
        token: 'tok',
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        initialBackoffMs: 100,
      });
      sockets[0].triggerMessage({ kind: 'auth-ok' });
      const el = renderWorkspace(transport);

      act(() => {
        sockets[0].triggerMessage({
          kind: 'agent-snapshot',
          snapshot: {
            revision: 50,
            items: [{
              id: 'old-activity',
              sessionId: 'session-old',
              provider: 'codex',
              cwd: '/old',
              status: 'blocked',
              createdAt: 1,
              updatedAt: 2,
            }],
          },
        });
      });
      expect(el.querySelector('[data-testid="home-agent-attention"]')).toBeTruthy();

      act(() => {
        sockets[0].triggerClose();
        vi.advanceTimersByTime(100);
        sockets[1].triggerMessage({ kind: 'auth-ok' });
        sockets[1].triggerMessage({
          kind: 'agent-snapshot',
          snapshot: { revision: 0, items: [] },
        });
      });

      expect(el.querySelector('[data-testid="home-agent-attention"]')).toBeNull();
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the session sheet from the terminal header', () => {
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    tap(el, 'shell-tab-terminal');
    tap(el, 'menu-btn');
    expect(el.querySelector('[data-testid="mobile-session-sheet"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="session-sheet-create"]')).toBeTruthy();
  });

  it('mode "on" shows OpenClaw in the More sheet regardless of availability', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    openMoreSheet(el);
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeTruthy();
  });

  it('mode "off" hides OpenClaw even if availability is pushed true', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: true }));
    openMoreSheet(el);
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeNull();
  });

  it('mode "auto" follows the availability push', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    openMoreSheet(el);
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeNull();

    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: true }));
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeTruthy();

    act(() => socket.triggerMessage({ kind: 'openclaw-availability', visible: false }));
    expect(el.querySelector('[data-testid="more-openclaw"]')).toBeNull();
  });

  it('reflects the pushed OpenClaw status without opening its detailed page', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    openMoreSheet(el);
    const state = (): string | null => (
      el.querySelector('[data-testid="more-openclaw-state"]')?.textContent ?? null
    );
    expect(state()).toBe('Checking');
    act(() => socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } }));
    expect(state()).toBe('Running');
    act(() => socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } }));
    expect(state()).toBe('Stopped');
  });

  it('surfaces the running gateway as a Home shortcut and opens the lazy page from it', async () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    expect(el.querySelector('[data-testid="home-openclaw"]')).toBeNull();

    act(() => socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } }));
    tap(el, 'home-openclaw');
    expect(el.querySelector('[data-testid="mobile-page-shell"]')).toBeTruthy();
    await waitForTestId(el, 'mobile-openclaw-view');
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
      .map((value) => JSON.parse(value) as {
        kind: string;
        requestId?: string;
        surfaceId?: string;
        intent?: { kind: string; cwd?: string };
      })
      .findLast((message) => message.kind === 'session-surface-open');
    expect(createRequest).toMatchObject({
      kind: 'session-surface-open',
      intent: { kind: 'create', cwd: '/safe/feature' },
    });
    if (!createRequest?.requestId) throw new Error('session create request not sent');
    if (!createRequest.surfaceId) throw new Error('session surface id not sent');

    await act(async () => {
      socket.triggerMessage({
        kind: 'session-surface-open-result',
        requestId: createRequest.requestId,
        result: {
          ok: true,
          binding: {
            surfaceId: createRequest.surfaceId,
            bindingId: 'binding-wt',
            session: { sessionId: 'session-wt', cwd: '/safe/feature' },
            role: 'owner',
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(el.querySelector('[data-testid="mobile-session-view"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="workspace-hub-btn"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="stats-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="theme-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="files-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="agents-btn"]')).toBeNull();
    expect(el.querySelector('[data-testid="workspace-more-btn"]')).toBeNull();

    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    act(() => window.dispatchEvent(new Event('resize')));
    tap(el, 'workspace-hub-btn');
    openMoreSheet(el);
    expect(el.querySelector('[data-testid="more-sessions"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-files"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-stats"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-theme"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="more-settings"]')).toBeTruthy();
  });
});
