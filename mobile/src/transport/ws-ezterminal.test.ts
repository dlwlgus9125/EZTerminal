import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecureRequestId, WsEzTerminalTransport, type CreateSocket, type WsLike } from './ws-ezterminal';
import type { ConnectionHealthSnapshot, RemoteConnectionState } from './connection-health';
import { BlockController } from '../../../src/renderer/block-controller';
import type { RunStartedInfo, SessionInfo, SystemStatsSnapshot } from '../../../src/shared/ipc';
import { FILE_CHUNK_BYTES } from '../../../src/shared/files';
import {
  REMOTE_PROTOCOL_VERSION,
  base64ToUint8Array,
  encodeFrame,
  uint8ArrayToBase64,
  type RemotePacketFrame,
} from '../../../src/shared/remote-protocol';
import type { OpenClawLogLine, OpenClawStatus } from '../../../src/shared/openclaw';

// ── Fake socket ──────────────────────────────────────────────────────────────

describe('createSecureRequestId', () => {
  it('creates unique RFC 4122 v4 ids using the WebView-compatible crypto primitive', () => {
    const ids = Array.from({ length: 32 }, () => createSecureRequestId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

type Handler = (...args: never[]) => void;

class FakeSocket implements WsLike {
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  private nextSendError: Error | null = null;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    if (this.nextSendError) {
      const error = this.nextSendError;
      this.nextSendError = null;
      throw error;
    }
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    this.handlers[type].push(listener as Handler);
  }

  triggerOpen(): void {
    this.readyState = 1;
    for (const h of this.handlers.open) h();
  }

  triggerMessage(msg: unknown): void {
    const normalized = (msg as { kind?: string })?.kind === 'auth-ok'
      ? {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          hostVersion: '1.0.0-test',
          ...(msg as Record<string, unknown>),
        }
      : msg;
    this.triggerRawMessage(normalized);
  }

  triggerRawMessage(msg: unknown): void {
    if ((msg as { kind?: string })?.kind === 'auth-ok') this.readyState = 1;
    const data = JSON.stringify(msg);
    for (const h of this.handlers.message) h({ data } as never);
  }

  triggerClose(): void {
    this.readyState = 3;
    for (const h of this.handlers.close) h();
  }

  failNextSend(message = 'send failed'): void {
    this.nextSendError = new Error(message);
  }

  lastSent(): unknown {
    return JSON.parse(this.sent.at(-1)!);
  }
}

function makeCreateSocket(): { createSocket: CreateSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const createSocket: CreateSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { createSocket, sockets };
}

/** Captures the `_ezPort` window message TerminalPane.tsx listens for, mirroring
 * its exact contract (source===window, data._ezPort===runId, ports[0]). */
function captureEzPort(runId: string): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezPort?: string })._ezPort !== runId) return;
    expect(ev.source).toBe(window);
    port = ev.ports[0];
  };
  window.addEventListener('message', onMessage);
  return {
    get port() {
      return port;
    },
    stop: () => window.removeEventListener('message', onMessage),
  };
}

/** Captures the `_ezAttachPort` window message TerminalPane.tsx/MobileSessionView.tsx
 * listen for when mirroring a run (M2) — same contract as `captureEzPort` above,
 * keyed by `_ezAttachPort` instead of `_ezPort`. */
function captureEzAttachPort(runId: string): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezAttachPort?: string })._ezAttachPort !== runId) return;
    expect(ev.source).toBe(window);
    port = ev.ports[0];
  };
  window.addEventListener('message', onMessage);
  return {
    get port() {
      return port;
    },
    stop: () => window.removeEventListener('message', onMessage),
  };
}

/** Captures the `_ezPacketPort` window message `subscribePackets()` dispatches
 * (module doc's "same mechanics as runCommand's `_ezPort` handoff"). */
function captureEzPacketPort(): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezPacketPort?: boolean })._ezPacketPort !== true) return;
    expect(ev.source).toBe(window);
    port = ev.ports[0];
  };
  window.addEventListener('message', onMessage);
  return {
    get port() {
      return port;
    },
    stop: () => window.removeEventListener('message', onMessage),
  };
}

describe('WsEzTerminalTransport — auth handshake', () => {
  it('sends an auth envelope with the configured token once the socket opens', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok-123',
      createSocket,
      buildInfo: { appVersion: '1.0.0-test', protocolVersion: REMOTE_PROTOCOL_VERSION, buildSha: 'abc123' },
    });
    sockets[0].triggerOpen();
    expect(sockets[0].lastSent()).toEqual({
      kind: 'auth',
      token: 'tok-123',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      clientVersion: '1.0.0-test',
      buildSha: 'abc123',
    });
  });

  it('adds the install-scoped Android identity without a hardware identifier', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const clientIdentity = {
      clientId: '01947000-0000-4000-8000-000000000001',
      clientName: 'Galaxy Fold',
      platform: 'android' as const,
    };
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, clientIdentity });
    sockets[0].triggerOpen();
    expect(sockets[0].lastSent()).toMatchObject({ kind: 'auth', clientIdentity });
    expect(JSON.stringify(sockets[0].lastSent())).not.toContain('hardware');
  });

  it.each([
    ['missing auth-ok version', { kind: 'auth-ok' }],
    ['unsupported auth-ok version', { kind: 'auth-ok', protocolVersion: 99, hostVersion: '2.0.0' }],
    ['explicit auth failure', {
      kind: 'auth-fail',
      reason: 'incompatible-protocol',
      supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
      hostVersion: '2.0.0',
    }],
  ])('stops reconnecting on %s', (_label, message) => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    const states: RemoteConnectionState[] = [];
    transport.onConnectionStateChange((state) => states.push(state));

    sockets[0].triggerRawMessage(message);

    expect(states.at(-1)).toBe('protocol-incompatible');
    expect(transport.isAuthed).toBe(false);
    expect(transport.retryNow()).toBe(false);
    expect(sockets[0].closed).toBe(true);
  });

  it('ignores application messages before auth and after a protocol rejection', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    const availability: boolean[] = [];
    transport.onOpenClawAvailability((visible) => availability.push(visible));

    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: true });
    expect(availability).not.toContain(true);

    sockets[0].triggerRawMessage({
      kind: 'auth-ok',
      protocolVersion: 99,
      hostVersion: '2.0.0',
    });
    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: true });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    expect(availability).not.toContain(true);
    expect(transport.currentConnectionState).toBe('protocol-incompatible');
    expect(transport.isAuthed).toBe(false);
  });

  it('isAuthed flips true on auth-ok and false on auth-fail', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    expect(transport.isAuthed).toBe(false);
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    expect(transport.isAuthed).toBe(true);
    sockets[0].triggerMessage({ kind: 'auth-fail' });
    expect(transport.isAuthed).toBe(false);
  });

  it('onAuthChange replays the current state immediately, then fires on every transition', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const seen: boolean[] = [];
    const unsub = transport.onAuthChange((authed) => seen.push(authed));
    expect(seen).toEqual([false]); // immediate replay of current state

    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].triggerMessage({ kind: 'auth-ok' }); // repeat — must NOT re-fire (no transition)
    sockets[0].triggerMessage({ kind: 'auth-fail' });
    expect(seen).toEqual([false, true, false]);

    unsub();
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    expect(seen).toEqual([false, true, false]); // no further calls after unsubscribe
  });
});

describe('WsEzTerminalTransport — desktop control', () => {
  it('negotiates capability, correlates start, and relays signaling/status/end events', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => 'desktop-1',
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok', capabilities: ['desktop-control-v1'] });
    expect(transport.supportsDesktopControl).toBe(true);

    const pending = transport.startDesktopControl();
    expect(sockets[0].lastSent()).toEqual({ kind: 'desktop-control-start', requestId: 'desktop-1' });
    const result = {
      kind: 'desktop-control-start-result', requestId: 'desktop-1', ok: true,
      sessionId: '01947000-0000-4000-8000-000000000099', displays: [], selectedDisplayId: null,
      endpoint: { address: '100.64.0.1', port: 7422 },
      capabilities: { ctrlAltDelete: false, clipboardText: true, directTouch: true, multiMonitor: true },
      resumed: false,
    } as const;
    sockets[0].triggerMessage(result);
    await expect(pending).resolves.toEqual(result);

    const signals: unknown[] = [];
    const statuses: unknown[] = [];
    const ended: unknown[] = [];
    transport.onDesktopSignal((message) => signals.push(message));
    transport.onDesktopStatus((message) => statuses.push(message));
    transport.onDesktopEnded((message) => ended.push(message));
    const signal = { kind: 'desktop-signal', sessionId: result.sessionId, signal: { type: 'answer', sdp: 'v=0' } } as const;
    const status = { kind: 'desktop-control-status', sessionId: result.sessionId, state: 'active' } as const;
    const end = { kind: 'desktop-control-ended', sessionId: result.sessionId, reason: 'local-disconnect' } as const;
    sockets[0].triggerMessage(signal);
    sockets[0].triggerMessage(status);
    sockets[0].triggerMessage(end);
    expect(signals).toEqual([signal]);
    expect(statuses).toEqual([status]);
    expect(ended).toEqual([end]);

    expect(transport.sendDesktopSignal(result.sessionId, { type: 'offer', sdp: 'v=0' })).toBe(true);
    expect(sockets[0].lastSent()).toMatchObject({ kind: 'desktop-signal', sessionId: result.sessionId });
    expect(transport.stopDesktopControl(result.sessionId)).toBe(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'desktop-control-stop', sessionId: result.sessionId, reason: 'client-stop' });
  });

  it('fails locally without sending when offline or unsupported', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'desktop-offline' });
    await expect(transport.startDesktopControl()).resolves.toMatchObject({ ok: false, errorCode: 'OFFLINE' });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    await expect(transport.startDesktopControl()).resolves.toMatchObject({ ok: false, errorCode: 'UNSUPPORTED' });
    expect(sockets[0].sent.some((entry) => JSON.parse(entry).kind === 'desktop-control-start')).toBe(false);
  });
});

