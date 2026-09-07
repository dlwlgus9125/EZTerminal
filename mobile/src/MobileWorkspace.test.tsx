// No @testing-library/react in this repo — real React root + native DOM
// events + FakeSocket, same harness as MobileOpenClawView.test.tsx (this
// repo's precedent for a full-component mobile test).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileWorkspace } from './MobileWorkspace';
import { readWorkspaceRestore, writeWorkspaceRestore } from './workspace-restore';
import {
  MobileAgentCreateRecoveryStore,
  mobileAgentCreateAuthorityFingerprint,
  type MobileAgentCreateRecoveryLoadResult,
  type MobileAgentCreateRecoveryStoreLike,
  type SecureStorageLike,
} from './mobile-agent-create-recovery-store';
import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './transport/ws-ezterminal';
import type { DaemonSnapshot } from '../../src/shared/daemon-protocol';
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

function makeAuthedTransport(
  capabilities: readonly string[] = [],
  token = 'tok',
  issuedToken?: string,
): { transport: WsEzTerminalTransport; socket: FakeSocket } {
  let socket: FakeSocket;
  const createSocket: CreateSocket = () => {
    socket = new FakeSocket();
    return socket;
  };
  const transport = new WsEzTerminalTransport({ url: 'ws://x', token, createSocket });
  socket!.triggerMessage({ kind: 'auth-ok', capabilities, ...(issuedToken ? { issuedToken } : {}) });
  return { transport, socket: socket! };
}

class PersistentSecureStorage implements SecureStorageLike {
  readonly values = new Map<string, string>();

  async get({ key }: { key: string }): Promise<{ value: string }> {
    const value = this.values.get(key);
    if (value === undefined) throw new Error('missing secure value');
    return { value };
  }

  async set({ key, value }: { key: string; value: string }): Promise<{ value: boolean }> {
    this.values.set(key, value);
    return { value: true };
  }

  async remove({ key }: { key: string }): Promise<{ value: boolean }> {
    return { value: this.values.delete(key) };
  }

  async keys(): Promise<{ value: string[] }> {
    return { value: [...this.values.keys()] };
  }

  async getPlatform(): Promise<{ value: string }> {
    return { value: 'android' };
  }
}

const DAEMON_NOW = '2026-09-06T00:00:00.000Z';

function daemonSnapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision: 1,
    eventSequence: 1,
    generatedAt: DAEMON_NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderWorkspace(
  transport: WsEzTerminalTransport,
  agentCreateRecoveryStore?: MobileAgentCreateRecoveryStoreLike,
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MobileWorkspace
        transport={transport}
        onDisconnect={vi.fn()}
        agentCreateRecoveryStore={agentCreateRecoveryStore}
      />,
    );
  });
  return container;
}

function tap(el: HTMLElement, testId: string): void {
  const target = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!target) throw new Error(`missing [data-testid="${testId}"]`);
  act(() => target.click());
}

