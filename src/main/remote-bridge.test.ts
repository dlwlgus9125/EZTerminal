import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as RealWebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachConnection,
  AUTH_CLOSE_CODE,
  MAX_REMOTE_FILE_READS,
  MAX_REMOTE_PENDING_FILE_OPENS,
  isRemoteOriginAllowed,
  startRemoteBridge,
  tokensMatch,
  type OpenClawChatTicketResult,
  type RemoteBridgeOptions,
  type RemoteAgentSource,
  type RemoteFileSource,
  type RemoteMessageChannel,
  type RemoteOpenClawSource,
  type RemotePacketSource,
  type RemotePort,
  type RemoteQuickCommandSource,
  type RemoteStatsSource,
  type RemoteWs,
} from './remote-bridge';
import { InterpreterBroker, type BrokerInterpreter } from './interpreter-broker';
import { RemoteRunLeaseRegistry } from './remote-run-lease';
import { SessionWorktreeGuard } from './session-worktree-guard';
import type { FileReadStream } from './file-service';
import { FileService } from './file-service';
import type {
  InterpreterToMain,
  MainToInterpreter,
  PacketRow,
  RunAttachRejectReason,
  SystemStatsSnapshot,
} from '../shared/ipc';
import { MAX_GUARDED_DESTROY_RUN_IDS } from '../shared/ipc';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import { uint8ArrayToBase64, type RemotePacketFrame, type ServerToClientMessage } from '../shared/remote-protocol';
import type { OpenClawAgentSession, OpenClawLifecycleResult, OpenClawLogLine, OpenClawStatus } from '../shared/openclaw';
import type { AgentActivitySnapshot, AgentFollowupResult } from '../shared/agent';
import type { WorktreeRequest } from '../shared/worktree';

const TOKEN = 'the-secret-token';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForSent(
  ws: FakeWs,
  predicate: (message: ServerToClientMessage) => boolean,
): Promise<ServerToClientMessage> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const message = ws.sent.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for remote bridge message');
}

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeWs implements RemoteWs {
  readyState = 1; // OPEN, matches WS_OPEN
  readonly sent: ServerToClientMessage[] = [];
  closeCode: number | undefined;
  /** Left `undefined` unless a test sets it — matches a fake that never
   * reports backpressure (M3's `bufferedAmount ?? 0` gate). */
  bufferedAmount: number | undefined;
  private readonly messageHandlers: Array<(data: { toString(): string }, isBinary: boolean) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerToClientMessage);
  }

  close(code?: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 3; // CLOSED
    this.closeCode = code;
    for (const h of this.closeHandlers) h();
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else this.closeHandlers.push(listener as never);
  }

  /** Test helper: simulate a client sending a JSON envelope. */
  clientSend(msg: unknown): void {
    const data = { toString: () => JSON.stringify(msg) };
    for (const h of this.messageHandlers) h(data, false);
  }
}

class FakeInterpreter implements BrokerInterpreter {
  readonly posted: Array<{ message: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  private readonly listeners = new Set<(message: InterpreterToMain) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    this.posted.push({ message, transfer });
  }

  on(event: 'message', listener: (message: InterpreterToMain) => void): void;
  on(event: 'exit', listener: (code?: number) => void): void;
  on(
    event: 'message' | 'exit',
    listener: ((message: InterpreterToMain) => void) | ((code?: number) => void),
  ): void {
    if (event === 'exit') this.exitListeners.add(listener as (code?: number) => void);
    else this.listeners.add(listener as (message: InterpreterToMain) => void);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.delete(listener);
  }

  /** Count of `message` listeners only — the broker attaches exactly one (#1). */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: simulate the interpreter replying to main. */
  emit(message: InterpreterToMain): void {
    for (const l of this.listeners) l(message);
  }

  /** Test helper: simulate the interpreter process exiting. */
  emitExit(code?: number): void {
    for (const l of this.exitListeners) l(code);
  }
}

/** A fake MessagePortMain pair — `peer` links port1<->port2 so postMessage on
 * one side delivers to the other's 'message' listeners, mirroring the real
 * entangled-port behavior a MessageChannelMain provides. */
class FakePort implements RemotePort {
  closed = false;
  started = false;
  readonly posted: unknown[] = [];
  peer: FakePort | null = null;
  private readonly messageHandlers: Array<(event: { data: unknown }) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.posted.push(message);
    if (this.peer && !this.peer.closed) {
      for (const h of this.peer.messageHandlers) h({ data: message });
    }
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else this.closeHandlers.push(listener as never);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}

/** A fake `RemoteStatsSource` — tracks acquire/release counts + live listeners. */
class FakeStatsSource implements RemoteStatsSource {
  acquireCount = 0;
  releaseCount = 0;
  history: SystemStatsSnapshot[] = [];
  private readonly listeners = new Set<(snapshot: SystemStatsSnapshot) => void>();

  getHistory(): SystemStatsSnapshot[] {
    return this.history;
  }