describe('WsEzTerminalTransport — read-only Quick Commands capability', () => {
  const command = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Check status',
    command: 'git status --short',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  } as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the feature for older hosts without sending an unsupported request', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    expect(transport.supportsRemoteQuickCommands).toBe(false);
    await expect(transport.listRemoteQuickCommands()).resolves.toEqual({ ok: false, error: 'unsupported' });
    expect(sockets[0].sent.some((entry) => JSON.parse(entry).kind === 'quick-commands-list')).toBe(false);
  });

  it('requests, correlates, bounds, and validates an advertised snapshot', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'quick-1',
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok', capabilities: ['quick-commands-read'] });

    expect(transport.supportsRemoteQuickCommands).toBe(true);
    const pending = transport.listRemoteQuickCommands();
    expect(sockets[0].lastSent()).toEqual({ kind: 'quick-commands-list', requestId: 'quick-1' });

    sockets[0].triggerMessage({
      kind: 'quick-commands-list-reply',
      requestId: 'quick-1',
      ok: true,
      commands: [command, { ...command, id: 'invalid' }],
    });
    await expect(pending).resolves.toEqual({ ok: true, commands: [command] });
  });

  it('settles an in-flight request as offline and preserves last-known support across a transient drop', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'quick-drop',
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok', capabilities: ['quick-commands-read'] });

    const pending = transport.listRemoteQuickCommands();
    sockets[0].triggerClose();

    await expect(pending).resolves.toEqual({ ok: false, error: 'offline' });
    expect(transport.supportsRemoteQuickCommands).toBe(true);
    await expect(transport.listRemoteQuickCommands()).resolves.toEqual({ ok: false, error: 'offline' });
  });

  it('re-negotiates support after reconnecting to an older host', () => {
    vi.useFakeTimers();
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 10,
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok', capabilities: ['quick-commands-read'] });
    sockets[0].triggerClose();
    vi.advanceTimersByTime(10);
    sockets[1].triggerOpen();
    sockets[1].triggerMessage({ kind: 'auth-ok' });

    expect(transport.supportsRemoteQuickCommands).toBe(false);
  });
});

describe('WsEzTerminalTransport — createSession / destroySession / listSessions', () => {
  it('createSession() sends create-session and resolves on the matching session-created reply', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.createSession('/tmp');
    expect(sockets[0].lastSent()).toEqual({ kind: 'create-session', requestId: 'req-1', cwd: '/tmp' });

    sockets[0].triggerMessage({
      kind: 'session-created',
      requestId: 'req-1',
      session: { sessionId: 'sess-1', cwd: '/tmp' },
    });

    await expect(promise).resolves.toEqual({ sessionId: 'sess-1', cwd: '/tmp' });
  });

  it('destroySession() sends a destroy-session envelope', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    transport.destroySession('sess-1');
    expect(sockets[0].lastSent()).toEqual({ kind: 'destroy-session', sessionId: 'sess-1' });
  });

  it('destroySessionGuarded() correlates an accepted result by requestId', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'close-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const result = transport.destroySessionGuarded('sess-1', ['run-1', 'run-2']);
    expect(sockets[0].lastSent()).toEqual({
      kind: 'destroy-session-guarded',
      requestId: 'close-1',
      sessionId: 'sess-1',
      expectedActiveRunIds: ['run-1', 'run-2'],
    });
    sockets[0].triggerMessage({
      kind: 'session-destroy-result',
      requestId: 'close-1',
      result: { ok: true },
    });

    await expect(result).resolves.toEqual({ ok: true });
  });

  it('destroySessionsGuarded() delegates one session and fails closed for an unsupported mobile batch', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'batch-close-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    await expect(transport.destroySessionsGuarded([])).resolves.toEqual({ ok: true });
    await expect(transport.destroySessionsGuarded([
      { sessionId: 'sess-1', expectedActiveRunIds: [] },
      { sessionId: 'sess-2', expectedActiveRunIds: [] },
    ])).resolves.toEqual({ ok: false, reason: 'unavailable' });

    const single = transport.destroySessionsGuarded([
      { sessionId: 'sess-1', expectedActiveRunIds: ['run-1'] },
    ]);
    expect(sockets[0].lastSent()).toEqual({
      kind: 'destroy-session-guarded',
      requestId: 'batch-close-1',
      sessionId: 'sess-1',
      expectedActiveRunIds: ['run-1'],
    });
    sockets[0].triggerMessage({
      kind: 'session-destroy-result',
      requestId: 'batch-close-1',
      result: { ok: true },
    });
    await expect(single).resolves.toEqual({ ok: true });
  });

  it('destroySessionGuarded() preserves an authoritative state-changed result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'close-2',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const result = transport.destroySessionGuarded('sess-1', []);
    sockets[0].triggerMessage({
      kind: 'session-destroy-result',
      requestId: 'close-2',
      result: { ok: false, reason: 'state-changed' },
    });

    await expect(result).resolves.toEqual({ ok: false, reason: 'state-changed' });
  });

  it('resolves pending guarded destroys as unavailable on socket loss and explicit disconnect', async () => {
    const dropped = makeCreateSocket();
    const droppedTransport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket: dropped.createSocket,
      newId: () => 'drop-1',
    });
    dropped.sockets[0].triggerMessage({ kind: 'auth-ok' });
    const droppedResult = droppedTransport.destroySessionGuarded('sess-1', []);
    dropped.sockets[0].triggerClose();
    await expect(droppedResult).resolves.toEqual({ ok: false, reason: 'unavailable' });

    const explicit = makeCreateSocket();
    const explicitTransport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket: explicit.createSocket,
      newId: () => 'disconnect-1',
    });
    explicit.sockets[0].triggerMessage({ kind: 'auth-ok' });
    const explicitResult = explicitTransport.destroySessionGuarded('sess-1', []);
    explicitTransport.disconnect();
    await expect(explicitResult).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('explicit disconnect settles every request family through the common unavailable drain', async () => {
    let id = 0;
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => `pending-${++id}`,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const create = transport.createSession();
    const sessions = transport.listSessions();
    const runs = transport.listRuns();
    const guard = transport.destroySessionGuarded('sess-1', []);
    const stats = transport.getStatsHistory();
    const worktrees = transport.executeWorktree({ action: 'list', cwd: '/repo' });
    const agentSnapshot = transport.getAgentActivitySnapshot();
    const followup = transport.sendAgentFollowup('agent-1', 'continue');
    const files = transport.listFiles('/repo');
    const roots = transport.listFileRoots();
    const location = transport.resolveTerminalFileLocation({
      path: '/repo/a.txt',
      cwd: '/repo',
      executionKind: 'local',
    });
    const fileOp = transport.createFolder('/repo', 'new');
    const read = transport.readTextFile('/repo/a.txt');
    const upload = transport.uploadFile('/repo', 'a.bin', new Uint8Array([1]), () => undefined);
    const lifecycle = transport.runOpenClawLifecycle('start');
    const openClawSessions = transport.getOpenClawSessions();
    const config = transport.getOpenClawConfig();
    const configSet = transport.setOpenClawConfig('agents.defaults.model', 'x');
    const ticket = transport.getOpenClawChatTicket();
    const createAssertion = expect(create).rejects.toThrow('Connection to EZTerminal lost');
    const uploadAssertion = expect(upload).rejects.toThrow('Connection to EZTerminal lost');

    transport.disconnect();

    await createAssertion;
    await expect(sessions).resolves.toEqual([]);
    await expect(runs).resolves.toEqual([]);
    await expect(guard).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(stats).resolves.toEqual([]);
    await expect(worktrees).resolves.toMatchObject({ ok: false, error: 'IO_ERROR' });
    await expect(agentSnapshot).resolves.toEqual({ revision: 0, items: [] });
    await expect(followup).resolves.toEqual({ ok: false, error: 'delivery-failed' });
    await expect(files).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(roots).resolves.toEqual([]);
    await expect(location).resolves.toEqual({ ok: false, reason: 'unreadable' });
    await expect(fileOp).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(read).resolves.toEqual({ ok: false, error: expect.any(String) });
    await uploadAssertion;
    await expect(lifecycle).resolves.toEqual({ ok: false, stderr: expect.any(String) });
    await expect(openClawSessions).resolves.toEqual([]);
    await expect(config).resolves.toEqual({ 'agents.defaults.model': 'unset', 'gateway.port': 'unset' });
    await expect(configSet).resolves.toEqual({ ok: false, restartRequired: false, error: expect.any(String) });
    await expect(ticket).resolves.toEqual({ ok: false, reason: 'gateway-unreachable' });
  });

  it('fails FIFO and map requests started after explicit disconnect without sending or retaining waiters', async () => {
    let id = 0;
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => `after-disconnect-${++id}`,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.disconnect();
    const sentBefore = sockets[0].sent.length;

    const sessions = transport.listSessions();
    const files = transport.listFiles('/repo');
    const create = transport.createSession();
    const createAssertion = expect(create).rejects.toThrow('Not connected to EZTerminal');

    await expect(sessions).resolves.toEqual([]);
    await expect(files).resolves.toEqual({ ok: false, error: 'Not connected to EZTerminal' });
    await createAssertion;
    expect(sockets[0].sent).toHaveLength(sentBefore);
  });

  it('fails requests when an authenticated socket is no longer OPEN before its close event', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'closing-request',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].readyState = 2;
    const sentBefore = sockets[0].sent.length;

    await expect(transport.listSessions()).resolves.toEqual([]);
    await expect(transport.listFiles('/closing')).resolves.toEqual({
      ok: false,
      error: 'Not connected to EZTerminal',
    });
    expect(sockets[0].sent).toHaveLength(sentBefore);
  });

  it('still completes explicit disconnect when release-runs send throws', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].failNextSend();

    expect(() => transport.disconnect()).not.toThrow();
    expect(sockets[0].closed).toBe(true);
  });

  it('rolls back FIFO and map correlation when socket.send throws', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'same-request-id',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].failNextSend();
    await expect(transport.listSessions()).resolves.toEqual([]);

    const liveSessions = transport.listSessions();
    sockets[0].triggerMessage({
      kind: 'session-list',
      sessions: [{ sessionId: 'live-session', cwd: '/repo' }],
    });
    await expect(liveSessions).resolves.toEqual([{ sessionId: 'live-session', cwd: '/repo' }]);

    sockets[0].failNextSend();
    await expect(transport.listFiles('/failed')).resolves.toEqual({
      ok: false,
      error: 'Not connected to EZTerminal',
    });

    const liveFiles = transport.listFiles('/live');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-list',
      requestId: 'same-request-id',
      path: '/live',
    });
    const result = { ok: true, path: '/live', parent: '/', entries: [] } as const;
    sockets[0].triggerMessage({
      kind: 'file-list-reply',
      requestId: 'same-request-id',
      result,
    });
    await expect(liveFiles).resolves.toEqual(result);
  });

  it('listSessions() resolves concurrent calls FIFO against unrelated session-list replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const first = transport.listSessions();
    const second = transport.listSessions();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'list-sessions')).toHaveLength(2);

    sockets[0].triggerMessage({ kind: 'session-list', sessions: [{ sessionId: 'a', cwd: '/a' }] });
    sockets[0].triggerMessage({ kind: 'session-list', sessions: [{ sessionId: 'b', cwd: '/b' }] });

    await expect(first).resolves.toEqual([{ sessionId: 'a', cwd: '/a' }]);
    await expect(second).resolves.toEqual([{ sessionId: 'b', cwd: '/b' }]);
  });
});