function changeSelect(el: HTMLElement, testId: string, value: string): void {
  const select = el.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (!select) throw new Error(`missing select [data-testid="${testId}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function fillTextarea(el: HTMLElement, testId: string, value: string): void {
  const textarea = el.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  if (!textarea) throw new Error(`missing textarea [data-testid="${testId}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

async function waitForTestIdToDisappear(
  el: HTMLElement,
  testId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!el.querySelector(selector)) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${selector} to disappear`);
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
  it('lands on Terminal with every existing top-level capability reachable', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'off');
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
    for (const testId of [
      'shell-tab-home',
      'shell-tab-terminal',
      'shell-tab-pc',
      'shell-tab-agents',
      'shell-tab-more',
      'shell-rail-settings',
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
    tap(el, 'shell-tab-home');

    expect(el.querySelector<HTMLButtonElement>('[data-testid="home-pc-control"]')?.disabled).toBe(false);
    expect(socket.sentKinds()).not.toContain('desktop-control-start');
  });

  it('lists live sessions on Home without opening Monitor', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderWorkspace(transport);
    tap(el, 'shell-tab-home');
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
    tap(el, 'shell-tab-home');

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
      ['workspace-hub-btn', 'Home'],
      ['tab-add-btn', 'New tab'],
      ['menu-btn', 'Sessions'],
    ] as const) {
      expect(el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.getAttribute('aria-label')).toBe(label);
    }

    tap(el, 'workspace-hub-btn');
    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeTruthy();
  });

  it('routes to the Agents tab and back to Terminal without unmounting the terminal', async () => {
    const { transport } = makeAuthedTransport();
    const el = renderWorkspace(transport);

    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-agent-view');
    expect(el.querySelector('[data-testid="mobile-agent-view"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(true);

    tap(el, 'mobile-agent-close');
    expect(el.querySelector('[data-testid="mobile-home-view"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
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
    tap(el, 'shell-tab-home');

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
              state: 'blocked',
              status: 'blocked',
              stateSeq: 1,
              live: true,
              interactiveReady: true,
              stateSource: 'provider-hook',
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
    tap(el, 'shell-tab-home');
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

describe('MobileWorkspace - durable Agent create recovery', () => {
  it('binds recovery to the issued bearer after one-time pairing, never the spent code', async () => {
    const issuedBearer = 'a'.repeat(64);
    const { transport } = makeAuthedTransport([], 'ABCD-EFGH', issuedBearer);
    const store: MobileAgentCreateRecoveryStoreLike = {
      load: vi.fn(async (): Promise<MobileAgentCreateRecoveryLoadResult> => ({
        available: true,
        recovery: null,
      })),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };

    renderWorkspace(transport, store);
    await flushAsync();

    const issuedFingerprint = await mobileAgentCreateAuthorityFingerprint(issuedBearer);
    const pairingFingerprint = await mobileAgentCreateAuthorityFingerprint('ABCD-EFGH');
    expect(store.load).toHaveBeenCalledWith(issuedFingerprint);
    expect(store.load).not.toHaveBeenCalledWith(pairingFingerprint);
  });

  it('rechecks a transient secure-storage failure from the inline retry action', async () => {
    const { transport, socket } = makeAuthedTransport();
    const authority = daemonSnapshot();
    vi.spyOn(transport, 'getDaemonSnapshot').mockResolvedValue(authority);
    let releaseRetryToken: (() => void) | undefined;
    const retryTokenGate = new Promise<void>((resolve) => {
      releaseRetryToken = resolve;
    });
    let tokenReadCount = 0;
    vi.spyOn(transport, 'getRemoteToken').mockImplementation(async () => {
      tokenReadCount += 1;
      if (tokenReadCount === 3) {
        await retryTokenGate;
      }
      return 'tok';
    });
    let loadCount = 0;
    const store: MobileAgentCreateRecoveryStoreLike = {
      load: vi.fn(async (): Promise<MobileAgentCreateRecoveryLoadResult> => {
        loadCount += 1;
        return loadCount === 1
          ? { available: false, recovery: null, reason: 'storage-unavailable' }
          : { available: true, recovery: null };
      }),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };

    const el = renderWorkspace(transport, store);
    act(() => socket.triggerMessage({ kind: 'daemon-snapshot', snapshot: authority }));
    await flushAsync();
    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-agent-new-session');
    tap(el, 'mobile-agent-new-session');
    await waitForTestId(el, 'mobile-new-session-recovery-retry');

    tap(el, 'mobile-new-session-recovery-retry');
    await flushAsync();
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="mobile-new-session-recovery-status"]')).not.toBeNull();

    await act(async () => releaseRetryToken?.());
    await waitForTestIdToDisappear(el, 'mobile-new-session-recovery-status');
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it('discards only the authenticated host record after explicit confirmation', async () => {
    const { transport, socket } = makeAuthedTransport([], 'desktop-corrupt-token');
    const authority = daemonSnapshot();
    vi.spyOn(transport, 'getDaemonSnapshot').mockResolvedValue(authority);
    const clear = vi.fn(async () => undefined);
    const store: MobileAgentCreateRecoveryStoreLike = {
      load: vi.fn(async (): Promise<MobileAgentCreateRecoveryLoadResult> => ({
        available: false,
        recovery: null,
        reason: 'invalid-record',
      })),
      save: vi.fn(async () => undefined),
      clear,
    };

    const el = renderWorkspace(transport, store);
    act(() => socket.triggerMessage({ kind: 'daemon-snapshot', snapshot: authority }));
    await flushAsync();
    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-agent-new-session');
    tap(el, 'mobile-agent-new-session');
    await waitForTestId(el, 'mobile-new-session-recovery-discard');
    tap(el, 'mobile-new-session-recovery-discard');
    const confirm = await waitForTestId(document.body, 'mobile-new-session-recovery-discard-confirm');
    act(() => confirm.click());
    await flushAsync();

    const expectedFingerprint = await mobileAgentCreateAuthorityFingerprint('desktop-corrupt-token');
    expect(clear).toHaveBeenCalledWith(expectedFingerprint);
    expect(el.querySelector('[data-testid="mobile-new-session-recovery-status"]')).toBeNull();
  });

  it('restores a persisted exact envelope after a full remount and retries it safely', async () => {
    const secure = new PersistentSecureStorage();
    const { transport, socket } = makeAuthedTransport();
    const authority = daemonSnapshot({
      revision: 51,
      eventSequence: 51,
      projects: [{
        id: 'project-agent',
        name: 'Mobile Agent Project',
        source: 'native',
        revision: 1,
        createdAt: DAEMON_NOW,
        updatedAt: DAEMON_NOW,
      }],
      workspaces: [{
        id: 'workspace-agent',
        projectId: 'project-agent',
        name: 'Mobile Agent Workspace',
        kind: 'local',
        rootPath: '/workspace/agent',
        revision: 1,
        createdAt: DAEMON_NOW,
        updatedAt: DAEMON_NOW,
      }],
      providers: [{
        id: 'codex',
        displayName: 'Codex',
        protocol: 'codex-app-server',
        executablePath: 'codex',
        executableVersion: '0.153.4',
        argv: [],
        environmentVariableNames: [],
        capabilities: ['model:gpt-5.6'],
        enabled: true,
        health: 'ready',
        revision: 1,
        createdAt: DAEMON_NOW,
        updatedAt: DAEMON_NOW,
      }],
    });
    vi.spyOn(transport, 'getDaemonSnapshot').mockResolvedValue(authority);
    let sendCount = 0;
    const send = vi.spyOn(transport, 'sendDaemonCommand').mockImplementation(async (command) => {
      sendCount += 1;
      return sendCount === 1 ? {
        ok: false as const,
        status: 'delivery-uncertain' as const,
        commandId: command.commandId,
        revision: authority.revision,
        error: {
          code: 'delivery-uncertain' as const,
          message: 'Connection closed before acknowledgement.',
          retryable: true,
        },
      } : {
        ok: true as const,
        status: 'replayed' as const,
        commandId: command.commandId,
        revision: authority.revision + 1,
        eventSequence: authority.eventSequence + 1,
      };
    });

    let el = renderWorkspace(transport, new MobileAgentCreateRecoveryStore(secure));
    act(() => socket.triggerMessage({ kind: 'daemon-snapshot', snapshot: authority }));
    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-agent-new-session');
    tap(el, 'mobile-agent-new-session');
    await waitForTestId(el, 'mobile-new-session-draft');
    changeSelect(el, 'mobile-new-session-project', 'project-agent');
    changeSelect(el, 'mobile-new-session-workspace', 'workspace-agent');
    fillTextarea(el, 'structured-agent-first-prompt', 'Resume this exact persisted Agent create.');
    tap(el, 'structured-agent-create');
    await flushAsync();

    expect(send).toHaveBeenCalledOnce();
    const originalCommand = send.mock.calls[0]![0];
    expect(originalCommand.type).toBe('agent.create');
    expect(secure.values.size).toBe(1);
    await waitForTestId(el, 'mobile-new-session-delivery-recovery');

    act(() => root!.unmount());
    root = null;
    container!.remove();
    container = null;

    const { transport: otherTransport, socket: otherSocket } = makeAuthedTransport([], 'desktop-b-token');
    vi.spyOn(otherTransport, 'getDaemonSnapshot').mockResolvedValue(authority);
    const otherSend = vi.spyOn(otherTransport, 'sendDaemonCommand');
    el = renderWorkspace(otherTransport, new MobileAgentCreateRecoveryStore(secure));
    act(() => otherSocket.triggerMessage({ kind: 'daemon-snapshot', snapshot: authority }));
    await flushAsync();

    expect(el.querySelector('[data-testid="mobile-new-session-draft"]')).toBeNull();
    expect(otherSend).not.toHaveBeenCalled();
    expect(secure.values.size).toBe(1);

    act(() => root!.unmount());
    root = null;
    container!.remove();
    container = null;

    const remountedStore = new MobileAgentCreateRecoveryStore(secure);
    const loadPersistedRecovery = remountedStore.load.bind(remountedStore);
    let loadedCommand: unknown;
    vi.spyOn(remountedStore, 'load').mockImplementation(async (authorityFingerprint) => {
      const result = await loadPersistedRecovery(authorityFingerprint);
      loadedCommand = result.recovery?.outcome.command;
      return result;
    });
    el = renderWorkspace(transport, remountedStore);
    act(() => socket.triggerMessage({ kind: 'daemon-snapshot', snapshot: authority }));
    await waitForTestId(el, 'mobile-new-session-draft');

    expect(el.querySelector('[data-testid="mobile-new-session-locked-workspace"]')?.textContent)
      .toContain('Mobile Agent Project · Mobile Agent Workspace');
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-first-prompt"]')?.value)
      .toBe('Resume this exact persisted Agent create.');

    tap(el, 'structured-agent-create');
    await flushAsync();

    expect(send).toHaveBeenCalledTimes(2);
    const replayedCommand = send.mock.calls[1]![0];
    expect(replayedCommand).toBe(loadedCommand);
    expect(replayedCommand).toStrictEqual(originalCommand);
    expect(replayedCommand.commandId).toBe(originalCommand.commandId);
    expect(replayedCommand.idempotencyKey).toBe(originalCommand.idempotencyKey);
    if (originalCommand.type !== 'agent.create' || replayedCommand.type !== 'agent.create') {
      throw new Error('Expected the persisted agent.create envelope to be replayed.');
    }
    expect(replayedCommand.payload.sessionId).toBe(originalCommand.payload.sessionId);
    expect(secure.values.size).toBe(0);
    expect(el.querySelector('[data-testid="mobile-structured-agent-session"]')).toBeTruthy();
  });
});

describe('MobileWorkspace - daemon Workspace terminal creation', () => {
  const project = {
    id: 'project-1',
    name: 'EZTerminal',
    source: 'native',
    revision: 1,
    createdAt: DAEMON_NOW,
    updatedAt: DAEMON_NOW,
  } as const;
  const staleWorkspace = {
    id: 'workspace-main',
    projectId: project.id,
    name: 'Main checkout',
    kind: 'local',
    rootPath: '/stale/root',
    revision: 1,
    createdAt: DAEMON_NOW,
    updatedAt: DAEMON_NOW,
  } as const;

  async function openWorkspaceTerminalAction(
    el: HTMLDivElement,
    socket: FakeSocket,
  ): Promise<HTMLButtonElement> {
    act(() => {
      socket.triggerMessage({
        kind: 'daemon-snapshot',
        snapshot: daemonSnapshot({ projects: [project], workspaces: [staleWorkspace] }),
      });
    });
    tap(el, 'shell-tab-agents');
    await waitForTestId(el, 'mobile-daemon-navigator');
    tap(el, 'mobile-daemon-project');
    tap(el, 'mobile-daemon-workspace');
    return waitForTestId(el, 'mobile-daemon-create-session') as Promise<HTMLButtonElement>;
  }

  it('revalidates against a fresh daemon snapshot and owns the new Terminal surface', async () => {
    const { transport, socket } = makeAuthedTransport();
    Object.defineProperty(window, 'ezterminal', { value: transport, configurable: true });
    const authoritativeWorkspace = {
      ...staleWorkspace,
      rootPath: '/authoritative/root',
      revision: 2,
      updatedAt: '2026-09-06T00:01:00.000Z',
    } as const;
    const refresh = vi.spyOn(transport, 'getDaemonSnapshot').mockResolvedValue(daemonSnapshot({
      revision: 2,
      eventSequence: 2,
      projects: [project],
      workspaces: [authoritativeWorkspace],
    }));
    const open = vi.spyOn(transport, 'openSessionSurface').mockImplementation(async (surfaceId) => ({
      ok: true,
      binding: {
        surfaceId,
        bindingId: 'binding-workspace-create',
        session: { sessionId: 'session-workspace-create', cwd: authoritativeWorkspace.rootPath },
        role: 'owner',
      },
    }));
    const el = renderWorkspace(transport);
    const openTerminal = await openWorkspaceTerminalAction(el, socket);

    await act(async () => {
      openTerminal.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^mobile-tab:/),
      { kind: 'create', cwd: authoritativeWorkspace.rootPath },
    );
    expect(el.querySelector('[data-testid="mobile-session-view"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
  });

  it('does not create a surface when the authoritative Project has been archived', async () => {
    const { transport, socket } = makeAuthedTransport();
    vi.spyOn(transport, 'getDaemonSnapshot').mockResolvedValue(daemonSnapshot({
      revision: 2,
      eventSequence: 2,
      projects: [{ ...project, archivedAt: '2026-09-06T00:01:00.000Z' }],
      workspaces: [staleWorkspace],
    }));
    const open = vi.spyOn(transport, 'openSessionSurface');
    const el = renderWorkspace(transport);
    const openTerminal = await openWorkspaceTerminalAction(el, socket);

    await act(async () => {
      openTerminal.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(open).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="mobile-new-session-draft"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-daemon-create-session"]')).toBeTruthy();
    expect(el.textContent)
      .toContain('This Workspace is no longer available.');
  });
});

describe('MobileWorkspace - previous work', () => {
  it('adopts saved terminal views, restores the active one, and does not recreate missing sessions', async () => {
    const { transport } = makeAuthedTransport([], 'restore-host');
    Object.defineProperty(window, 'ezterminal', { value: transport, configurable: true });
    const authority = await mobileAgentCreateAuthorityFingerprint('restore-host');
    writeWorkspaceRestore(authority, { terminalSessionIds: ['one', 'gone', 'two'], activeTerminalSessionId: 'one', activeAgentSessionId: null, destination: 'terminal' });
    const open = vi.spyOn(transport, 'openSessionSurface').mockImplementation(async (surfaceId, intent) => {
      if (intent.kind !== 'adopt' || intent.sessionId === 'gone') throw new Error('gone');
      return { ok: true, binding: { surfaceId, bindingId: `binding-${intent.sessionId}`, session: { sessionId: intent.sessionId, cwd: `/${intent.sessionId}` }, role: 'adopted' } };
    });
    const el = renderWorkspace(transport);
    await flushAsync();
    expect(open.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'adopt', sessionId: 'one' }, { kind: 'adopt', sessionId: 'gone' }, { kind: 'adopt', sessionId: 'two' },
    ]);
    expect(el.querySelector('[data-testid="menu-btn"]')?.textContent).toContain('/one');
    expect(el.querySelector('[data-testid="mobile-terminal-layer"]')?.hasAttribute('inert')).toBe(false);
    expect(readWorkspaceRestore(authority)).toMatchObject({ terminalSessionIds: ['one', 'two'], activeTerminalSessionId: 'one' });
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