  onSnapshot(listener: (snapshot: SystemStatsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquire(): void {
    this.acquireCount++;
  }

  release(): void {
    this.releaseCount++;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: simulate the 1Hz push. */
  emit(snapshot: SystemStatsSnapshot): void {
    for (const l of this.listeners) l(snapshot);
  }
}

/** A fake `RemotePacketSource` — tracks how many listeners are currently subscribed. */
class FakePacketSource implements RemotePacketSource {
  private readonly listeners = new Set<(frame: RemotePacketFrame) => void>();

  subscribe(listener: (frame: RemotePacketFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: simulate the mirror relaying a frame to every subscriber. */
  emit(frame: RemotePacketFrame): void {
    for (const l of this.listeners) l(frame);
  }
}

class FakeAgentSource implements RemoteAgentSource {
  snapshot: AgentActivitySnapshot = { revision: 1, items: [] };
  readonly sendFollowup = vi.fn((): AgentFollowupResult => ({ ok: true }));
  private readonly listeners = new Set<(snapshot: AgentActivitySnapshot) => void>();

  getSnapshot(): AgentActivitySnapshot {
    return this.snapshot;
  }
  onSnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(snapshot: AgentActivitySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** A fake `RemoteOpenClawSource` — tracks status/log listener counts (like
 * `FakeStatsSource`) and lets tests script the request/reply methods' return
 * values via `vi.fn()` overrides, same convention as `makeFileSource`. */
class FakeOpenClawSource implements RemoteOpenClawSource {
  private readonly statusListeners = new Set<(status: OpenClawStatus) => void>();
  private readonly logListeners = new Set<(line: OpenClawLogLine) => void>();
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();
  /** Mutable — tests flip this directly to script the M3 hidden-gating
   * scenarios, then call `emitVisibility` to also drive the broadcast path. */
  visible = true;
  readonly runLifecycle = vi.fn(async (): Promise<OpenClawLifecycleResult> => ({ ok: true }));
  readonly listAgentSessions = vi.fn(async (): Promise<readonly OpenClawAgentSession[]> => []);
  readonly getCoreConfig = vi.fn(async () => ({ 'agents.defaults.model': 'unset', 'gateway.port': 'unset' }));
  readonly setCoreConfig = vi.fn(async () => ({ ok: true, restartRequired: true }));
  readonly mintChatTicket = vi.fn(async (): Promise<OpenClawChatTicketResult> => null);

  subscribeStatus(listener: (status: OpenClawStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  subscribeLogs(listener: (line: OpenClawLogLine) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  isVisible(): boolean {
    return this.visible;
  }

  subscribeVisibility(listener: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  get statusListenerCount(): number {
    return this.statusListeners.size;
  }

  get logListenerCount(): number {
    return this.logListeners.size;
  }

  get visibilityListenerCount(): number {
    return this.visibilityListeners.size;
  }

  /** Test helper: simulate a status push. */
  emitStatus(status: OpenClawStatus): void {
    for (const l of this.statusListeners) l(status);
  }

  /** Test helper: simulate a log line arriving. */
  emitLog(line: OpenClawLogLine): void {
    for (const l of this.logListeners) l(line);
  }

  /** Test helper: simulate a desktop mode change (`visible` + the broadcast). */
  emitVisibility(visible: boolean): void {
    this.visible = visible;
    for (const l of this.visibilityListeners) l(visible);
  }
}

/** A hand-rolled fake `RemoteFileSource` (plain object of `vi.fn()`s, per the
 * milestone's testing convention) — `FileService`'s own behavior is already
 * covered by its 37 unit tests (M0); this only verifies the bridge's wiring. */
function makeFileSource(overrides: Partial<RemoteFileSource> = {}): RemoteFileSource {
  return {
    listDirectory: vi.fn(async (): Promise<FileListResult> => ({ ok: true, path: '/x', parent: null, entries: [] })),
    listRoots: vi.fn(async () => ['/']),
    openReadStream: vi.fn(async () => ({ ok: false as const, error: 'not stubbed in this fake' })),
    createFolder: vi.fn(async (): Promise<FileOpResult> => ({ ok: true })),
    renameEntry: vi.fn(async (): Promise<FileOpResult> => ({ ok: true })),
    trashEntry: vi.fn(async (): Promise<FileOpResult> => ({ ok: true })),
    beginUpload: vi.fn(async () => ({ ok: true as const, uploadId: 'up-1', finalName: 'file' })),
    writeUploadChunk: vi.fn(async () => ({ ok: true as const, receivedBytes: 0 })),
    commitUpload: vi.fn(async () => ({ ok: true as const, finalName: 'file' })),
    abortUpload: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** A fake open read stream: `next()` walks `chunks` in order, tracking its
 * own running offset, and marks `done` on the last one — `close()` is a spy
 * so tests can assert it fires exactly once. */
function makeFakeReadStream(
  meta: { fileSize: number; sendBytes: number; isText: boolean; truncated: boolean },
  chunks: readonly Uint8Array[],
): { stream: { ok: true } & FileReadStream; closeSpy: ReturnType<typeof vi.fn> } {
  let i = 0;
  let offset = 0;
  const closeSpy = vi.fn(async () => undefined);
  const stream = {
    ok: true as const,
    meta,
    next: vi.fn(async () => {
      const data = chunks[i] ?? new Uint8Array(0);
      const chunkOffset = offset;
      offset += data.length;
      i += 1;
      return { offset: chunkOffset, data, done: i >= chunks.length };
    }),
    close: closeSpy,
  };
  return { stream, closeSpy };
}

function makePacketRow(at: number): PacketRow {
  return { at, src: '10.0.0.1', dst: '10.0.0.2', proto: 'TCP', len: 60 };
}

function makeSnapshot(at: number): SystemStatsSnapshot {
  return {
    at,
    cpu: { loadPct: 12.5, cores: [10, 15] },
    mem: { usedBytes: 100, totalBytes: 200 },
    memDetail: null,
    net: null,
    disks: null,
    procs: null,
    conns: null,
  };
}

function makeFakeChannel(): RemoteMessageChannel {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

function makeOptions(overrides: Partial<RemoteBridgeOptions> = {}): {
  options: RemoteBridgeOptions;
  interpreter: FakeInterpreter;
  broker: InterpreterBroker;
  channels: Array<{ port1: FakePort; port2: FakePort }>;
} {
  const interpreter = new FakeInterpreter();
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  let idCounter = 0;
  // A REAL broker over the fake interpreter — the bridge is a thin adapter over
  // it, so the newId/createMessageChannel/interpreter seams feed the broker
  // (not the options). The broker attaches its single interpreter listener here.
  const broker = new InterpreterBroker({
    interpreter,
    createMessageChannel: () => {
      const channel = makeFakeChannel() as { port1: FakePort; port2: FakePort };
      channels.push(channel);
      return channel;
    },
    newId: () => `id-${++idCounter}`,
  });

  const options: RemoteBridgeOptions = {
    port: 0,
    getToken: () => TOKEN,
    broker,
    ...overrides,
  };
  return { options, interpreter, broker, channels };
}

async function authed(ws: FakeWs, options: RemoteBridgeOptions): Promise<void> {
  attachConnection(ws, options);
  ws.clientSend({ kind: 'auth', token: TOKEN });
  await flush();
}

function latestAttachRequestId(interpreter: FakeInterpreter): string {
  const request = [...interpreter.posted].reverse().find((entry) => entry.message.type === 'attach-run')?.message;
  if (request?.type !== 'attach-run' || !request.requestId) throw new Error('no checked attach request');
  return request.requestId;
}

function acceptLatestAttach(interpreter: FakeInterpreter): void {
  interpreter.emit({
    type: 'run-attach-result',
    requestId: latestAttachRequestId(interpreter),
    accepted: true,
  });
}

function rejectLatestAttach(interpreter: FakeInterpreter, reason: RunAttachRejectReason): void {
  interpreter.emit({
    type: 'run-attach-result',
    requestId: latestAttachRequestId(interpreter),
    accepted: false,
    reason,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RemoteBridge — auth gate', () => {
  it('rejects a wrong token: sends auth-fail and closes with AUTH_CLOSE_CODE', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);
    ws.clientSend({ kind: 'auth', token: 'wrong' });
    await flush();
    expect(ws.sent).toContainEqual({ kind: 'auth-fail', reason: 'invalid-token' });
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('accepts the correct token: sends auth-ok and does not close', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);
    expect(ws.sent).toContainEqual({ kind: 'auth-ok' });
    expect(ws.closeCode).toBeUndefined();
  });

  it('closes immediately (AUTH_CLOSE_CODE) if the FIRST message is not auth', () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);
    ws.clientSend({ kind: 'list-sessions' });
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('ignores any request sent before auth succeeds', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    attachConnection(ws, options);
    // Wrong-kind-first closes synchronously above; here simulate a slow auth
    // in flight by using an async token and sending a second message meanwhile.
    ws.clientSend({ kind: 'auth', token: TOKEN });
    ws.clientSend({ kind: 'list-sessions' });
    await flush();
    // list-sessions racing auth resolution before authed=true must not process —
    // once auth completes, only 'auth-ok' should have been sent, no session-list.
    expect(ws.sent.filter((m) => m.kind === 'session-list')).toHaveLength(0);
    expect(interpreter.posted).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['object without kind', {}],
    ['auth without token', { kind: 'auth' }],
    ['auth with a non-string token', { kind: 'auth', token: 123 }],
  ])('closes malformed pre-auth JSON safely: %s', (_label, payload) => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);

    expect(() => ws.clientSend(payload)).not.toThrow();
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('never throws when pre-auth null is repeated after the socket is already closing', () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);

    expect(() => {
      ws.clientSend(null);
      ws.clientSend(null);
      ws.clientSend(null);
    }).not.toThrow();
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('ignores repeated null and malformed major messages after authentication', async () => {
    const ws = new FakeWs();
    const fileSource = makeFileSource();
    const openclawSource = new FakeOpenClawSource();
    const { options, interpreter, channels } = makeOptions({ fileSource, openclawSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });
    expect(channels).toHaveLength(1);
    const interpreterPosts = interpreter.posted.length;

    expect(() => {
      ws.clientSend(null);
      ws.clientSend(null);
      ws.clientSend([]);
      ws.clientSend({});
      ws.clientSend({ kind: 'unknown-message' });
      ws.clientSend({ kind: 'auth', token: 123 });
      ws.clientSend({ kind: 'run-command', runId: 'bad', sessionId: null, commandText: {} });
      ws.clientSend({ kind: 'control', runId: 'run-1', control: null });
      ws.clientSend({ kind: 'control', runId: 'run-1', control: { type: 'pty-input', data: 7 } });
      ws.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'run-1', generation: '2' });
      ws.clientSend({ kind: 'terminal-file-location', requestId: 'loc', request: null });
      ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 0, data: null });
      ws.clientSend({ kind: 'openclaw-config-set', requestId: 'cfg', key: 'x', value: null });
    }).not.toThrow();

    expect(ws.readyState).toBe(1);
    expect(ws.closeCode).toBeUndefined();
    expect(channels).toHaveLength(1);
    expect(channels[0].port1.posted).toEqual([]);
    expect(interpreter.posted).toHaveLength(interpreterPosts);
    expect(fileSource.writeUploadChunk).not.toHaveBeenCalled();
    expect(openclawSource.setCoreConfig).not.toHaveBeenCalled();
  });
});

describe('RemoteBridge terminal file capabilities', () => {
  it('binds a capability to one connection, consumes it once, and rejects a swapped file', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-remote-terminal-cap-'));
    const root = path.join(base, 'workspace');
    const file = path.join(root, 'src', 'a.txt');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'inside');
    const fileService = new FileService({ trashItem: vi.fn(async () => undefined) });
    const openReadStream = vi.spyOn(fileService, 'openReadStream');
    const first = new FakeWs();
    const second = new FakeWs();
    const { options } = makeOptions({ fileSource: fileService });

    try {
      await authed(first, options);
      await authed(second, options);
      first.clientSend({
        kind: 'terminal-file-location',
        requestId: 'resolve-1',
        request: { path: './src/a.txt', cwd: root, executionKind: 'local' },
      });
      const resolvedReply = await waitForSent(
        first,
        (message) => message.kind === 'terminal-file-location-reply' && message.requestId === 'resolve-1',
      );
      if (resolvedReply.kind !== 'terminal-file-location-reply' || !resolvedReply.result.ok) {
        throw new Error('terminal path did not resolve');
      }
      const resolved = resolvedReply.result;

      second.clientSend({
        kind: 'file-read',
        requestId: 'cross-connection',
        path: resolved.path,
        mode: 'preview',
        terminalCapability: resolved.capability,
      });
      const crossReply = await waitForSent(
        second,
        (message) => message.kind === 'file-read-meta' && message.requestId === 'cross-connection',
      );
      expect(crossReply).toMatchObject({ kind: 'file-read-meta', ok: false });
      expect(openReadStream).not.toHaveBeenCalled();

      first.clientSend({
        kind: 'file-read',
        requestId: 'authorized',
        path: resolved.path,
        mode: 'preview',
        terminalCapability: resolved.capability,
      });
      const authorizedReply = await waitForSent(
        first,
        (message) => message.kind === 'file-read-meta' && message.requestId === 'authorized',
      );
      expect(authorizedReply).toMatchObject({ kind: 'file-read-meta', ok: true });
      expect(openReadStream).toHaveBeenCalledTimes(1);
      expect(openReadStream.mock.calls[0][2]).toBeDefined();

      first.clientSend({
        kind: 'file-read',
        requestId: 'replay',
        path: resolved.path,
        mode: 'preview',
        terminalCapability: resolved.capability,
      });
      const replayReply = await waitForSent(
        first,
        (message) => message.kind === 'file-read-meta' && message.requestId === 'replay',
      );
      expect(replayReply).toMatchObject({ kind: 'file-read-meta', ok: false });
      expect(openReadStream).toHaveBeenCalledTimes(1);

      first.clientSend({
        kind: 'terminal-file-location',
        requestId: 'resolve-2',
        request: { path: './src/a.txt', cwd: root, executionKind: 'local' },
      });
      const swappedReply = await waitForSent(
        first,
        (message) => message.kind === 'terminal-file-location-reply' && message.requestId === 'resolve-2',
      );
      if (swappedReply.kind !== 'terminal-file-location-reply' || !swappedReply.result.ok) {
        throw new Error('second terminal path did not resolve');
      }
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, 'replacement');
      first.clientSend({
        kind: 'file-read',
        requestId: 'swapped',
        path: swappedReply.result.path,
        mode: 'preview',
        terminalCapability: swappedReply.result.capability,
      });
      const deniedSwap = await waitForSent(
        first,
        (message) => message.kind === 'file-read-meta' && message.requestId === 'swapped',
      );
      expect(deniedSwap).toMatchObject({ kind: 'file-read-meta', ok: false });
      expect(openReadStream).toHaveBeenCalledTimes(1);
    } finally {
      first.close();
      second.close();
      fileService.dispose();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('RemoteBridge — token comparison (constant-time, security review)', () => {
  it('accepts an exact match', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
  });

  it('rejects a same-length wrong token (the timingSafeEqual path)', () => {
    expect(tokensMatch('the-secret-tokeX', TOKEN)).toBe(false);
  });

  it('rejects a wrong-length token without throwing (length-checked before timingSafeEqual)', () => {
    expect(tokensMatch('the-secret', TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}-extra`, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
  });

  it('rejects non-string candidates', () => {
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
    expect(tokensMatch(123, TOKEN)).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
  });
});

describe('RemoteBridge — origin allowlist (CSWSH/DNS-rebinding defense, security review)', () => {
  it('allows the Capacitor WebView origin and no-Origin (non-browser) clients', () => {
    expect(isRemoteOriginAllowed(undefined)).toBe(true); // Node ws / curl send no Origin
    expect(isRemoteOriginAllowed('')).toBe(true);
    expect(isRemoteOriginAllowed('http://localhost')).toBe(true); // Android WebView (androidScheme:'http')
    expect(isRemoteOriginAllowed('https://localhost')).toBe(true);
    expect(isRemoteOriginAllowed('capacitor://localhost')).toBe(true);
  });

  it('rejects a foreign browser origin (including a different localhost port)', () => {
    expect(isRemoteOriginAllowed('https://evil.example')).toBe(false);
    expect(isRemoteOriginAllowed('http://localhost:5173')).toBe(false);
    expect(isRemoteOriginAllowed('http://127.0.0.1')).toBe(false);
  });
});

describe('RemoteBridge — onAuthenticated hook (auth-deadline wiring, security review)', () => {
  it('fires exactly once on a successful auth', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    const onAuthenticated = vi.fn();
    attachConnection(ws, options, { onAuthenticated });
    ws.clientSend({ kind: 'auth', token: TOKEN });
    await flush();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('never fires on a failed auth', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    const onAuthenticated = vi.fn();
    attachConnection(ws, options, { onAuthenticated });
    ws.clientSend({ kind: 'auth', token: 'wrong' });
    await flush();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe('RemoteBridge — session directory + create/destroy round trip', () => {
  it('create-session posts to the interpreter and relays session-created back with the CLIENT requestId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1', cwd: '/tmp' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({
      type: 'create-session',
      requestId: 'id-1',
      cwd: '/tmp',
    });

    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    // The reply now flows through the broker's promise resolution (.then microtask).
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-created',
      requestId: 'client-req-1',
      session: { sessionId: 'sess-1', cwd: '/tmp' },
    });
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('a session-created reply for a DIFFERENT (unmatched) requestId is ignored by this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1' });

    // Some other connection's create-session round trip — the broker holds this
    // connection's pending under 'id-1', so 'not-mine' resolves nothing here.
    interpreter.emit({ type: 'session-created', requestId: 'not-mine', sessionId: 'sess-x', cwd: '/x' });
    await flush();

    expect(ws.sent.some((m) => m.kind === 'session-created')).toBe(false);
  });

  it('list-sessions returns the current directory contents', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);

    // The broker owns the directory now — seed a session through a create-session
    // round-trip (the broker mints 'id-1' for the first create on this broker).
    ws.clientSend({ kind: 'create-session', requestId: 'seed', cwd: '/existing' });
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'existing', cwd: '/existing' });
    await flush();

    ws.clientSend({ kind: 'list-sessions' });

    expect(ws.sent).toContainEqual({
      kind: 'session-list',
      sessions: [{ sessionId: 'existing', cwd: '/existing' }],
    });
  });

  it('destroy-session removes it from the directory and posts to the interpreter', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);

    // Seed through a create-session round-trip, then destroy it.
    ws.clientSend({ kind: 'create-session', requestId: 'seed', cwd: '/tmp' });
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await flush();

    ws.clientSend({ kind: 'destroy-session', sessionId: 'sess-1' });

    expect(broker.listSessions()).toEqual([]);
    expect(interpreter.posted).toContainEqual({
      message: { type: 'destroy-session', sessionId: 'sess-1' },
      transfer: undefined,
    });
  });

  it('guarded destroy relays an accepted authoritative result with the client requestId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'create-session', requestId: 'seed', cwd: '/tmp' });
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await flush();

    ws.clientSend({
      kind: 'destroy-session-guarded',
      requestId: 'client-close-1',
      sessionId: 'sess-1',
      expectedActiveRunIds: ['run-b', 'run-a'],
    });
    expect(interpreter.posted.at(-1)?.message).toEqual({
      type: 'destroy-session',
      requestId: 'id-2',
      sessionId: 'sess-1',
      expectedActiveRunIds: ['run-a', 'run-b'],
      deadlineAt: expect.any(Number),
    });

    interpreter.emit({ type: 'session-destroy-result', requestId: 'id-2', sessionIds: ['sess-1'], destroyed: true });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-destroy-result',
      requestId: 'client-close-1',
      result: { ok: true },
    });
    expect(broker.listSessions()).toEqual([]);
  });

  it('guarded destroy relays state-changed without removing the session', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'create-session', requestId: 'seed', cwd: '/tmp' });
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await flush();

    ws.clientSend({
      kind: 'destroy-session-guarded',
      requestId: 'client-close-2',
      sessionId: 'sess-1',
      expectedActiveRunIds: [],
    });
    interpreter.emit({ type: 'session-destroy-result', requestId: 'id-2', sessionIds: ['sess-1'], destroyed: false });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-destroy-result',
      requestId: 'client-close-2',
      result: { ok: false, reason: 'state-changed' },
    });
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('ignores malformed guarded destroy envelopes at the runtime boundary', async () => {
    const ws = new FakeWs();
    const { options, broker, interpreter } = makeOptions();
    await authed(ws, options);
    const guarded = vi.spyOn(broker, 'destroySessionGuarded');
    const base = {
      kind: 'destroy-session-guarded',
      requestId: 'close-1',
      sessionId: 'sess-1',
      expectedActiveRunIds: [],
    };
    const malformed: unknown[] = [
      { ...base, requestId: 1 },
      { ...base, requestId: '' },
      { ...base, requestId: 'x'.repeat(257) },
      { ...base, sessionId: '' },
      { ...base, sessionId: 'x'.repeat(257) },
      { ...base, expectedActiveRunIds: 'run-1' },
      { ...base, expectedActiveRunIds: [1] },
      { ...base, expectedActiveRunIds: [''] },
      { ...base, expectedActiveRunIds: ['x'.repeat(257)] },
      { ...base, expectedActiveRunIds: ['run-1', 'run-1'] },
      {
        ...base,
        expectedActiveRunIds: Array.from(
          { length: MAX_GUARDED_DESTROY_RUN_IDS + 1 },
          (_, index) => `run-${index}`,
        ),
      },
    ];

    for (const message of malformed) ws.clientSend(message);
    await flush();

    expect(guarded).not.toHaveBeenCalled();
    expect(interpreter.posted).toEqual([]);
    expect(ws.sent.some((message) => message.kind === 'session-destroy-result')).toBe(false);
  });
});

describe('RemoteBridge — list-runs (M1 mirror-active-runs)', () => {
  it('list-runs posts to the interpreter and relays the run-list reply back to this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'list-runs' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({ type: 'list-runs', requestId: 'id-1' });

    const runs = [{ sessionId: 'sess-1', runId: 'run-1', commandText: 'ls' }];
    interpreter.emit({ type: 'run-list', requestId: 'id-1', runs });
    // The reply now flows through the broker's listRuns promise (.then microtask).
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'run-list', runs });
  });

  it('a run-list reply for a DIFFERENT (unmatched) requestId is NOT relayed to this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'list-runs' });

    // Some other connection's list-runs round trip — the broker holds this
    // connection's pending under 'id-1', so 'not-mine' resolves nothing here.
    interpreter.emit({ type: 'run-list', requestId: 'not-mine', runs: [] });
    await flush();

    expect(ws.sent.some((m) => m.kind === 'run-list')).toBe(false);
  });

  it('a list-runs sent before auth succeeds is ignored — no interpreter post, no reply', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    attachConnection(ws, options);
    // Simulate the message racing auth resolution, same as the list-sessions
    // race test above — only 'auth-ok' should ever be sent.
    ws.clientSend({ kind: 'auth', token: TOKEN });
    ws.clientSend({ kind: 'list-runs' });
    await flush();

    expect(interpreter.posted).toHaveLength(0);
    expect(ws.sent.some((m) => m.kind === 'run-list')).toBe(false);
  });
});

describe('RemoteBridge — run-command frame/control multiplexing', () => {
  it('relays a worktree-barrier run rejection as a terminal error frame', async () => {
    const interpreter = new FakeInterpreter();
    const runGuard = new SessionWorktreeGuard();
    const broker = new InterpreterBroker({
      interpreter,
      runGuard,
      createMessageChannel: makeFakeChannel,
    });
    const ws = new FakeWs();
    await authed(ws, { port: 0, getToken: () => TOKEN, broker });

    await runGuard.withRemovalBarrier(() => {
      ws.clientSend({ kind: 'run-command', runId: 'blocked', sessionId: 'sess-1', commandText: 'ls' });
    });

    expect(ws.sent).toContainEqual({
      kind: 'frame',
      runId: 'blocked',
      frame: { type: 'error', message: 'Run could not start while a worktree mutation is in progress' },
    });
    expect(interpreter.posted).toEqual([]);
  });

  it('relays an interpreter frame to the WS tagged with the correct runId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({
      type: 'run',
      commandText: 'ls',
      sessionId: 'sess-1',
      runId: 'run-1',
      requestOrigin: 'mobile',
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].port1.started).toBe(true);

    channels[0].port2.postMessage({ type: 'start', commandText: 'ls', cwd: '/tmp' });

    expect(ws.sent).toContainEqual({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'start', commandText: 'ls', cwd: '/tmp' },
    });
  });

  it('encodes pty-data as base64 and preserves replay side-effect suppression', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });

    channels[0].port2.postMessage({
      type: 'pty-data',
      data: new Uint8Array([104, 105]),
      suppressSideEffects: true,
    }); // "hi"

    const frameMsg = ws.sent.find((m) => m.kind === 'frame') as {
      kind: 'frame';
      runId: string;
      frame: { type: string; data: string; suppressSideEffects?: true };
    };
    expect(frameMsg.frame.type).toBe('pty-data');
    expect(typeof frameMsg.frame.data).toBe('string');
    expect(frameMsg.frame.data).not.toBeInstanceOf(Uint8Array);
    expect(frameMsg.frame.suppressSideEffects).toBe(true);
  });

  it('relays a WS control message to the run\'s port', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });

    ws.clientSend({ kind: 'control', runId: 'run-1', control: { type: 'cancel' } });

    expect(channels[0].port1.posted).toContainEqual({ type: 'cancel' });
  });

  it('a control for an unknown runId is a silent no-op', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);
    expect(() => ws.clientSend({ kind: 'control', runId: 'no-such-run', control: { type: 'cancel' } })).not.toThrow();
  });

  it('a close control closes the port and stops further relays for that runId', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });

    ws.clientSend({ kind: 'control', runId: 'run-1', control: { type: 'close' } });

    expect(channels[0].port1.posted).toContainEqual({ type: 'close' });
    expect(channels[0].port1.closed).toBe(true);

    // Interpreter side is closed too (peer), so a post-close frame from the
    // interpreter is dropped rather than relayed.
    const sentBefore = ws.sent.length;
    channels[0].port2.postMessage({ type: 'cancelled' });
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('two concurrent runs never cross runIds', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'run-command', runId: 'run-a', sessionId: 'sess-1', commandText: 'ls' });
    ws.clientSend({ kind: 'run-command', runId: 'run-b', sessionId: 'sess-1', commandText: 'pwd' });
    expect(channels).toHaveLength(2);

    channels[0].port2.postMessage({ type: 'start', commandText: 'ls', cwd: '/a' });
    channels[1].port2.postMessage({ type: 'start', commandText: 'pwd', cwd: '/b' });

    const frames = ws.sent.filter((m) => m.kind === 'frame') as Array<{
      kind: 'frame';
      runId: string;
      frame: { commandText: string };
    }>;
    expect(frames.find((f) => f.runId === 'run-a')?.frame.commandText).toBe('ls');
    expect(frames.find((f) => f.runId === 'run-b')?.frame.commandText).toBe('pwd');

    // A control for run-a must only reach run-a's port.
    ws.clientSend({ kind: 'control', runId: 'run-a', control: { type: 'cancel' } });
    expect(channels[0].port1.posted).toContainEqual({ type: 'cancel' });
    expect(channels[1].port1.posted).not.toContainEqual({ type: 'cancel' });
  });
});

describe('RemoteBridge — connection teardown', () => {
  it('parks transient runs, resumes with ready-before-replay, and explicitly releases them', async () => {
    const ws = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 60_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    // The broker attaches exactly ONE interpreter message listener (#1) at
    // construction — attachConnection adds none (AC(d): constant across N conns).
    expect(interpreter.listenerCount).toBe(1);
    await authed(ws, options);
    expect(interpreter.listenerCount).toBe(1);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    ws.clientSend({ kind: 'run-command', runId: 'run-2', sessionId: 'sess-1', commandText: 'pwd' });
    expect(channels.every((c) => !c.port1.closed)).toBe(true);

    // A SECOND connection on the SAME broker must not add a second listener.
    const ws2 = new FakeWs();
    await authed(ws2, options);
    expect(interpreter.listenerCount).toBe(1);

    ws.close();

    expect(channels.every((c) => !c.port1.closed)).toBe(true);
    expect(leases.size).toBe(2);

    ws2.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'run-1', generation: 2 });
    expect(channels).toHaveLength(3);
    expect(leases.size).toBe(2);
    expect(channels[0].port1.closed).toBe(false);
    expect(ws2.sent.some((message) => message.kind === 'resume-run-ready')).toBe(false);

    acceptLatestAttach(interpreter);
    await flush();

    expect(ws2.sent).toContainEqual({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
    });
    expect(channels[2].port1.started).toBe(true);
    expect(channels[0].port1.closed).toBe(true);
    channels[2].port2.postMessage({ type: 'schema', shape: 'pty', columns: [] });
    channels[2].port2.postMessage({
      type: 'pty-restore-warning',
      reason: 'semantic-gap',
      fallback: 'raw-ring',
    });
    channels[2].port2.postMessage({ type: 'pty-data', data: new Uint8Array([1]) });
    const readyIndex = ws2.sent.findIndex((message) => message.kind === 'resume-run-ready');
    const replayIndex = ws2.sent.findIndex(
      (message) => message.kind === 'frame' && message.frame.type === 'schema',
    );
    const warningIndex = ws2.sent.findIndex(
      (message) => message.kind === 'frame' && message.frame.type === 'pty-restore-warning',
    );
    const dataIndex = ws2.sent.findIndex(
      (message) => message.kind === 'frame' && message.frame.type === 'pty-data',
    );
    expect(replayIndex).toBeGreaterThan(readyIndex);
    expect(warningIndex).toBeGreaterThan(replayIndex);
    expect(dataIndex).toBeGreaterThan(warningIndex);

    ws2.clientSend({ kind: 'release-runs' });
    expect(channels[2].port1.closed).toBe(true);
    leases.dispose();
    expect(channels[1].port1.closed).toBe(true);
    // Still exactly one — the broker's listener outlives any single connection.
    expect(interpreter.listenerCount).toBe(1);
  });

  it('keeps a parked lease authoritative when checked attach is busy', async () => {
    const ws = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 60_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });
    ws.close();
    expect(leases.size).toBe(1);

    const resumed = new FakeWs();
    await authed(resumed, options);
    resumed.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'run-1', generation: 2 });
    expect(channels[0].port1.closed).toBe(false);

    rejectLatestAttach(interpreter, 'mirror-capacity');
    await flush();

    expect(resumed.sent).toContainEqual({
      kind: 'resume-run-busy',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
      reason: 'capacity',
      retryable: true,
    });
    expect(leases.size).toBe(1);
    expect(channels[0].port1.closed).toBe(false);
    expect(channels[1].port1.closed).toBe(true);
    leases.dispose();
  });

  it('claims PTY control when an authoritative resume succeeds without a lease', async () => {
    const first = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(first, options);
    first.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });

    const resumed = new FakeWs();
    await authed(resumed, options);
    resumed.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'run-1', generation: 2 });
    acceptLatestAttach(interpreter);
    await flush();

    expect(resumed.sent).toContainEqual({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
    });
    expect(channels[1].port1.posted).toContainEqual({ type: 'pty-claim-control' });
    expect(channels[0].port1.closed).toBe(false);
  });

  it('reports missing only after a definitive lease-less attach rejection', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'gone', generation: 1 });
    expect(ws.sent.some((message) => message.kind === 'resume-run-missing')).toBe(false);
    rejectLatestAttach(interpreter, 'run-not-found');
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'resume-run-missing',
      sessionId: 'sess-1',
      runId: 'gone',
      generation: 1,
    });
    expect(channels[0].port1.closed).toBe(true);
  });

  it('release-runs closes a lease even while its replacement ACK is pending', async () => {
    const first = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 60_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    await authed(first, options);
    first.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });
    first.close();

    const resumed = new FakeWs();
    await authed(resumed, options);
    resumed.clientSend({ kind: 'resume-run', sessionId: 'sess-1', runId: 'run-1', generation: 2 });
    resumed.clientSend({ kind: 'release-runs' });
    expect(leases.size).toBe(0);
    expect(channels[0].port1.closed).toBe(true);

    acceptLatestAttach(interpreter);
    await flush();

    expect(channels[1].port1.closed).toBe(true);
    expect(resumed.sent.some((message) => message.kind === 'resume-run-ready')).toBe(false);
  });
});

describe('RemoteBridge — stats mirroring (M1)', () => {
  it('stats-visible:true acquires once and relays subsequent snapshots to THIS ws only', async () => {
    const statsSource = new FakeStatsSource();
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    const { options } = makeOptions({ statsSource });
    await authed(wsA, options);
    await authed(wsB, options);

    wsA.clientSend({ kind: 'stats-visible', visible: true });

    expect(statsSource.acquireCount).toBe(1);
    expect(statsSource.listenerCount).toBe(1);

    const snapshot = makeSnapshot(1000);
    statsSource.emit(snapshot);

    expect(wsA.sent).toContainEqual({ kind: 'stats-update', snapshot });
    expect(wsB.sent.some((m) => m.kind === 'stats-update')).toBe(false);
  });

  it('a second stats-visible:true on the same connection is idempotent (no extra acquire/listener)', async () => {
    const statsSource = new FakeStatsSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ statsSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'stats-visible', visible: true });
    ws.clientSend({ kind: 'stats-visible', visible: true });

    expect(statsSource.acquireCount).toBe(1);
    expect(statsSource.listenerCount).toBe(1);
  });

  it('stats-visible:false releases + unsubscribes exactly once, including a redundant second call', async () => {
    const statsSource = new FakeStatsSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ statsSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'stats-visible', visible: true });
    ws.clientSend({ kind: 'stats-visible', visible: false });
    ws.clientSend({ kind: 'stats-visible', visible: false }); // redundant — must not double-release

    expect(statsSource.releaseCount).toBe(1);
    expect(statsSource.listenerCount).toBe(0);

    // Unsubscribed — a snapshot emitted after turning off must not be relayed.
    statsSource.emit(makeSnapshot(2000));
    expect(ws.sent.some((m) => m.kind === 'stats-update')).toBe(false);
  });

  it('closing the ws releases + unsubscribes exactly once for a still-visible subscription', async () => {
    const statsSource = new FakeStatsSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ statsSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'stats-visible', visible: true });
    ws.close();

    expect(statsSource.releaseCount).toBe(1);
    expect(statsSource.listenerCount).toBe(0);
  });

  it('stats-history replies with the current history payload (FIFO, no correlation id)', async () => {
    const statsSource = new FakeStatsSource();
    statsSource.history = [makeSnapshot(1), makeSnapshot(2)];
    const ws = new FakeWs();
    const { options } = makeOptions({ statsSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'stats-history' });

    expect(ws.sent).toContainEqual({ kind: 'stats-history', snapshots: statsSource.history });
  });

  it('a pre-auth stats-visible message is rejected like any other pre-auth message', () => {
    const statsSource = new FakeStatsSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ statsSource });
    attachConnection(ws, options);

    ws.clientSend({ kind: 'stats-visible', visible: true });

    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
    expect(statsSource.acquireCount).toBe(0);
  });
});

describe('RemoteBridge — packet mirroring (M3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('packets-subscribe relays a status frame immediately (not coalesced)', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'packets-subscribe' });
    expect(packetSource.listenerCount).toBe(1);

    packetSource.emit({ type: 'status', status: 'capturing' });

    expect(ws.sent).toContainEqual({
      kind: 'packet-frame',
      frame: { type: 'status', status: 'capturing' },
    });
  });

  it('a second packets-subscribe on the same connection is idempotent (no extra listener)', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'packets-subscribe' });
    ws.clientSend({ kind: 'packets-subscribe' });

    expect(packetSource.listenerCount).toBe(1);
  });

  it('two batches spaced 100ms apart coalesce into ONE flush within the 500ms window', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'packets-subscribe' });

    packetSource.emit({ type: 'packets', rows: [makePacketRow(1)] });
    vi.advanceTimersByTime(100);
    packetSource.emit({ type: 'packets', rows: [makePacketRow(2)] });
    vi.advanceTimersByTime(100);

    expect(ws.sent.filter((m) => m.kind === 'packet-frame')).toHaveLength(0); // 500ms window hasn't elapsed

    vi.advanceTimersByTime(300); // total 500ms since subscribe — the flush timer fires
    const flushes = ws.sent.filter((m) => m.kind === 'packet-frame');
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual({
      kind: 'packet-frame',
      frame: { type: 'packets', rows: [makePacketRow(1), makePacketRow(2)] },
    });
  });

  it('caps the pending buffer at 500 rows, dropping the oldest', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'packets-subscribe' });

    const rows = Array.from({ length: 600 }, (_, i) => makePacketRow(i));
    packetSource.emit({ type: 'packets', rows });
    vi.advanceTimersByTime(500);

    const flush = ws.sent.find((m) => m.kind === 'packet-frame') as {
      kind: 'packet-frame';
      frame: { type: string; rows: PacketRow[] };
    };
    expect(flush.frame.rows).toHaveLength(500);
    expect(flush.frame.rows[0]).toEqual(makePacketRow(100)); // oldest 100 dropped
    expect(flush.frame.rows.at(-1)).toEqual(makePacketRow(599));
  });

  it('skips and clears a flush while ws.bufferedAmount is over the backpressure threshold', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'packets-subscribe' });
    ws.bufferedAmount = 262_144 + 1;

    packetSource.emit({ type: 'packets', rows: [makePacketRow(1)] });
    vi.advanceTimersByTime(500);
    expect(ws.sent.some((m) => m.kind === 'packet-frame')).toBe(false);

    // Cleared, not just skipped — once backpressure clears, the dropped batch
    // does NOT reappear in a later flush.
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(500);
    expect(ws.sent.some((m) => m.kind === 'packet-frame')).toBe(false);
  });

  it('packets-unsubscribe unsubscribes + clears the timer exactly once, including a redundant second call', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'packets-subscribe' });
    expect(packetSource.listenerCount).toBe(1);

    ws.clientSend({ kind: 'packets-unsubscribe' });
    ws.clientSend({ kind: 'packets-unsubscribe' }); // redundant — must not throw/double-release

    expect(packetSource.listenerCount).toBe(0);
  });

  it('closing the ws while subscribed unsubscribes exactly once', async () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'packets-subscribe' });

    ws.close();

    expect(packetSource.listenerCount).toBe(0);
  });

  it('a pre-auth packets-subscribe message is rejected like any other pre-auth message', () => {
    const packetSource = new FakePacketSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ packetSource });
    attachConnection(ws, options);

    ws.clientSend({ kind: 'packets-subscribe' });

    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
    expect(packetSource.listenerCount).toBe(0);
  });
});

describe('RemoteBridge — file explorer (M3)', () => {
  it('a pre-auth file-list message is rejected like any other pre-auth message', () => {
    const fileSource = makeFileSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    attachConnection(ws, options);

    ws.clientSend({ kind: 'file-list', requestId: 'r1', path: '' });

    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
    expect(fileSource.listDirectory).not.toHaveBeenCalled();
  });

  it('file-list round-trips: passthrough result, requestId echoed', async () => {
    const result: FileListResult = { ok: true, path: 'C:\\x', parent: null, entries: [] };
    const fileSource = makeFileSource({ listDirectory: vi.fn(async () => result) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-list', requestId: 'r1', path: 'C:\\x' });
    await flush();

    expect(fileSource.listDirectory).toHaveBeenCalledWith('C:\\x');
    expect(ws.sent).toContainEqual({ kind: 'file-list-reply', requestId: 'r1', result });
  });

  it('file-roots round-trips the drive list', async () => {
    const fileSource = makeFileSource({ listRoots: vi.fn(async () => ['C:\\', 'D:\\']) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-roots', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'file-roots-reply', requestId: 'r1', roots: ['C:\\', 'D:\\'] });
  });

  it('file-mkdir round-trips via file-op-reply', async () => {
    const result: FileOpResult = { ok: false, error: 'boom' };
    const fileSource = makeFileSource({ createFolder: vi.fn(async () => result) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-mkdir', requestId: 'r1', dirPath: 'C:\\x', name: 'new' });
    await flush();

    expect(fileSource.createFolder).toHaveBeenCalledWith('C:\\x', 'new');
    expect(ws.sent).toContainEqual({ kind: 'file-op-reply', requestId: 'r1', result });
  });

  it('file-rename round-trips via file-op-reply', async () => {
    const result: FileOpResult = { ok: true };
    const fileSource = makeFileSource({ renameEntry: vi.fn(async () => result) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-rename', requestId: 'r1', path: 'C:\\x\\a.txt', newName: 'b.txt' });
    await flush();

    expect(fileSource.renameEntry).toHaveBeenCalledWith('C:\\x\\a.txt', 'b.txt');
    expect(ws.sent).toContainEqual({ kind: 'file-op-reply', requestId: 'r1', result });
  });

  it('file-trash round-trips via file-op-reply', async () => {
    const result: FileOpResult = { ok: true };
    const fileSource = makeFileSource({ trashEntry: vi.fn(async () => result) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-trash', requestId: 'r1', path: 'C:\\x\\a.txt' });
    await flush();

    expect(fileSource.trashEntry).toHaveBeenCalledWith('C:\\x\\a.txt');
    expect(ws.sent).toContainEqual({ kind: 'file-op-reply', requestId: 'r1', result });
  });

  it('file-read (text mode) streams meta then ack-gated chunks that reassemble exactly, done on the last', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const { stream, closeSpy } = makeFakeReadStream(
      { fileSize: 5, sendBytes: 5, isText: true, truncated: false },
      [chunk1, chunk2],
    );
    const fileSource = makeFileSource({ openReadStream: vi.fn(async () => stream) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'r1', path: 'C:\\a.txt', mode: 'text' });
    await flush();

    expect(fileSource.openReadStream).toHaveBeenCalledWith(
      'C:\\a.txt',
      'text',
      undefined,
      expect.any(AbortSignal),
    );
    expect(ws.sent).toContainEqual({
      kind: 'file-read-meta',
      requestId: 'r1',
      ok: true,
      fileSize: 5,
      sendBytes: 5,
      isText: true,
      truncated: false,
    });
    expect(ws.sent).toContainEqual({
      kind: 'file-read-chunk',
      requestId: 'r1',
      offset: 0,
      data: uint8ArrayToBase64(chunk1),
      done: false,
    });
    expect(closeSpy).not.toHaveBeenCalled();

    ws.clientSend({ kind: 'file-read-ack', requestId: 'r1', offset: 3 });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'file-read-chunk',
      requestId: 'r1',
      offset: 3,
      data: uint8ArrayToBase64(chunk2),
      done: true,
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('file-read on a binary file sends meta only — no chunk is ever requested or sent', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const stream = {
      ok: true as const,
      meta: { fileSize: 10, sendBytes: 0, isText: false, truncated: false },
      next: vi.fn(),
      close: closeSpy,
    };
    const fileSource = makeFileSource({ openReadStream: vi.fn(async () => stream) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'r1', path: 'C:\\a.bin', mode: 'text' });
    await flush();

    expect(ws.sent.some((m) => m.kind === 'file-read-chunk')).toBe(false);
    expect(stream.next).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('file-read-cancel closes the open stream; a stale ack afterward does not resurrect it', async () => {
    const { stream, closeSpy } = makeFakeReadStream(
      { fileSize: 10, sendBytes: 10, isText: true, truncated: false },
      [new Uint8Array([1]), new Uint8Array([2])],
    );
    const fileSource = makeFileSource({ openReadStream: vi.fn(async () => stream) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'r1', path: 'C:\\a.txt', mode: 'text' });
    await flush();

    ws.clientSend({ kind: 'file-read-cancel', requestId: 'r1' });
    await flush();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    ws.clientSend({ kind: 'file-read-ack', requestId: 'r1', offset: 1 });
    await flush();
    expect(stream.next).toHaveBeenCalledTimes(1); // only the initial send — none after cancel
  });

  it('closing the ws also closes any open read stream for this connection', async () => {
    const { stream, closeSpy } = makeFakeReadStream(
      { fileSize: 10, sendBytes: 10, isText: true, truncated: false },
      [new Uint8Array([1])],
    );
    const fileSource = makeFileSource({ openReadStream: vi.fn(async () => stream) });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'r1', path: 'C:\\a.txt', mode: 'text' });
    await flush();

    ws.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('upload happy path: begin -> 2 chunks (decoded correctly, offsets threaded) -> commit', async () => {
    const writeUploadChunk = vi.fn(async (_uploadId: string, offset: number, data: Uint8Array) => ({
      ok: true as const,
      receivedBytes: offset + data.length,
    }));
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({ ok: true as const, uploadId: 'up-1', finalName: 'photo.png' })),
      writeUploadChunk,
      commitUpload: vi.fn(async () => ({ ok: true as const, finalName: 'photo.png' })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-upload-begin', requestId: 'r1', dirPath: 'C:\\x', name: 'photo.png', size: 5 });
    await flush();
    expect(ws.sent).toContainEqual({
      kind: 'file-upload-begin-reply',
      requestId: 'r1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'photo.png',
    });

    const chunk1 = new Uint8Array([10, 20, 30]);
    const chunk2 = new Uint8Array([40, 50]);
    ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 0, data: uint8ArrayToBase64(chunk1) });
    await flush();
    expect(writeUploadChunk).toHaveBeenNthCalledWith(1, 'up-1', 0, chunk1);
    expect(ws.sent).toContainEqual({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: 3 });

    ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 3, data: uint8ArrayToBase64(chunk2) });
    await flush();
    expect(writeUploadChunk).toHaveBeenNthCalledWith(2, 'up-1', 3, chunk2);
    expect(ws.sent).toContainEqual({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: 5 });

    ws.clientSend({ kind: 'file-upload-commit', uploadId: 'up-1' });
    await flush();
    expect(fileSource.commitUpload).toHaveBeenCalledWith('up-1');
    expect(ws.sent).toContainEqual({ kind: 'file-upload-done', uploadId: 'up-1', ok: true, finalName: 'photo.png' });
  });

  it('an oversized chunk (>2x FILE_CHUNK_BYTES decoded) is hard-rejected: ack ok:false + abortUpload, writeUploadChunk never called', async () => {
    const fileSource = makeFileSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    const oversized = new Uint8Array(FILE_CHUNK_BYTES * 2 + 1);
    ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 0, data: uint8ArrayToBase64(oversized) });
    await flush();

    expect(fileSource.writeUploadChunk).not.toHaveBeenCalled();
    expect(fileSource.abortUpload).toHaveBeenCalledWith('up-1');
    expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'file-upload-ack', uploadId: 'up-1', ok: false }));
  });

  it('a chunk for an unknown uploadId gets an ok:false ack (relayed from the fileSource)', async () => {
    const fileSource = makeFileSource({
      writeUploadChunk: vi.fn(async () => ({ ok: false as const, error: 'unknown uploadId' })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'no-such-upload',
      offset: 0,
      data: uint8ArrayToBase64(new Uint8Array([1])),
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'file-upload-ack',
      uploadId: 'no-such-upload',
      ok: false,
      error: 'unknown uploadId',
    });
  });

  it('file-upload-abort passes through to abortUpload and drops the id from tracking (no double-abort on later close)', async () => {
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({ ok: true as const, uploadId: 'up-1', finalName: 'x.bin' })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-upload-begin', requestId: 'r1', dirPath: 'C:\\x', name: 'x.bin', size: 5 });
    await flush();

    ws.clientSend({ kind: 'file-upload-abort', uploadId: 'up-1' });
    await flush();
    expect(fileSource.abortUpload).toHaveBeenCalledWith('up-1');

    (fileSource.abortUpload as ReturnType<typeof vi.fn>).mockClear();
    ws.close();
    expect(fileSource.abortUpload).not.toHaveBeenCalled();
  });

  it('closing the ws mid-upload aborts every tracked upload for this connection', async () => {
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({ ok: true as const, uploadId: 'up-1', finalName: 'x.bin' })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-upload-begin', requestId: 'r1', dirPath: 'C:\\x', name: 'x.bin', size: 5 });
    await flush();

    ws.close();

    expect(fileSource.abortUpload).toHaveBeenCalledWith('up-1');
  });

  it('aborts an upload whose begin resolves only after the ws closed', async () => {
    type BeginResult = Awaited<ReturnType<RemoteFileSource['beginUpload']>>;
    let resolveBegin!: (result: BeginResult) => void;
    const fileSource = makeFileSource({
      beginUpload: vi.fn(() => new Promise<BeginResult>((resolve) => { resolveBegin = resolve; })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-upload-begin', requestId: 'late', dirPath: 'C:\\x', name: 'x.bin', size: 5 });
    ws.close();
    resolveBegin({ ok: true, uploadId: 'late-upload', finalName: 'x.bin' });
    await flush();

    expect(fileSource.abortUpload).toHaveBeenCalledTimes(1);
    expect(fileSource.abortUpload).toHaveBeenCalledWith('late-upload');
    expect(ws.sent).not.toContainEqual(expect.objectContaining({
      kind: 'file-upload-begin-reply', requestId: 'late', ok: true,
    }));
  });

  it('without a fileSource option, every file-* message is a silent no-op (no reply, no crash)', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions(); // no fileSource
    await authed(ws, options);

    expect(() => {
      ws.clientSend({ kind: 'file-list', requestId: 'r1', path: '' });
      ws.clientSend({ kind: 'file-roots', requestId: 'r2' });
      ws.clientSend({ kind: 'file-read', requestId: 'r3', path: 'C:\\a.txt', mode: 'text' });
      ws.clientSend({ kind: 'file-read-ack', requestId: 'r3', offset: 0 });
      ws.clientSend({ kind: 'file-read-cancel', requestId: 'r3' });
      ws.clientSend({ kind: 'file-mkdir', requestId: 'r4', dirPath: 'C:\\x', name: 'y' });
      ws.clientSend({ kind: 'file-rename', requestId: 'r5', path: 'C:\\x', newName: 'y' });
      ws.clientSend({ kind: 'file-trash', requestId: 'r6', path: 'C:\\x' });
      ws.clientSend({ kind: 'file-upload-begin', requestId: 'r7', dirPath: 'C:\\x', name: 'y', size: 1 });
      ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 0, data: '' });
      ws.clientSend({ kind: 'file-upload-commit', uploadId: 'up-1' });
      ws.clientSend({ kind: 'file-upload-abort', uploadId: 'up-1' });
    }).not.toThrow();
    await flush();

    expect(ws.sent.filter((m) => m.kind.startsWith('file-'))).toHaveLength(0);
  });
});

describe('RemoteBridge — OpenClaw management (M4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pre-auth openclaw-status-subscribe message is rejected like any other pre-auth message', () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    attachConnection(ws, options);

    ws.clientSend({ kind: 'openclaw-status-subscribe' });

    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
    expect(openclawSource.statusListenerCount).toBe(0);
  });

  it('openclaw-status-subscribe subscribes and relays pushes; a second subscribe is idempotent', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-status-subscribe' });
    ws.clientSend({ kind: 'openclaw-status-subscribe' }); // idempotent — no extra listener
    expect(openclawSource.statusListenerCount).toBe(1);

    openclawSource.emitStatus({ state: 'running', port: 18789 });
    expect(ws.sent).toContainEqual({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
  });

  it('openclaw-status-unsubscribe unsubscribes exactly once, including a redundant second call', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'openclaw-status-subscribe' });

    ws.clientSend({ kind: 'openclaw-status-unsubscribe' });
    ws.clientSend({ kind: 'openclaw-status-unsubscribe' }); // redundant — must not throw

    expect(openclawSource.statusListenerCount).toBe(0);
  });

  it('closing the ws while status-subscribed unsubscribes exactly once', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'openclaw-status-subscribe' });

    ws.close();

    expect(openclawSource.statusListenerCount).toBe(0);
  });

  it('openclaw-lifecycle round-trips via openclaw-lifecycle-result, echoing the client requestId', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.runLifecycle.mockResolvedValueOnce({ ok: false, stderr: 'boom' });
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'restart' });
    await flush();

    expect(openclawSource.runLifecycle).toHaveBeenCalledWith('restart');
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-lifecycle-result',
      requestId: 'r1',
      result: { ok: false, stderr: 'boom' },
    });
  });

  it('a runLifecycle rejection is surfaced as an ok:false lifecycle result, not a hang (M5/S10)', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.runLifecycle.mockRejectedValueOnce(new Error('boom'));
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'restart' });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'openclaw-lifecycle-result',
      requestId: 'r1',
      result: { ok: false, stderr: 'boom' },
    });
  });

  it('openclaw-logs-subscribe coalesces log lines into ONE openclaw-log-lines flush within the 500ms window', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });
    expect(openclawSource.logListenerCount).toBe(1);

    const lineA: OpenClawLogLine = { time: 't1', level: 'INFO', message: 'a' };
    const lineB: OpenClawLogLine = { time: 't2', level: 'INFO', message: 'b' };
    openclawSource.emitLog(lineA);
    vi.advanceTimersByTime(100);
    openclawSource.emitLog(lineB);
    vi.advanceTimersByTime(100);
    expect(ws.sent.filter((m) => m.kind === 'openclaw-log-lines')).toHaveLength(0); // window hasn't elapsed

    vi.advanceTimersByTime(300); // total 500ms since subscribe
    const flushes = ws.sent.filter((m) => m.kind === 'openclaw-log-lines');
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual({ kind: 'openclaw-log-lines', lines: [lineA, lineB] });
  });

  it('caps the pending log buffer at 500 lines, dropping the oldest', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });
    for (let i = 0; i < 600; i++) {
      openclawSource.emitLog({ time: String(i), level: 'INFO', message: `m${i}` });
    }
    vi.advanceTimersByTime(500);

    const flush = ws.sent.find((m) => m.kind === 'openclaw-log-lines') as {
      kind: 'openclaw-log-lines';
      lines: OpenClawLogLine[];
    };
    expect(flush.lines).toHaveLength(500);
    expect(flush.lines[0].message).toBe('m100'); // oldest 100 dropped
    expect(flush.lines.at(-1)?.message).toBe('m599');
  });

  it('skips and clears a log flush while ws.bufferedAmount is over the backpressure threshold', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    vi.useFakeTimers();
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });
    ws.bufferedAmount = 262_144 + 1;

    openclawSource.emitLog({ time: 't', level: 'INFO', message: 'x' });
    vi.advanceTimersByTime(500);
    expect(ws.sent.some((m) => m.kind === 'openclaw-log-lines')).toBe(false);

    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(500);
    expect(ws.sent.some((m) => m.kind === 'openclaw-log-lines')).toBe(false); // cleared, not replayed
  });

  it('openclaw-logs-unsubscribe unsubscribes + clears the flush timer exactly once', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });

    ws.clientSend({ kind: 'openclaw-logs-unsubscribe' });
    ws.clientSend({ kind: 'openclaw-logs-unsubscribe' }); // redundant — must not throw

    expect(openclawSource.logListenerCount).toBe(0);
  });

  it('closing the ws while logs-subscribed unsubscribes exactly once', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });

    ws.close();

    expect(openclawSource.logListenerCount).toBe(0);
  });

  it('openclaw-sessions-get round-trips via openclaw-sessions-reply, echoing the requestId', async () => {
    const openclawSource = new FakeOpenClawSource();
    const sessions = [{ key: 'k1', sessionId: 's1' }];
    openclawSource.listAgentSessions.mockResolvedValueOnce(sessions);
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-sessions-get', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'openclaw-sessions-reply', requestId: 'r1', sessions });
  });

  it('a listAgentSessions rejection is surfaced as an empty sessions reply, not a hang (M5/S10)', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.listAgentSessions.mockRejectedValueOnce(new Error('boom'));
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-sessions-get', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'openclaw-sessions-reply', requestId: 'r1', sessions: [] });
  });

  it('openclaw-config-get round-trips via openclaw-config-reply, echoing the requestId', async () => {
    const openclawSource = new FakeOpenClawSource();
    const config = { 'agents.defaults.model': 'openai/gpt-5.5', 'gateway.port': 'unset' };
    openclawSource.getCoreConfig.mockResolvedValueOnce(config);
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-config-get', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'openclaw-config-reply', requestId: 'r1', config });
  });

  it('a getCoreConfig rejection is surfaced as an all-unset config reply, not a hang (M5/S10)', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.getCoreConfig.mockRejectedValueOnce(new Error('boom'));
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-config-get', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-reply',
      requestId: 'r1',
      config: { 'agents.defaults.model': 'unset', 'gateway.port': 'unset' },
    });
  });

  it('openclaw-config-set round-trips via openclaw-config-set-reply on success', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.setCoreConfig.mockResolvedValueOnce({ ok: true, restartRequired: true });
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-config-set', requestId: 'r1', key: 'agents.defaults.model', value: 'x' });
    await flush();

    expect(openclawSource.setCoreConfig).toHaveBeenCalledWith('agents.defaults.model', 'x');
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-set-reply',
      requestId: 'r1',
      result: { ok: true, restartRequired: true },
    });
  });

  it('a setCoreConfig allowlist rejection is surfaced as an ok:false reply, not a crash', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.setCoreConfig.mockRejectedValueOnce(
      new Error("setCoreConfig: 'not.allowed' is not an allowlisted config key"),
    );
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    expect(() => {
      ws.clientSend({ kind: 'openclaw-config-set', requestId: 'r1', key: 'not.allowed', value: 'x' });
    }).not.toThrow();
    await flush();

    const reply = ws.sent.find((m) => m.kind === 'openclaw-config-set-reply') as {
      kind: 'openclaw-config-set-reply';
      requestId: string;
      result: { ok: boolean; restartRequired: boolean; error?: string };
    };
    expect(reply.result.ok).toBe(false);
    expect(reply.result.restartRequired).toBe(false);
    expect(reply.result.error).toContain('not an allowlisted');
  });

  it('openclaw-chat-ticket replies with the minted ticket/proxyPort/token on success', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.mintChatTicket.mockResolvedValueOnce({ ticket: 'tick-1', proxyPort: 7421, token: 'gw-token' });
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'r1',
      ticket: 'tick-1',
      proxyPort: 7421,
      token: 'gw-token',
    });
  });

  it('openclaw-chat-ticket replies with nulls/0 when no ticket could be minted', async () => {
    const openclawSource = new FakeOpenClawSource(); // mintChatTicket defaults to resolving null
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'r1' });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'r1',
      ticket: null,
      proxyPort: 0,
      token: null,
    });
  });

  it('without an openclawSource option, every openclaw-* message is a silent no-op (no reply, no crash)', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions(); // no openclawSource
    await authed(ws, options);

    expect(() => {
      ws.clientSend({ kind: 'openclaw-status-subscribe' });
      ws.clientSend({ kind: 'openclaw-status-unsubscribe' });
      ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'start' });
      ws.clientSend({ kind: 'openclaw-logs-subscribe' });
      ws.clientSend({ kind: 'openclaw-logs-unsubscribe' });
      ws.clientSend({ kind: 'openclaw-sessions-get', requestId: 'r2' });
      ws.clientSend({ kind: 'openclaw-config-get', requestId: 'r3' });
      ws.clientSend({ kind: 'openclaw-config-set', requestId: 'r4', key: 'k', value: 'v' });
      ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'r5' });
    }).not.toThrow();
    await flush();

    expect(ws.sent.filter((m) => m.kind.startsWith('openclaw-'))).toHaveLength(0);
  });
});

describe('RemoteBridge — OpenClaw availability (openclaw-stabilization M3)', () => {
  it('pushes openclaw-availability:true right after auth-ok when visible', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = true;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    expect(ws.sent).toContainEqual({ kind: 'openclaw-availability', visible: true });
  });

  it('pushes openclaw-availability:false right after auth-ok when hidden', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    expect(ws.sent).toContainEqual({ kind: 'openclaw-availability', visible: false });
  });

  it('does not push openclaw-availability without an openclawSource', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions(); // no openclawSource
    await authed(ws, options);

    expect(ws.sent.some((m) => m.kind === 'openclaw-availability')).toBe(false);
  });

  it('broadcasts openclaw-availability to an authed connection on a desktop mode change', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.sent.length = 0; // clear the post-auth push — this only asserts the broadcast

    openclawSource.emitVisibility(false);
    expect(ws.sent).toContainEqual({ kind: 'openclaw-availability', visible: false });

    openclawSource.emitVisibility(true);
    expect(ws.sent).toContainEqual({ kind: 'openclaw-availability', visible: true });
  });

  it('does not broadcast to a not-yet-authed connection', () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    attachConnection(ws, options);

    openclawSource.emitVisibility(false);

    expect(ws.sent).toHaveLength(0);
  });

  it('unsubscribes the visibility listener on close', async () => {
    const openclawSource = new FakeOpenClawSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    expect(openclawSource.visibilityListenerCount).toBe(1);

    ws.close();

    expect(openclawSource.visibilityListenerCount).toBe(0);
  });

  it('when hidden, openclaw-status-subscribe/openclaw-logs-subscribe are ignored (no listener, no reply)', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.sent.length = 0;

    ws.clientSend({ kind: 'openclaw-status-subscribe' });
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });

    expect(openclawSource.statusListenerCount).toBe(0);
    expect(openclawSource.logListenerCount).toBe(0);
    expect(ws.sent).toHaveLength(0);
  });

  it('when hidden, openclaw-lifecycle replies ok:false without calling runLifecycle', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'start' });

    expect(openclawSource.runLifecycle).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-lifecycle-result',
      requestId: 'r1',
      result: { ok: false, stderr: 'openclaw disabled' },
    });
  });

  it('when hidden, openclaw-config-get replies with every allowlisted key unset, without calling getCoreConfig', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-config-get', requestId: 'r1' });

    expect(openclawSource.getCoreConfig).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-reply',
      requestId: 'r1',
      config: { 'agents.defaults.model': 'unset', 'gateway.port': 'unset' },
    });
  });

  it('when hidden, openclaw-sessions-get replies with an empty sessions array, without calling listAgentSessions', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-sessions-get', requestId: 'r1' });

    expect(openclawSource.listAgentSessions).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({ kind: 'openclaw-sessions-reply', requestId: 'r1', sessions: [] });
  });

  it('when hidden, openclaw-config-set replies ok:false without calling setCoreConfig', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-config-set', requestId: 'r1', key: 'agents.defaults.model', value: 'x' });

    expect(openclawSource.setCoreConfig).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-set-reply',
      requestId: 'r1',
      result: { ok: false, restartRequired: false, error: 'openclaw disabled' },
    });
  });

  it('when hidden, openclaw-chat-ticket replies with nulls/0 without calling mintChatTicket', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'r1' });

    expect(openclawSource.mintChatTicket).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({ kind: 'openclaw-chat-ticket-reply', requestId: 'r1', ticket: null, proxyPort: 0, token: null });
  });
});

describe('RemoteBridge — Agent Activity parity', () => {
  it('pushes the auth snapshot, relays revisions, and correlates snapshot/followup replies', async () => {
    const agentSource = new FakeAgentSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ agentSource });
    await authed(ws, options);
    expect(ws.sent).toContainEqual({ kind: 'agent-snapshot', snapshot: { revision: 1, items: [] } });
    expect(agentSource.listenerCount).toBe(1);

    const activity = {
      id: 'activity-1',
      sessionId: 'session-1',
      provider: 'codex' as const,
      cwd: '/repo',
      status: 'waiting' as const,
      createdAt: 1,
      updatedAt: 2,
    };
    agentSource.emit({ revision: 2, items: [activity] });
    expect(ws.sent).toContainEqual({ kind: 'agent-snapshot', snapshot: { revision: 2, items: [activity] } });

    ws.clientSend({ kind: 'agent-snapshot-get', requestId: 'snap-1' });
    expect(ws.sent).toContainEqual({
      kind: 'agent-snapshot',
      requestId: 'snap-1',
      snapshot: { revision: 2, items: [activity] },
    });
    ws.clientSend({ kind: 'agent-followup', requestId: 'follow-1', activityId: 'activity-1', text: 'continue' });
    expect(agentSource.sendFollowup).toHaveBeenCalledWith('activity-1', 'continue');
    expect(ws.sent).toContainEqual({ kind: 'agent-followup-reply', requestId: 'follow-1', result: { ok: true } });

    ws.close();
    expect(agentSource.listenerCount).toBe(0);
  });
});

describe('RemoteBridge — file explorer read ownership', () => {
  it('fails closed on a duplicate active file-read request id without opening a second stream', async () => {
    const { stream, closeSpy } = makeFakeReadStream(
      { fileSize: 2, sendBytes: 2, isText: true, truncated: false },
      [new Uint8Array([1]), new Uint8Array([2])],
    );
    const openReadStream = vi.fn(async () => stream);
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource: makeFileSource({ openReadStream }) });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'duplicate', path: '/a', mode: 'text' });
    await flush();
    ws.clientSend({ kind: 'file-read', requestId: 'duplicate', path: '/b', mode: 'text' });
    await flush();

    expect(openReadStream).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'file-read-meta', requestId: 'duplicate', ok: false,
    }));
  });

  it('reserves a file-read id before open completes and closes the late stream after cancellation', async () => {
    let resolveOpen!: (stream: { ok: true } & FileReadStream) => void;
    const { stream, closeSpy } = makeFakeReadStream(
      { fileSize: 2, sendBytes: 2, isText: true, truncated: false },
      [new Uint8Array([1]), new Uint8Array([2])],
    );
    const openReadStream = vi.fn(() => new Promise<{ ok: true } & FileReadStream>((resolve) => {
      resolveOpen = resolve;
    }));
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource: makeFileSource({ openReadStream }) });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'opening', path: '/a', mode: 'text' });
    ws.clientSend({ kind: 'file-read', requestId: 'opening', path: '/b', mode: 'text' });
    expect(openReadStream).toHaveBeenCalledTimes(1);
    ws.clientSend({ kind: 'file-read-cancel', requestId: 'opening' });
    resolveOpen(stream);
    await flush();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(ws.sent.some((message) => (
      message.kind === 'file-read-chunk' && message.requestId === 'opening'
    ))).toBe(false);
  });

  it('contains a rejection while closing a stream that opened after cancellation', async () => {
    let resolveOpen!: (stream: { ok: true } & FileReadStream) => void;
    const close = vi.fn(async () => { throw new Error('late close failed'); });
    const stream = {
      ok: true as const,
      meta: { fileSize: 1, sendBytes: 1, isText: true, truncated: false },
      next: vi.fn(async () => ({ offset: 0, data: new Uint8Array([1]), done: true })),
      close,
    };
    const openReadStream = vi.fn(() => new Promise<{ ok: true } & FileReadStream>((resolve) => {
      resolveOpen = resolve;
    }));
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource: makeFileSource({ openReadStream }) });
    await authed(ws, options);

    ws.clientSend({ kind: 'file-read', requestId: 'late-close', path: '/a', mode: 'text' });
    ws.clientSend({ kind: 'file-read-cancel', requestId: 'late-close' });
    resolveOpen(stream);
    await flush();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps unresolved opens in a source-wide cap across reconnects and aborts them on close', async () => {
    type OpenResult = Awaited<ReturnType<RemoteFileSource['openReadStream']>>;
    const resolvers: Array<(result: OpenResult) => void> = [];
    const signals: AbortSignal[] = [];
    const openReadStream = vi.fn((
      _path: string,
      _mode: 'text' | 'raw' | 'preview',
      _handle?: unknown,
      signal?: AbortSignal,
    ) => new Promise<OpenResult>((resolve) => {
      resolvers.push(resolve);
      if (signal) signals.push(signal);
    }));
    const fileSource = makeFileSource({ openReadStream });
    const { options } = makeOptions({ fileSource });
    const first = new FakeWs();
    await authed(first, options);

    for (let index = 0; index < MAX_REMOTE_PENDING_FILE_OPENS; index += 1) {
      first.clientSend({ kind: 'file-read', requestId: `slow-${index}`, path: `/slow-${index}`, mode: 'text' });
    }
    await flush();
    expect(openReadStream).toHaveBeenCalledTimes(MAX_REMOTE_PENDING_FILE_OPENS);
    first.close();
    expect(signals).toHaveLength(MAX_REMOTE_PENDING_FILE_OPENS);
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    const second = new FakeWs();
    await authed(second, options);
    second.clientSend({ kind: 'file-read', requestId: 'reconnect-slow', path: '/slow', mode: 'text' });
    expect(openReadStream).toHaveBeenCalledTimes(MAX_REMOTE_PENDING_FILE_OPENS);
    expect(second.sent).toContainEqual(expect.objectContaining({
      kind: 'file-read-meta', requestId: 'reconnect-slow', ok: false,
    }));

    for (const resolve of resolvers.splice(0)) resolve({ ok: false, error: 'cancelled' });
    await flush();
    second.clientSend({ kind: 'file-read', requestId: 'after-settle', path: '/ok', mode: 'text' });
    await flush();
    expect(openReadStream).toHaveBeenCalledTimes(MAX_REMOTE_PENDING_FILE_OPENS + 1);
    resolvers.pop()?.({ ok: false, error: 'cancelled' });
    second.close();
  });

  it('serializes file-read ACKs and fails closed on a duplicate offset', async () => {
    let resolveSecond!: (value: { offset: number; data: Uint8Array; done: boolean }) => void;
    const close = vi.fn(async () => undefined);
    const next = vi.fn()
      .mockResolvedValueOnce({ offset: 0, data: new Uint8Array([1]), done: false })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const stream = {
      ok: true as const,
      meta: { fileSize: 2, sendBytes: 2, isText: true, truncated: false },
      next,
      close,
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource: makeFileSource({ openReadStream: vi.fn(async () => stream) }) });
    await authed(ws, options);
    ws.clientSend({ kind: 'file-read', requestId: 'r1', path: '/a', mode: 'text' });
    await flush();

    ws.clientSend({ kind: 'file-read-ack', requestId: 'r1', offset: 1 });
    ws.clientSend({ kind: 'file-read-ack', requestId: 'r1', offset: 1 });
    await flush();

    expect(next).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    resolveSecond({ offset: 1, data: new Uint8Array([2]), done: true });
    await flush();
    expect(ws.sent.filter((message) => message.kind === 'file-read-chunk')).toHaveLength(1);
  });

  it('caps active file reads per connection and releases them on close', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const openReadStream = vi.fn(async () => {
      const { stream, closeSpy } = makeFakeReadStream(
        { fileSize: 2, sendBytes: 2, isText: true, truncated: false },
        [new Uint8Array([1]), new Uint8Array([2])],
      );
      closes.push(closeSpy);
      return stream;
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource: makeFileSource({ openReadStream }) });
    await authed(ws, options);

    for (let index = 0; index <= MAX_REMOTE_FILE_READS; index += 1) {
      ws.clientSend({ kind: 'file-read', requestId: `r-${index}`, path: `/f-${index}`, mode: 'text' });
    }
    await flush();

    expect(openReadStream).toHaveBeenCalledTimes(MAX_REMOTE_FILE_READS);
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'file-read-meta', requestId: `r-${MAX_REMOTE_FILE_READS}`, ok: false,
    }));
    ws.close();
    expect(closes).toHaveLength(MAX_REMOTE_FILE_READS);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });
});

describe('RemoteBridge - Git worktrees', () => {
  it('correlates list/open replies and always identifies the caller as mobile', async () => {
    const execute = vi.fn(async (request: WorktreeRequest) => ({
      ok: true as const,
      action: request.action,
      worktrees: [],
    }));
    const ws = new FakeWs();
    const { options } = makeOptions({ worktreeSource: { execute } });
    await authed(ws, options);

    ws.clientSend({ kind: 'worktree-request', requestId: 'wt-list', request: { action: 'list', cwd: '/repo' } });
    ws.clientSend({
      kind: 'worktree-request',
      requestId: 'wt-open',
      request: { action: 'open', cwd: '/repo', worktreeId: 'wt-1' },
    });
    await flush();

    expect(execute).toHaveBeenNthCalledWith(1, { action: 'list', cwd: '/repo' }, 'mobile');
    expect(execute).toHaveBeenNthCalledWith(2, { action: 'open', cwd: '/repo', worktreeId: 'wt-1' }, 'mobile');
    expect(ws.sent).toContainEqual({
      kind: 'worktree-reply',
      requestId: 'wt-list',
      result: { ok: true, action: 'list', worktrees: [] },
    });
    expect(ws.sent).toContainEqual({
      kind: 'worktree-reply',
      requestId: 'wt-open',
      result: { ok: true, action: 'open', worktrees: [] },
    });
  });

  it('rejects malformed requests at the bridge without reaching the service', async () => {
    const execute = vi.fn();
    const ws = new FakeWs();
    const { options } = makeOptions({ worktreeSource: { execute } });
    await authed(ws, options);

    ws.clientSend({ kind: 'worktree-request', requestId: 'bad', request: { action: 'remove', cwd: '/repo' } });

    expect(execute).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'worktree-reply',
      requestId: 'bad',
      result: {
        ok: false,
        action: 'list',
        error: 'INVALID_REQUEST',
        message: 'Invalid worktree request.',
      },
    });
  });
});

describe('RemoteBridge - read-only Quick Commands capability', () => {
  const command = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Check status',
    command: 'git status --short',
    description: 'Show concise repository status',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  } as const;

  it('advertises the capability and returns only schema-valid commands', async () => {
    const quickCommandSource: RemoteQuickCommandSource = {
      list: vi.fn(async () => [
        command,
        { ...command, id: 'not-a-uuid', name: 'Invalid' },
      ] as never),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ quickCommandSource });
    await authed(ws, options);

    expect(ws.sent).toContainEqual({ kind: 'auth-ok', capabilities: ['quick-commands-read'] });

    ws.clientSend({ kind: 'quick-commands-list', requestId: 'qc-1' });
    await flush();

    expect(quickCommandSource.list).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual({
      kind: 'quick-commands-list-reply',
      requestId: 'qc-1',
      ok: true,
      commands: [command],
    });
  });

  it('keeps older hosts capability-free and reports unavailable if probed', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);

    expect(ws.sent).toContainEqual({ kind: 'auth-ok' });
    ws.clientSend({ kind: 'quick-commands-list', requestId: 'qc-unsupported' });

    expect(ws.sent).toContainEqual({
      kind: 'quick-commands-list-reply',
      requestId: 'qc-unsupported',
      ok: false,
      error: 'unavailable',
    });
  });

  it('contains source failures within a correlated unavailable reply', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions({
      quickCommandSource: { list: vi.fn(async () => { throw new Error('store unavailable'); }) },
    });
    await authed(ws, options);

    ws.clientSend({ kind: 'quick-commands-list', requestId: 'qc-error' });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'quick-commands-list-reply',
      requestId: 'qc-error',
      ok: false,
      error: 'unavailable',
    });
  });
});

describe('startRemoteBridge — real WS server lifecycle (v0.2.0 D2)', () => {
  // Dedicated fixed port (distinct from e2e's session-mirror.spec.ts 17420) so a
  // same-port restart below is deterministic rather than relying on OS-assigned port 0.
  const TEST_PORT = 17431;

  function connect(port: number): Promise<RealWebSocket> {
    return new Promise((resolve, reject) => {
      const client = new RealWebSocket(`ws://127.0.0.1:${port}`);
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });
  }

  it('stop() terminates connected clients (their close fires) and releases the port for an immediate same-port restart', async () => {
    const { options } = makeOptions({ port: TEST_PORT });
    const handle = startRemoteBridge(options);
    const client = await connect(TEST_PORT);

    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await handle.stop();
    await clientClosed; // wss's per-client ws.terminate() fired the client's own close

    // Immediate restart on the SAME port must not throw EADDRINUSE: stop()
    // only resolves once wss.close's callback fires, guaranteeing the
    // previous listening socket is released first.
    const handle2 = startRemoteBridge(options);
    const client2 = await connect(TEST_PORT);
    client2.close();
    await handle2.stop();
  }, 10_000);
});