describe('WsEzTerminalTransport — listRuns (M1 mirror-active-runs)', () => {
  it('listRuns() resolves concurrent calls FIFO against unrelated run-list replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const first = transport.listRuns();
    const second = transport.listRuns();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'list-runs')).toHaveLength(2);

    const runA: RunStartedInfo = { sessionId: 'a', runId: 'run-a', commandText: 'echo a' };
    const runB: RunStartedInfo = { sessionId: 'b', runId: 'run-b', commandText: 'echo b' };
    sockets[0].triggerMessage({ kind: 'run-list', runs: [runA] });
    sockets[0].triggerMessage({ kind: 'run-list', runs: [runB] });

    await expect(first).resolves.toEqual([runA]);
    await expect(second).resolves.toEqual([runB]);
  });

  it('a socket close resolves every in-flight listRuns() call with [] instead of leaving it pending forever', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.listRuns();
    sockets[0].triggerClose();

    await expect(promise).resolves.toEqual([]);
  });
});

describe('WsEzTerminalTransport — runCommand: _ezPort handoff + frame delivery to a REAL BlockController', () => {
  it('delivers InterpreterFrames from the WS to a real BlockController via the reproduced _ezPort message', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({
      kind: 'run-command',
      runId: 'run-1',
      sessionId: 'sess-1',
      commandText: 'ls',
    });
    expect(capture.port).toBeDefined();

    const controller = new BlockController('ls', capture.port!);

    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'schema', columns: [{ name: 'a', type: 'string' }], shape: 'table' },
    });
    expect(controller.getSnapshot().shape).toBe('table');

    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'chunk', start: 0, rows: [{ a: 'x' }] },
    });
    expect(controller.getRow(0)).toEqual({ a: 'x' });

    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-1', frame: { type: 'end', cwd: '/tmp' } });
    expect(controller.getSnapshot().status).toBe('done');
  });

  it('decodes pty-data bytes and replay side-effect suppression before delivery', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPort('run-pty');
    await transport.runCommand('!bash', 'run-pty', 'sess-1');
    capture.stop();

    const controller = new BlockController('!bash', capture.port!);
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-pty',
      frame: { type: 'pty-render-upgrade' },
    });
    const received: Array<{ data: Uint8Array; suppressSideEffects: boolean }> = [];
    controller.setPtyDataSink((data, _onFlushed, metadata) => {
      received.push({ data, suppressSideEffects: metadata.suppressSideEffects });
    });
    const payload = new Uint8Array([104, 105]); // "hi"
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-pty',
      frame: { type: 'pty-data', data: uint8ArrayToBase64(payload), suppressSideEffects: true },
    });

    expect(controller.getPtyFlow().received).toBe(2);
    expect(received).toEqual([{ data: payload, suppressSideEffects: true }]);
  });

  it('relays a control posted to the fake port as {kind:control, runId, control}', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    capture.port!.postMessage({ type: 'cancel' });

    expect(sockets[0].lastSent()).toEqual({ kind: 'control', runId: 'run-1', control: { type: 'cancel' } });
  });

  it('demuxes two concurrent runs — frames never cross runIds', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const captureA = captureEzPort('run-a');
    await transport.runCommand('ls', 'run-a', 'sess-1');
    captureA.stop();
    const captureB = captureEzPort('run-b');
    await transport.runCommand('pwd', 'run-b', 'sess-1');
    captureB.stop();

    const controllerA = new BlockController('ls', captureA.port!);
    const controllerB = new BlockController('pwd', captureB.port!);

    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-a', frame: { type: 'start', commandText: 'ls', cwd: '/a' } });
    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-b', frame: { type: 'start', commandText: 'pwd', cwd: '/b' } });

    expect(controllerA.getSnapshot().startCwd).toBe('/a');
    expect(controllerB.getSnapshot().startCwd).toBe('/b');

    controllerA.cancel();
    expect(sockets[0].lastSent()).toEqual({ kind: 'control', runId: 'run-a', control: { type: 'cancel' } });
  });
});

describe('WsEzTerminalTransport — disconnect / reconnect with backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after the initial backoff and re-authenticates', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    expect(sockets).toHaveLength(1); // not yet — backoff hasn't elapsed

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toMatchObject({
      kind: 'auth', token: 'tok', protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
    sockets[1].triggerMessage({ kind: 'auth-ok' });
  });

  it('fails during reconnect and pre-auth without letting stale waiters steal post-reauth replies', async () => {
    let id = 0;
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => `reconnect-${++id}`,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    await expect(transport.listSessions()).resolves.toEqual([]);
    await expect(transport.listFiles('/during-backoff')).resolves.toEqual({
      ok: false,
      error: 'Not connected to EZTerminal',
    });

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    await expect(transport.listSessions()).resolves.toEqual([]);
    await expect(transport.listFiles('/socket-not-open')).resolves.toEqual({
      ok: false,
      error: 'Not connected to EZTerminal',
    });
    expect(sockets[1].sent).toEqual([]);

    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toMatchObject({
      kind: 'auth', token: 'tok', protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
    const sentBeforeAuth = sockets[1].sent.length;
    await expect(transport.listSessions()).resolves.toEqual([]);
    await expect(transport.listFiles('/before-auth-ok')).resolves.toEqual({
      ok: false,
      error: 'Not connected to EZTerminal',
    });
    expect(sockets[1].sent).toHaveLength(sentBeforeAuth);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    const liveSessions = transport.listSessions();
    const liveFiles = transport.listFiles('/live');
    expect(sockets[1].lastSent()).toEqual({
      kind: 'file-list',
      requestId: 'reconnect-4',
      path: '/live',
    });

    sockets[1].triggerMessage({
      kind: 'session-list',
      sessions: [{ sessionId: 'fresh', cwd: '/live' }],
    });
    const fileResult = { ok: true, path: '/live', parent: '/', entries: [] } as const;
    sockets[1].triggerMessage({
      kind: 'file-list-reply',
      requestId: 'reconnect-4',
      result: fileResult,
    });

    await expect(liveSessions).resolves.toEqual([{ sessionId: 'fresh', cwd: '/live' }]);
    await expect(liveFiles).resolves.toEqual(fileResult);
  });

  it('doubles the backoff on each successive disconnect, capped at maxBackoffMs', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 300,
    });

    sockets[0].triggerClose(); // 1st disconnect: reconnect scheduled at 100ms
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerClose(); // 2nd disconnect: backoff doubled to 200ms
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2].triggerClose(); // 3rd disconnect: would double to 400ms, capped at 300ms
    vi.advanceTimersByTime(300);
    expect(sockets).toHaveLength(4);
  });

  it('a fully successful reconnect (auth-ok) resets the backoff back to the initial value', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100); // backoff now 200ms for the NEXT disconnect
    sockets[1].triggerMessage({ kind: 'auth-ok' }); // resets backoff to 100ms

    sockets[1].triggerClose();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('after a successful reconnect, createSession works again on the NEW socket', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerOpen();
    sockets[1].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.createSession();
    expect(sockets[1].lastSent()).toEqual({ kind: 'create-session', requestId: 'req-1', cwd: undefined });
    sockets[1].triggerMessage({
      kind: 'session-created',
      requestId: 'req-1',
      session: { sessionId: 'new-sess', cwd: '/' },
    });
    await expect(promise).resolves.toEqual({ sessionId: 'new-sess', cwd: '/' });
  });

  it('disconnect() stops further reconnect attempts', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    transport.disconnect();
    expect(sockets[0].closed).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // no reconnect scheduled after an explicit stop
  });

  it('keeps open ports stable when a transient connection drops', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    const received: unknown[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerClose();

    expect(received).toEqual([]);
  });

  it('resumes stable ports active-session-first and resets only on the current ready generation', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const first = captureEzPort('run-a');
    await transport.runCommand('!bash', 'run-a', 'sess-a');
    first.stop();
    const second = captureEzPort('run-b');
    await transport.runCommand('!bash', 'run-b', 'sess-b');
    second.stop();
    const controller = new BlockController('!bash', second.port!);
    const restoreOrder: string[] = [];
    controller.setPtyReplayResetHandler(() => restoreOrder.push('reset'));
    controller.setPlainDataSink(() => restoreOrder.push('data'));
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-b',
      frame: { type: 'schema', columns: [], shape: 'pty' },
    });
    expect(controller.getSnapshot().shape).toBe('pty');

    transport.setReattachPriority('sess-b');
    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });

    const resumes = sockets[1].sent.map((value) => JSON.parse(value)).filter((msg) => msg.kind === 'resume-run');
    expect(resumes).toEqual([
      { kind: 'resume-run', sessionId: 'sess-b', runId: 'run-b', generation: 2 },
      { kind: 'resume-run', sessionId: 'sess-a', runId: 'run-a', generation: 2 },
    ]);

    sockets[1].triggerMessage({
      kind: 'resume-run-ready',
      sessionId: 'sess-b',
      runId: 'run-b',
      generation: 1,
    });
    expect(controller.getSnapshot().shape).toBe('pty');
    sockets[1].triggerMessage({
      kind: 'resume-run-ready',
      sessionId: 'sess-b',
      runId: 'run-b',
      generation: 2,
    });
    expect(controller.getSnapshot().shape).toBeNull();
    sockets[1].triggerMessage({
      kind: 'frame',
      runId: 'run-b',
      frame: { type: 'pty-restore-warning', reason: 'semantic-gap', fallback: 'raw-ring' },
    });
    restoreOrder.push(controller.getSnapshot().ptyRestoreWarning ? 'warning' : 'missing-warning');
    sockets[1].triggerMessage({
      kind: 'frame',
      runId: 'run-b',
      frame: { type: 'pty-data', data: 'eA==' },
    });
    expect(restoreOrder).toEqual(['reset', 'warning', 'data']);
    sockets[1].triggerMessage({
      kind: 'frame',
      runId: 'run-b',
      frame: { type: 'schema', columns: [], shape: 'pty' },
    });
    expect(controller.getSnapshot().shape).toBe('pty');
  });

  it('retries capacity-busy resumes with bounded exponential backoff and preserves the stable port', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    const capture = captureEzPort('run-1');
    await transport.runCommand('!bash', 'run-1', 'sess-1');
    capture.stop();
    const received: unknown[] = [];
    capture.port!.addEventListener('message', (event) => received.push((event as MessageEvent).data));

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    const resumeCount = (): number => sockets[1].sent
      .map((value) => JSON.parse(value))
      .filter((message) => message.kind === 'resume-run').length;
    expect(resumeCount()).toBe(1);

    for (const delay of [250, 500, 1_000, 2_000, 4_000]) {
      sockets[1].triggerMessage({
        kind: 'resume-run-busy',
        sessionId: 'sess-1',
        runId: 'run-1',
        generation: 2,
        reason: 'capacity',
        retryable: true,
      });
      vi.advanceTimersByTime(delay - 1);
      expect(resumeCount()).toBeLessThan(6);
      vi.advanceTimersByTime(1);
    }
    expect(resumeCount()).toBe(6); // initial resume + five bounded retries

    sockets[1].triggerMessage({
      kind: 'resume-run-busy',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
      reason: 'capacity',
      retryable: true,
    });
    vi.advanceTimersByTime(10_000);
    expect(resumeCount()).toBe(6);
    expect(received).toContainEqual({ type: 'error', message: 'This run stayed busy and could not be resumed' });

    // Exhaustion is terminal for this generation, not for the stable block:
    // a later socket generation gets a fresh resume attempt.
    sockets[1].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[2].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[2].sent.map((value) => JSON.parse(value))).toContainEqual({
      kind: 'resume-run',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 3,
    });
  });

  it('clears a pending capacity retry when ready or missing becomes authoritative', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    const readyCapture = captureEzPort('run-ready');
    await transport.runCommand('!bash', 'run-ready', 'sess-1');
    readyCapture.stop();
    const missingCapture = captureEzPort('run-missing');
    await transport.runCommand('!bash', 'run-missing', 'sess-1');
    missingCapture.stop();
    const missingFrames: unknown[] = [];
    missingCapture.port!.addEventListener('message', (event) => missingFrames.push((event as MessageEvent).data));

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    const resumeCount = (): number => sockets[1].sent
      .map((value) => JSON.parse(value))
      .filter((message) => message.kind === 'resume-run').length;
    expect(resumeCount()).toBe(2);

    for (const runId of ['run-ready', 'run-missing']) {
      sockets[1].triggerMessage({
        kind: 'resume-run-busy',
        sessionId: 'sess-1',
        runId,
        generation: 2,
        reason: 'capacity',
        retryable: true,
      });
    }
    sockets[1].triggerMessage({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-ready',
      generation: 2,
    });
    sockets[1].triggerMessage({
      kind: 'resume-run-missing',
      sessionId: 'sess-1',
      runId: 'run-missing',
      generation: 2,
    });

    vi.advanceTimersByTime(1_000);
    expect(resumeCount()).toBe(2);
    expect(missingFrames).toContainEqual({
      type: 'error',
      message: 'This run expired before it could be resumed',
    });
  });

  it('clears a pending capacity retry when its socket disconnects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 1_000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    await transport.runCommand('!bash', 'run-1', 'sess-1');
    sockets[0].triggerClose();
    vi.advanceTimersByTime(1_000);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    const sentBeforeBusy = sockets[1].sent.length;
    sockets[1].triggerMessage({
      kind: 'resume-run-busy',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
      reason: 'capacity',
      retryable: true,
    });

    sockets[1].triggerClose();
    vi.advanceTimersByTime(250);
    expect(sockets[1].sent).toHaveLength(sentBeforeBusy);
    expect(sockets).toHaveLength(2);
  });

  it('closes a stable port immediately for a non-retryable unsupported resume', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    const capture = captureEzPort('run-ssh');
    await transport.runCommand('ssh host', 'run-ssh', 'sess-1');
    capture.stop();
    const received: unknown[] = [];
    capture.port!.addEventListener('message', (event) => received.push((event as MessageEvent).data));

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    sockets[1].triggerMessage({
      kind: 'resume-run-busy',
      sessionId: 'sess-1',
      runId: 'run-ssh',
      generation: 2,
      reason: 'unsupported',
      retryable: false,
    });

    expect(received).toContainEqual({ type: 'error', message: 'Active SSH runs cannot be resumed on this device' });
    const sentAfterFailure = sockets[1].sent.length;
    capture.port!.postMessage({ type: 'cancel' });
    expect(sockets[1].sent).toHaveLength(sentAfterFailure);
  });

  it('sends release-runs on explicit disconnect and stops retrying after auth rejection', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'bad', createSocket, initialBackoffMs: 100 });
    const states: string[] = [];
    transport.onConnectionStateChange((state) => states.push(state));
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    transport.disconnect();
    expect(sockets[0].sent.map((value) => JSON.parse(value).kind)).toContain('release-runs');

    const rejected = new WsEzTerminalTransport({ url: 'ws://x', token: 'bad', createSocket, initialBackoffMs: 100 });
    sockets[1].triggerMessage({ kind: 'auth-fail', reason: 'invalid-token' });
    expect(rejected.currentConnectionState).toBe('auth-rejected');
    sockets[1].triggerClose();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(states).toContain('disconnected');
  });
});

describe('WsEzTerminalTransport — connection health and explicit retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes attempt count, next retry, and resets after auth-ok', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'wss://desktop.example.ts.net:8443',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    const snapshots: ConnectionHealthSnapshot[] = [];
    let latest: ConnectionHealthSnapshot | null = null;
    const getLastHealth = () => latest!;
    transport.onConnectionHealthChange((snapshot) => {
      latest = snapshot;
      snapshots.push(snapshot);
    });

    sockets[0].triggerMessage({ kind: 'auth-ok' });
    expect(getLastHealth()).toMatchObject({ state: 'connected', attempt: 0, endpointKind: 'tailscale' });

    sockets[0].triggerClose();
    expect(getLastHealth()).toMatchObject({ state: 'reconnecting', attempt: 1 });
    expect(getLastHealth().nextRetryAt).toBe(Date.now() + 100);

    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(getLastHealth()).toMatchObject({ state: 'connected', attempt: 0, nextRetryAt: null });
    expect(snapshots.length).toBeGreaterThan(3);
  });

  it('retryNow cancels the pending backoff and creates exactly one fresh socket', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].triggerClose();

    expect(transport.retryNow()).toBe(true);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });

  it('allows one explicit fresh handshake after auth rejection', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].triggerMessage({ kind: 'auth-fail', reason: 'transient' });
    expect(transport.currentConnectionState).toBe('auth-rejected');

    expect(transport.retryNow()).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toMatchObject({
      kind: 'auth', token: 'tok', protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
  });

  it('returns bounded redacted diagnostics', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'wss://secret-host.example:8443/private',
      token: 'super-secret-token',
      createSocket,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    const diagnostics = transport.getConnectionDiagnostics();
    expect(diagnostics).toContain('endpointKind=other');
    expect(diagnostics).not.toContain('secret-host');
    expect(diagnostics).not.toContain('super-secret-token');
  });
});

describe('WsEzTerminalTransport — auth watchdog (self-heals a stuck attempt)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons and retries a socket that never opens (auth never reached)', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000); // watchdog fires: abandons socket 0, schedules reconnect
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(100); // backoff elapses
    expect(sockets).toHaveLength(2); // a fresh attempt, self-healed
  });

  it('abandons and retries a HALF-OPEN socket (opened + auth sent, but no auth-ok and no close)', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    sockets[0].triggerOpen();
    expect(sockets[0].lastSent()).toMatchObject({
      kind: 'auth', token: 'tok', protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
    // No auth-ok, no close — the exact stall that used to hang "Connecting…" forever.
    vi.advanceTimersByTime(1000 + 100);
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toMatchObject({
      kind: 'auth', token: 'tok', protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
    sockets[1].triggerMessage({ kind: 'auth-ok' }); // the retry authenticates cleanly
  });

  it('auth-ok clears the watchdog — no spurious reconnect', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    vi.advanceTimersByTime(10_000); // long past the watchdog — must NOT fire on a live connection
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(false);
  });

  it('a watchdog abandon followed by a LATE real close does not double-schedule a reconnect', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    vi.advanceTimersByTime(1000); // watchdog abandons socket 0
    sockets[0].triggerClose(); // its real 'close' arrives late — must be a no-op (idempotent)
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2); // exactly ONE reconnect, not two
  });

  it('disconnect() also clears the watchdog', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    transport.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // no watchdog-driven reconnect after an explicit stop
  });
});

describe('WsEzTerminalTransport — onSessionDead', () => {
  it('fires registered listeners on a session-dead message, and unsubscribe works', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const calls: Array<{ logPath?: string | null } | undefined> = [];
    const unsub = transport.onSessionDead((info) => calls.push(info));

    sockets[0].triggerMessage({ kind: 'session-dead', logPath: '/logs/main.log' });
    expect(calls).toEqual([{ logPath: '/logs/main.log' }]);

    unsub();
    sockets[0].triggerMessage({ kind: 'session-dead', logPath: '/logs/main.log' });
    expect(calls).toHaveLength(1); // no further calls after unsubscribe
  });
});

describe('WsEzTerminalTransport — session mirroring (M2)', () => {
  it('onSessionAdded/onSessionRemoved fire on the matching broadcast; unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const added: SessionInfo[] = [];
    const removed: string[] = [];
    const unsubAdded = transport.onSessionAdded((s) => added.push(s));
    const unsubRemoved = transport.onSessionRemoved((id) => removed.push(id));

    sockets[0].triggerMessage({ kind: 'session-added', session: { sessionId: 'a', cwd: '/a' } });
    sockets[0].triggerMessage({ kind: 'session-removed', sessionId: 'a' });
    expect(added).toEqual([{ sessionId: 'a', cwd: '/a' }]);
    expect(removed).toEqual(['a']);

    unsubAdded();
    unsubRemoved();
    sockets[0].triggerMessage({ kind: 'session-added', session: { sessionId: 'b', cwd: '/b' } });
    sockets[0].triggerMessage({ kind: 'session-removed', sessionId: 'b' });
    expect(added).toHaveLength(1); // no further calls after unsubscribe
    expect(removed).toHaveLength(1);
  });

  it('onRunStarted fires with sessionId/runId/commandText on a run-started broadcast', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const seen: RunStartedInfo[] = [];
    transport.onRunStarted((info) => seen.push(info));

    sockets[0].triggerMessage({
      kind: 'run-started',
      sessionId: 'sess-1',
      runId: 'run-9',
      commandText: 'ls',
    });

    expect(seen).toEqual([{ sessionId: 'sess-1', runId: 'run-9', commandText: 'ls' }]);
  });

  it('attachRun() sends attach-run and dispatches the _ezAttachPort handoff, delivering frames for that runId to a real BlockController', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzAttachPort('run-9');
    await transport.attachRun('sess-1', 'run-9');
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({ kind: 'attach-run', sessionId: 'sess-1', runId: 'run-9' });
    expect(capture.port).toBeDefined();

    const controller = new BlockController('mirrored', capture.port!);
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-9',
      frame: { type: 'start', commandText: 'ls', cwd: '/a' },
    });
    expect(controller.getSnapshot().startCwd).toBe('/a');
  });

  it('relays a control posted to an attached port as {kind:control, runId, control}', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzAttachPort('run-9');
    await transport.attachRun('sess-1', 'run-9');
    capture.stop();

    capture.port!.postMessage({ type: 'pty-input', data: 'hi' });

    expect(sockets[0].lastSent()).toEqual({
      kind: 'control',
      runId: 'run-9',
      control: { type: 'pty-input', data: 'hi' },
    });
  });
});

describe('WsEzTerminalTransport — Agent Activity', () => {
  it('keeps the newest revision, correlates snapshot requests, and forwards followup results', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    let id = 0;
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => `req-${++id}`,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const seen: number[] = [];
    const unsubscribe = transport.onAgentActivitySnapshot((snapshot) => seen.push(snapshot.revision));
    expect(seen).toEqual([0]);
    const activity = {
      id: 'activity-1',
      sessionId: 'sess-1',
      provider: 'codex',
      cwd: '/repo',
      status: 'waiting',
      createdAt: 1,
      updatedAt: 2,
    };
    sockets[0].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 2, items: [activity] } });
    sockets[0].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 1, items: [] } });
    expect(seen).toEqual([0, 2]);

    const snapshotPromise = transport.getAgentActivitySnapshot();
    expect(sockets[0].lastSent()).toEqual({ kind: 'agent-snapshot-get', requestId: 'req-1' });
    sockets[0].triggerMessage({
      kind: 'agent-snapshot',
      requestId: 'req-1',
      snapshot: { revision: 3, items: [{ ...activity, status: 'working', updatedAt: 3 }] },
    });
    await expect(snapshotPromise).resolves.toMatchObject({ revision: 3 });

    const followupPromise = transport.sendAgentFollowup('activity-1', 'continue');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'agent-followup',
      requestId: 'req-2',
      activityId: 'activity-1',
      text: 'continue',
    });
    sockets[0].triggerMessage({ kind: 'agent-followup-reply', requestId: 'req-2', result: { ok: true } });
    await expect(followupPromise).resolves.toEqual({ ok: true });
    unsubscribe();
  });

  it('fails followup locally while unauthenticated', async () => {
    const { createSocket } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    await expect(transport.sendAgentFollowup('activity-1', 'continue')).resolves.toEqual({
      ok: false,
      error: 'delivery-failed',
    });
  });

  it('treats the first snapshot after reconnect as a new desktop revision epoch', () => {
    vi.useFakeTimers();
    try {
      const { createSocket, sockets } = makeCreateSocket();
      const transport = new WsEzTerminalTransport({
        url: 'ws://x',
        token: 'tok',
        createSocket,
        initialBackoffMs: 100,
      });
      const activity = {
        id: 'old-activity',
        sessionId: 'sess-1',
        provider: 'codex' as const,
        cwd: '/old',
        status: 'working' as const,
        createdAt: 1,
        updatedAt: 2,
      };
      const seen: Array<{ revision: number; count: number }> = [];
      transport.onAgentActivitySnapshot((snapshot) => {
        seen.push({ revision: snapshot.revision, count: snapshot.items.length });
      });
      sockets[0].triggerMessage({ kind: 'auth-ok' });
      sockets[0].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 50, items: [activity] } });

      sockets[0].triggerClose();
      vi.advanceTimersByTime(100);
      sockets[1].triggerMessage({ kind: 'auth-ok' });
      sockets[1].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 0, items: [] } });
      sockets[1].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 1, items: [activity] } });
      sockets[1].triggerMessage({ kind: 'agent-snapshot', snapshot: { revision: 0, items: [] } });

      expect(seen).toEqual([
        { revision: 0, count: 0 },
        { revision: 50, count: 1 },
        { revision: 0, count: 0 },
        { revision: 1, count: 1 },
      ]);
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsEzTerminalTransport — desktop-only EzTerminalApi stubs', () => {
  it('getRemoteToken() resolves with the token this transport actually connected with', async () => {
    const { createSocket } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'my-token', createSocket });
    await expect(transport.getRemoteToken()).resolves.toBe('my-token');
  });
});

// ── Stats (M2) ───────────────────────────────────────────────────────────────

function makeSnapshot(at: number): SystemStatsSnapshot {
  return {
    at,
    cpu: { loadPct: 10, cores: [10, 20] },
    mem: { usedBytes: 100, totalBytes: 200 },
    memDetail: null,
    net: null,
    disks: null,
    procs: null,
    conns: null,
  };
}

describe('WsEzTerminalTransport — stats', () => {
  it('setStatsPanelVisible(true) sends a stats-visible envelope once authed; repeats do not crash', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'stats-visible', visible: true });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(2);
  });

  it('does not send stats-visible before auth-ok — only records the desired state for later replay', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(0);
  });

  it('fans out stats-update to multiple listeners; unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const seenA: SystemStatsSnapshot[] = [];
    const seenB: SystemStatsSnapshot[] = [];
    const unsubA = transport.onStatsUpdate((s) => seenA.push(s));
    const unsubB = transport.onStatsUpdate((s) => seenB.push(s));

    const snap1 = makeSnapshot(1);
    sockets[0].triggerMessage({ kind: 'stats-update', snapshot: snap1 });
    expect(seenA).toEqual([snap1]);
    expect(seenB).toEqual([snap1]);

    unsubA();
    const snap2 = makeSnapshot(2);
    sockets[0].triggerMessage({ kind: 'stats-update', snapshot: snap2 });
    expect(seenA).toEqual([snap1]); // unsubscribed — no further delivery
    expect(seenB).toEqual([snap1, snap2]);

    unsubB();
  });

  it('getStatsHistory() resolves concurrent calls FIFO against unrelated stats-history replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const first = transport.getStatsHistory();
    const second = transport.getStatsHistory();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-history')).toHaveLength(2);

    const snapA = makeSnapshot(1);
    const snapB = makeSnapshot(2);
    sockets[0].triggerMessage({ kind: 'stats-history', snapshots: [snapA] });
    sockets[0].triggerMessage({ kind: 'stats-history', snapshots: [snapB] });

    await expect(first).resolves.toEqual([snapA]);
    await expect(second).resolves.toEqual([snapB]);
  });
});

describe('WsEzTerminalTransport — stats reconnect replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays stats-visible:true on the reconnect auth-ok when stats were enabled beforehand', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    transport.setStatsPanelVisible(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'stats-visible', visible: true });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].lastSent()).toEqual({ kind: 'stats-visible', visible: true });
  });

  it('does not replay stats-visible on reconnect if it was never enabled', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(0);
  });
});

// ── Packets (M3) ─────────────────────────────────────────────────────────────

describe('WsEzTerminalTransport — packets', () => {
  it('subscribePackets() sends packets-subscribe once authed and dispatches the _ezPacketPort handoff', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(capture.port).toBeDefined();
  });

  it('does not send packets-subscribe before auth — only records the desired state for later replay', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    transport.subscribePackets();

    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'packets-subscribe')).toHaveLength(0);
  });

  it('delivers packet-frame batch and status frames to the handed-off port', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    const received: RemotePacketFrame[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerMessage({ kind: 'packet-frame', frame: { type: 'status', status: 'capturing' } });
    sockets[0].triggerMessage({
      kind: 'packet-frame',
      frame: { type: 'packets', rows: [{ at: 1, src: '1.1.1.1', dst: '2.2.2.2', proto: 'TCP', len: 60 }] },
    });

    expect(received).toEqual([
      { type: 'status', status: 'capturing' },
      { type: 'packets', rows: [{ at: 1, src: '1.1.1.1', dst: '2.2.2.2', proto: 'TCP', len: 60 }] },
    ]);
  });

  it('delivers an idle status frame the same way as any other status', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    const received: RemotePacketFrame[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerMessage({ kind: 'packet-frame', frame: { type: 'status', status: 'idle' } });

    expect(received).toEqual([{ type: 'status', status: 'idle' }]);
  });

  it('unsubscribePackets() sends packets-unsubscribe and closes the port', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    transport.unsubscribePackets();

    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-unsubscribe' });
    expect((capture.port as unknown as { isDisposed: boolean }).isDisposed).toBe(true);
  });
});

describe('WsEzTerminalTransport — packets reconnect replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays packets-subscribe on the reconnect auth-ok WITHOUT a second _ezPacketPort handoff', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    let handoffs = 0;
    const onHandoff = (ev: MessageEvent): void => {
      if (ev.data && (ev.data as { _ezPacketPort?: boolean })._ezPacketPort === true) handoffs++;
    };
    window.addEventListener('message', onHandoff);

    transport.subscribePackets();
    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(handoffs).toBe(1);

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(handoffs).toBe(1); // same FakeMessagePort reused — no second handoff

    window.removeEventListener('message', onHandoff);
  });

  it('does not replay packets-subscribe on reconnect if it was never enabled', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].sent.filter((s) => JSON.parse(s).kind === 'packets-subscribe')).toHaveLength(0);
  });
});

describe('WsEzTerminalTransport - Git worktrees', () => {
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

  it('round-trips list/open requests by requestId', async () => {
    let id = 0;
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => `wt-${++id}`,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const list = transport.executeWorktree({ action: 'list', cwd: '/repo' });
    expect(sockets[0].lastSent()).toEqual({
      kind: 'worktree-request',
      requestId: 'wt-1',
      request: { action: 'list', cwd: '/repo' },
    });
    sockets[0].triggerMessage({
      kind: 'worktree-reply',
      requestId: 'wt-1',
      result: { ok: true, action: 'list', worktrees: [] },
    });

    const open = transport.executeWorktree({ action: 'open', cwd: '/repo', worktreeId: 'managed-1' });
    expect(sockets[0].lastSent()).toEqual({
      kind: 'worktree-request',
      requestId: 'wt-2',
      request: { action: 'open', cwd: '/repo', worktreeId: 'managed-1' },
    });
    sockets[0].triggerMessage({
      kind: 'worktree-reply',
      requestId: 'wt-2',
      result: {
        ok: false,
        action: 'open',
        error: 'WORKTREE_NOT_FOUND',
        message: 'Unknown worktree.',
      },
    });

    await expect(list).resolves.toEqual({ ok: true, action: 'list', worktrees: [] });
    await expect(open).resolves.toEqual({
      ok: false,
      action: 'open',
      error: 'WORKTREE_NOT_FOUND',
      message: 'Unknown worktree.',
    });
  });

  it('settles an in-flight request with IO_ERROR when the socket drops', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'wt-1',
      initialBackoffMs: 60_000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const pending = transport.executeWorktree({ action: 'list', cwd: '/repo' });
    sockets[0].triggerClose();

    await expect(pending).resolves.toEqual({
      ok: false,
      action: 'list',
      error: 'IO_ERROR',
      message: 'Connection to EZTerminal lost.',
    });
    transport.disconnect();
  });

  it('notifies the mobile tab seam for a correlated direct open success', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'wt-open',
    });
    const opened = vi.fn();
    transport.onWorktreeOpenRequested(opened);
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const pending = transport.executeWorktree({ action: 'open', cwd: '/repo', worktreeId: 'wt-1' });
    sockets[0].triggerMessage({
      kind: 'worktree-reply',
      requestId: 'wt-open',
      result: { ok: true, action: 'open', worktrees: [worktree], opened: worktree },
    });

    await expect(pending).resolves.toMatchObject({ ok: true, action: 'open', opened: worktree });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(worktree);
  });

  it('acts on a worktree-open frame only for the initiating port, never an attach mirror', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    const opened = vi.fn();
    transport.onWorktreeOpenRequested(opened);
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    await transport.runCommand('worktree open wt-1', 'primary-run', 'session-1');
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'primary-run',
      frame: encodeFrame({ type: 'worktree-open', intentId: 'intent-1', worktree }),
    });
    expect(opened).toHaveBeenCalledTimes(1);

    // Attach replay of an already-consumed intent is exactly-once.
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'primary-run',
      frame: encodeFrame({ type: 'worktree-open', intentId: 'intent-1', worktree }),
    });
    expect(opened).toHaveBeenCalledTimes(1);

    await transport.attachRun('session-1', 'mirror-run');
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'mirror-run',
      frame: encodeFrame({ type: 'worktree-open', intentId: 'intent-2', worktree }),
    });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('fails immediately while unauthenticated instead of leaving a promise pending', async () => {
    const { createSocket } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    await expect(transport.executeWorktree({ action: 'list', cwd: '/repo' })).resolves.toEqual({
      ok: false,
      action: 'list',
      error: 'IO_ERROR',
      message: 'Not connected to EZTerminal.',
    });
    transport.disconnect();
  });
});

describe('WsEzTerminalTransport — file explorer (M4)', () => {
  it('listFiles sends file-list and resolves with the reply result, correlated by requestId', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.listFiles('C:\\x');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-list', requestId: 'req-1', path: 'C:\\x' });

    const result = { ok: true, path: 'C:\\x', parent: null, entries: [] };
    sockets[0].triggerMessage({ kind: 'file-list-reply', requestId: 'req-1', result });
    await expect(promise).resolves.toEqual(result);
  });

  it('listFileRoots sends file-roots and resolves with a mutable copy of the roots array', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.listFileRoots();
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-roots', requestId: 'req-1' });

    sockets[0].triggerMessage({ kind: 'file-roots-reply', requestId: 'req-1', roots: ['C:\\', 'D:\\'] });
    await expect(promise).resolves.toEqual(['C:\\', 'D:\\']);
  });

  it('resolves an explicit terminal file location through the desktop policy', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    const request = { path: './src/a.ts', cwd: 'C:\\repo', line: 3, executionKind: 'local' as const };
    const promise = transport.resolveTerminalFileLocation(request);
    expect(sockets[0].lastSent()).toEqual({ kind: 'terminal-file-location', requestId: 'req-1', request });
    const result = { ok: true as const, path: 'C:\\repo\\src\\a.ts', capability: 'terminal-cap-1', line: 3 };
    sockets[0].triggerMessage({ kind: 'terminal-file-location-reply', requestId: 'req-1', result });
    await expect(promise).resolves.toEqual(result);
  });

  it('createFolder sends file-mkdir and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.createFolder('C:\\x', 'new');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-mkdir', requestId: 'req-1', dirPath: 'C:\\x', name: 'new' });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('renameFile sends file-rename and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.renameFile('C:\\x\\a.txt', 'b.txt');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-rename',
      requestId: 'req-1',
      path: 'C:\\x\\a.txt',
      newName: 'b.txt',
    });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: false, error: 'boom' } });
    await expect(promise).resolves.toEqual({ ok: false, error: 'boom' });
  });

  it('trashFile sends file-trash and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.trashFile('C:\\x\\a.txt');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-trash', requestId: 'req-1', path: 'C:\\x\\a.txt' });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('readTextFile streams meta + ack-gated chunks, reassembling exact bytes with correct ack offsets', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\a.txt');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-read', requestId: 'req-1', path: 'C:\\a.txt', mode: 'text' });

    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 5,
      sendBytes: 5,
      isText: true,
      truncated: false,
    });

    const chunk1 = uint8ArrayToBase64(new Uint8Array([104, 101, 108])); // 'hel'
    sockets[0].triggerMessage({ kind: 'file-read-chunk', requestId: 'req-1', offset: 0, data: chunk1, done: false });
    // The ack for chunk 1 must be sent before chunk 2 ever arrives (ack-gated streaming).
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-read-ack', requestId: 'req-1', offset: 3 });

    const chunk2 = uint8ArrayToBase64(new Uint8Array([108, 111])); // 'lo'
    sockets[0].triggerMessage({ kind: 'file-read-chunk', requestId: 'req-1', offset: 3, data: chunk2, done: true });

    await expect(promise).resolves.toEqual({
      ok: true,
      isText: true,
      content: 'hello',
      truncated: false,
      fileSize: 5,
    });
  });

  it('readFilePreview reconstructs a magic-classified image from metadata and streamed bytes', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readFilePreview('C:\\photo.data');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-read',
      requestId: 'req-1',
      path: 'C:\\photo.data',
      mode: 'preview',
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: bytes.length,
      sendBytes: bytes.length,
      isText: false,
      truncated: false,
      preview: { kind: 'image', name: 'photo.data', mime: 'image/png', width: 20, height: 10 },
    });
    sockets[0].triggerMessage({
      kind: 'file-read-chunk',
      requestId: 'req-1',
      offset: 0,
      data: uint8ArrayToBase64(bytes),
      done: true,
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      kind: 'image',
      name: 'photo.data',
      mime: 'image/png',
      bytes,
      width: 20,
      height: 10,
      fileSize: bytes.length,
    });
  });

  it('readFilePreview resolves PDF metadata without receiving file bytes', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readFilePreview('C:\\report.bin', 'terminal-cap-1');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-read',
      requestId: 'req-1',
      path: 'C:\\report.bin',
      mode: 'preview',
      terminalCapability: 'terminal-cap-1',
    });
    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 42,
      sendBytes: 0,
      isText: false,
      truncated: false,
      preview: { kind: 'pdf', name: 'report.bin', mime: 'application/pdf' },
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      kind: 'pdf',
      name: 'report.bin',
      mime: 'application/pdf',
      fileSize: 42,
    });
  });

  it('readTextFile resolves isText:false without ever sending an ack (no chunk follows a binary meta)', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\a.bin');
    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 10,
      sendBytes: 0,
      isText: false,
      truncated: false,
    });

    await expect(promise).resolves.toEqual({ ok: true, isText: false, fileSize: 10 });
    expect(sockets[0].sent.some((s) => (JSON.parse(s) as { kind: string }).kind === 'file-read-ack')).toBe(false);
  });

  it('readTextFile resolves ok:false when file-read-meta reports a failure', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\missing.txt');
    sockets[0].triggerMessage({ kind: 'file-read-meta', requestId: 'req-1', ok: false, error: 'ENOENT' });

    await expect(promise).resolves.toEqual({ ok: false, error: 'ENOENT' });
  });

  it('downloadFile (raw mode) reports progress after each chunk and resolves with the reassembled bytes', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const progress: Array<[number, number]> = [];
    const promise = transport.downloadFile('C:\\x\\photo.png', (received, total) =>
      progress.push([received, total]),
    );
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-read',
      requestId: 'req-1',
      path: 'C:\\x\\photo.png',
      mode: 'raw',
    });

    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 5,
      sendBytes: 5,
      isText: true,
      truncated: false,
    });

    const chunk1 = new Uint8Array([1, 2, 3]);
    sockets[0].triggerMessage({
      kind: 'file-read-chunk',
      requestId: 'req-1',
      offset: 0,
      data: uint8ArrayToBase64(chunk1),
      done: false,
    });
    const chunk2 = new Uint8Array([4, 5]);
    sockets[0].triggerMessage({
      kind: 'file-read-chunk',
      requestId: 'req-1',
      offset: 3,
      data: uint8ArrayToBase64(chunk2),
      done: true,
    });

    const result = await promise;
    expect(result.name).toBe('photo.png');
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(progress).toEqual([
      [3, 5],
      [5, 5],
    ]);
  });

  it('downloadFile rejects when file-read-meta reports a failure', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.downloadFile('C:\\x\\gone.bin', () => undefined);
    sockets[0].triggerMessage({ kind: 'file-read-meta', requestId: 'req-1', ok: false, error: 'EPERM' });

    await expect(promise).rejects.toThrow('EPERM');
  });

  it('a socket close resolves every in-flight file request instead of leaving it pending forever', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const listPromise = transport.listFiles('C:\\x');
    const rootsPromise = transport.listFileRoots();
    const opPromise = transport.createFolder('C:\\x', 'y');
    const readPromise = transport.readTextFile('C:\\x\\a.txt');

    sockets[0].triggerClose();

    await expect(listPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(rootsPromise).resolves.toEqual([]);
    await expect(opPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(readPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('WsEzTerminalTransport — upload (M5)', () => {
  // Unlike the read path (purely reactive: an incoming chunk synchronously
  // triggers an ack send, both inside the SAME synchronous message-handler
  // call), `uploadFile` is an async function — its continuation after each
  // `await` only resumes on a microtask tick, not synchronously within
  // `triggerMessage`. Every step below that expects the transport to have
  // reacted (sent the next chunk/commit, or settled the promise) needs a
  // `flush()` first. A macrotask flush (not just one `Promise.resolve()`)
  // is used so this isn't sensitive to exactly how many microtask hops a
  // given `await` chain needs.
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function sentKinds(sockets: FakeSocket[]): string[] {
    return sockets[0].sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
  }

  it('uploads in lockstep with acks (chunk N+1 only after ack N), with correct offsets and base64 payloads, and delivers finalName', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10); // forces exactly 2 chunks
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const progress: number[] = [];
    const promise = transport.uploadFile('C:\\x', 'big.bin', bytes, (sent) => progress.push(sent));

    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-upload-begin',
      requestId: 'req-1',
      dirPath: 'C:\\x',
      name: 'big.bin',
      size: bytes.length,
    });

    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'big.bin',
    });
    await flush();

    // First chunk sent immediately after the begin-reply — and ONLY the first.
    const chunk1 = sockets[0].lastSent() as { kind: string; uploadId: string; offset: number; data: string };
    expect(chunk1.kind).toBe('file-upload-chunk');
    expect(chunk1.uploadId).toBe('up-1');
    expect(chunk1.offset).toBe(0);
    expect(base64ToUint8Array(chunk1.data)).toEqual(bytes.subarray(0, FILE_CHUNK_BYTES));
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(1);

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: FILE_CHUNK_BYTES });
    await flush();
    expect(progress).toEqual([FILE_CHUNK_BYTES]);

    // Second (final) chunk only now — never before the first ack arrived.
    const chunk2 = sockets[0].lastSent() as { kind: string; uploadId: string; offset: number; data: string };
    expect(chunk2.kind).toBe('file-upload-chunk');
    expect(chunk2.offset).toBe(FILE_CHUNK_BYTES);
    expect(base64ToUint8Array(chunk2.data)).toEqual(bytes.subarray(FILE_CHUNK_BYTES));
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(2);

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: bytes.length });
    await flush();
    expect(progress).toEqual([FILE_CHUNK_BYTES, bytes.length]);

    expect(sockets[0].lastSent()).toEqual({ kind: 'file-upload-commit', uploadId: 'up-1' });

    sockets[0].triggerMessage({ kind: 'file-upload-done', uploadId: 'up-1', ok: true, finalName: 'big (1).bin' });

    await expect(promise).resolves.toEqual({ finalName: 'big (1).bin' });
  });

  it('rejects when file-upload-begin-reply reports failure, without ever sending a chunk', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({ kind: 'file-upload-begin-reply', requestId: 'req-1', ok: false, error: 'disk full' });

    await expect(promise).rejects.toThrow('disk full');
    expect(sentKinds(sockets)).not.toContain('file-upload-chunk');
  });

  it('an ok:false ack rejects and stops sending further chunks', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10); // would need 2 chunks if it kept going
    const promise = transport.uploadFile('C:\\x', 'big.bin', bytes, () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'big.bin',
    });
    await flush(); // let the continuation register the ack listener + send chunk 1

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: false, error: 'out-of-order chunk' });

    await expect(promise).rejects.toThrow('out-of-order chunk');
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(1); // never the second
  });

  it('a socket close before file-upload-begin-reply arrives rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });

  it('a socket close mid-upload (waiting on a chunk ack) rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'x.bin',
    });
    await flush(); // let it register the ack listener before closing

    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });

  it('a socket close while waiting on file-upload-done rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'x.bin',
    });
    await flush();
    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: 3 });
    await flush(); // let it register the done listener before closing

    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });
});

describe('WsEzTerminalTransport — OpenClaw management (M4)', () => {
  it('onOpenClawStatus fires on an openclaw-status push; unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const received: OpenClawStatus[] = [];
    const unsubscribe = transport.onOpenClawStatus((status) => received.push(status));

    sockets[0].triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    unsubscribe();
    sockets[0].triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } });

    expect(received).toEqual([{ state: 'running', port: 18789 }]);
  });

  it('setOpenClawStatusSubscribed(true) sends openclaw-status-subscribe once authed', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setOpenClawStatusSubscribed(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-status-subscribe' });

    transport.setOpenClawStatusSubscribed(false);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-status-unsubscribe' });
  });

  it('does not send openclaw-status-subscribe before auth — only records the desired state for later replay', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    transport.setOpenClawStatusSubscribed(true);

    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'openclaw-status-subscribe')).toHaveLength(0);
  });

  it('onOpenClawLogLines fires on an openclaw-log-lines push (a coalesced batch)', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const received: Array<readonly OpenClawLogLine[]> = [];
    transport.onOpenClawLogLines((lines) => received.push(lines));

    const lines: OpenClawLogLine[] = [
      { time: 't1', level: 'INFO', message: 'a' },
      { time: 't2', level: 'WARN', message: 'b' },
    ];
    sockets[0].triggerMessage({ kind: 'openclaw-log-lines', lines });

    expect(received).toEqual([lines]);
  });

  it('setOpenClawLogsSubscribed(true/false) sends the matching wire message once authed', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setOpenClawLogsSubscribed(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-logs-subscribe' });

    transport.setOpenClawLogsSubscribed(false);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-logs-unsubscribe' });
  });

  it('runOpenClawLifecycle sends openclaw-lifecycle and resolves with the result, correlated by requestId', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.runOpenClawLifecycle('restart');
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-lifecycle', requestId: 'req-1', action: 'restart' });

    sockets[0].triggerMessage({ kind: 'openclaw-lifecycle-result', requestId: 'req-1', result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('getOpenClawSessions sends openclaw-sessions-get and resolves with the sessions reply', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.getOpenClawSessions();
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-sessions-get', requestId: 'req-1' });

    const sessions = [{ key: 'k1', sessionId: 's1' }];
    sockets[0].triggerMessage({ kind: 'openclaw-sessions-reply', requestId: 'req-1', sessions });
    await expect(promise).resolves.toEqual(sessions);
  });

  it('getOpenClawConfig sends openclaw-config-get and resolves with the config reply', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.getOpenClawConfig();
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-config-get', requestId: 'req-1' });

    const config = { 'agents.defaults.model': 'openai/gpt-5.5', 'gateway.port': 'unset' };
    sockets[0].triggerMessage({ kind: 'openclaw-config-reply', requestId: 'req-1', config });
    await expect(promise).resolves.toEqual(config);
  });

  it('setOpenClawConfig sends openclaw-config-set and resolves with the set-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.setOpenClawConfig('agents.defaults.model', 'x');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'openclaw-config-set',
      requestId: 'req-1',
      key: 'agents.defaults.model',
      value: 'x',
    });

    sockets[0].triggerMessage({
      kind: 'openclaw-config-set-reply',
      requestId: 'req-1',
      result: { ok: true, restartRequired: true },
    });
    await expect(promise).resolves.toEqual({ ok: true, restartRequired: true });
  });

  it('getOpenClawChatTicket sends openclaw-chat-ticket and resolves with the ticket reply', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.getOpenClawChatTicket();
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-chat-ticket', requestId: 'req-1' });

    sockets[0].triggerMessage({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'req-1',
      ticket: 'tick-1',
      proxyPort: 7421,
      token: 'gw-token',
    });
    await expect(promise).resolves.toEqual({
      ok: true,
      ticket: 'tick-1',
      proxyPort: 7421,
      token: 'gw-token',
    });
  });

  it('preserves a typed ticket failure reason from the desktop bridge', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.getOpenClawChatTicket();
    sockets[0].triggerMessage({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'req-1',
      ticket: null,
      proxyPort: 0,
      token: null,
      reason: 'insecure-auth-required',
    });

    await expect(promise).resolves.toEqual({ ok: false, reason: 'insecure-auth-required' });
  });

  it('times out a ticket request, ignores its late reply, and allows a fresh retry', async () => {
    vi.useFakeTimers();
    try {
      let id = 0;
      const { createSocket, sockets } = makeCreateSocket();
      const transport = new WsEzTerminalTransport({
        url: 'ws://x',
        token: 'tok',
        createSocket,
        newId: () => `req-${++id}`,
        openClawTicketTimeoutMs: 25,
      });
      sockets[0].triggerMessage({ kind: 'auth-ok' });

      const timedOut = transport.getOpenClawChatTicket();
      await vi.advanceTimersByTimeAsync(25);
      await expect(timedOut).resolves.toEqual({ ok: false, reason: 'timeout' });

      const retry = transport.getOpenClawChatTicket();
      sockets[0].triggerMessage({
        kind: 'openclaw-chat-ticket-reply',
        requestId: 'req-1',
        ticket: 'late',
        proxyPort: 7421,
        token: 'late-token',
      });
      sockets[0].triggerMessage({
        kind: 'openclaw-chat-ticket-reply',
        requestId: 'req-2',
        ticket: 'fresh',
        proxyPort: 7421,
        token: 'fresh-token',
      });
      await expect(retry).resolves.toEqual({
        ok: true,
        ticket: 'fresh',
        proxyPort: 7421,
        token: 'fresh-token',
      });
      transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a socket close resolves every in-flight OpenClaw request instead of leaving it pending forever', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const lifecyclePromise = transport.runOpenClawLifecycle('start');
    const sessionsPromise = transport.getOpenClawSessions();
    const configPromise = transport.getOpenClawConfig();
    const configSetPromise = transport.setOpenClawConfig('agents.defaults.model', 'x');
    const ticketPromise = transport.getOpenClawChatTicket();

    sockets[0].triggerClose();

    await expect(lifecyclePromise).resolves.toEqual({ ok: false, stderr: expect.any(String) });
    await expect(sessionsPromise).resolves.toEqual([]);
    await expect(configPromise).resolves.toEqual({ 'agents.defaults.model': 'unset', 'gateway.port': 'unset' });
    await expect(configSetPromise).resolves.toEqual({ ok: false, restartRequired: false, error: expect.any(String) });
    await expect(ticketPromise).resolves.toEqual({ ok: false, reason: 'gateway-unreachable' });
  });
});

describe('WsEzTerminalTransport — connected host parsing', () => {
  it('uses URL parsing for DNS, IPv4, and bracketed IPv6 endpoints', () => {
    for (const [url, host] of [
      ['wss://desktop.example.ts.net:7420/path', 'desktop.example.ts.net'],
      ['ws://192.0.2.4:7420', '192.0.2.4'],
      ['ws://[2001:db8::1]:7420', '[2001:db8::1]'],
    ] as const) {
      const { createSocket } = makeCreateSocket();
      const transport = new WsEzTerminalTransport({ url, token: 'tok', createSocket });
      expect(transport.connectedHost).toBe(host);
      transport.disconnect();
    }
  });
});

describe('WsEzTerminalTransport — OpenClaw reconnect replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays openclaw-status-subscribe and openclaw-logs-subscribe on the reconnect auth-ok', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setOpenClawStatusSubscribed(true);
    transport.setOpenClawLogsSubscribed(true);

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    const sentKinds = sockets[1].sent.map((s) => JSON.parse(s).kind);
    expect(sentKinds).toContain('openclaw-status-subscribe');
    expect(sentKinds).toContain('openclaw-logs-subscribe');
  });

  it('does not replay openclaw-status-subscribe/openclaw-logs-subscribe on reconnect if never enabled', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });

    const sentKinds = sockets[1].sent.map((s) => JSON.parse(s).kind);
    expect(sentKinds).not.toContain('openclaw-status-subscribe');
    expect(sentKinds).not.toContain('openclaw-logs-subscribe');
  });
});

describe('WsEzTerminalTransport — OpenClaw availability (openclaw-stabilization M3)', () => {
  it('onOpenClawAvailability replays false (unknown) before any push has arrived', () => {
    const { createSocket } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const seen: boolean[] = [];
    transport.onOpenClawAvailability((visible) => seen.push(visible));

    expect(seen).toEqual([false]);
  });

  it('fires on an openclaw-availability push, and replays the cached value to a late subscriber', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: true });

    const seen: boolean[] = [];
    transport.onOpenClawAvailability((visible) => seen.push(visible));
    expect(seen).toEqual([true]); // replayed the cached value immediately, no wire round trip needed

    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: false });
    expect(seen).toEqual([true, false]);
  });

  it('unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const seen: boolean[] = [];
    const unsubscribe = transport.onOpenClawAvailability((visible) => seen.push(visible));
    seen.length = 0; // drop the initial replay

    unsubscribe();
    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: true });

    expect(seen).toEqual([]);
  });

  it('resets the cached value to false on disconnect, notifying current subscribers immediately', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].triggerMessage({ kind: 'openclaw-availability', visible: true });

    const seen: boolean[] = [];
    transport.onOpenClawAvailability((visible) => seen.push(visible));
    seen.length = 0; // drop the initial replay (true)

    sockets[0].triggerClose();
    expect(seen).toEqual([false]);

    // A subscriber joining AFTER the reset also sees false, not a stale true.
    const late: boolean[] = [];
    transport.onOpenClawAvailability((visible) => late.push(visible));
    expect(late).toEqual([false]);
  });
});

describe('WsEzTerminalTransport — OpenClaw status subscription refcount (openclaw-stabilization M3)', () => {
  it('two independent callers stay subscribed until BOTH release: an early release does not cancel the other', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    // Workspace-level subscription (persistent while OpenClaw is visible).
    transport.setOpenClawStatusSubscribed(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-status-subscribe' });

    // MobileOpenClawView mounts while it's open — a redundant acquire, no
    // second wire message (already subscribed).
    transport.setOpenClawStatusSubscribed(true);
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'openclaw-status-subscribe')).toHaveLength(1);

    // MobileOpenClawView unmounts — must NOT unsubscribe on the wire, since
    // the workspace-level subscription is still active.
    transport.setOpenClawStatusSubscribed(false);
    expect(sockets[0].sent.some((s) => JSON.parse(s).kind === 'openclaw-status-unsubscribe')).toBe(false);

    // The workspace itself releases (OpenClaw hidden) — NOW it unsubscribes.
    transport.setOpenClawStatusSubscribed(false);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-status-unsubscribe' });
  });

  it('a release without a matching acquire clamps at zero instead of going negative', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setOpenClawStatusSubscribed(false); // stray release, never subscribed
    expect(sockets[0].sent.some((s) => JSON.parse(s).kind === 'openclaw-status-unsubscribe')).toBe(false);

    transport.setOpenClawStatusSubscribed(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'openclaw-status-subscribe' }); // still a clean 0->1
  });
});
