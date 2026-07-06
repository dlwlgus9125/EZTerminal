import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as RealWebSocket } from 'ws';

import {
  attachConnection,
  AUTH_CLOSE_CODE,
  startRemoteBridge,
  type RemoteBridgeOptions,
  type RemoteFileSource,
  type RemoteInterpreter,
  type RemoteMessageChannel,
  type RemotePacketSource,
  type RemotePort,
  type RemoteStatsSource,
  type RemoteWs,
} from './remote-bridge';
import { SessionDirectory } from './session-directory';
import type { FileReadStream } from './file-service';
import type { InterpreterToMain, MainToInterpreter, PacketRow, SystemStatsSnapshot } from '../shared/ipc';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import { uint8ArrayToBase64, type RemotePacketFrame, type ServerToClientMessage } from '../shared/remote-protocol';

const TOKEN = 'the-secret-token';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

class FakeInterpreter implements RemoteInterpreter {
  readonly posted: Array<{ message: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  private readonly listeners = new Set<(message: InterpreterToMain) => void>();

  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    this.posted.push({ message, transfer });
  }

  on(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: simulate the interpreter replying to main. */
  emit(message: InterpreterToMain): void {
    for (const l of this.listeners) l(message);
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
  sessionDirectory: SessionDirectory;
  channels: Array<{ port1: FakePort; port2: FakePort }>;
} {
  const interpreter = new FakeInterpreter();
  const sessionDirectory = new SessionDirectory();
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  let idCounter = 0;

  const options: RemoteBridgeOptions = {
    port: 0,
    getToken: () => TOKEN,
    interpreter,
    sessionDirectory,
    createMessageChannel: () => {
      const channel = makeFakeChannel() as { port1: FakePort; port2: FakePort };
      channels.push(channel);
      return channel;
    },
    newId: () => `id-${++idCounter}`,
    ...overrides,
  };
  return { options, interpreter, sessionDirectory, channels };
}

async function authed(ws: FakeWs, options: RemoteBridgeOptions): Promise<void> {
  attachConnection(ws, options);
  ws.clientSend({ kind: 'auth', token: TOKEN });
  await flush();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RemoteBridge — auth gate', () => {
  it('rejects a wrong token: sends auth-fail and closes with AUTH_CLOSE_CODE', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);
    ws.clientSend({ kind: 'auth', token: 'wrong' });
    await flush();
    expect(ws.sent).toContainEqual({ kind: 'auth-fail' });
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
});

describe('RemoteBridge — session directory + create/destroy round trip', () => {
  it('create-session posts to the interpreter and relays session-created back with the CLIENT requestId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, sessionDirectory } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1', cwd: '/tmp' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({
      type: 'create-session',
      requestId: 'id-1',
      cwd: '/tmp',
    });

    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });

    expect(ws.sent).toContainEqual({
      kind: 'session-created',
      requestId: 'client-req-1',
      session: { sessionId: 'sess-1', cwd: '/tmp' },
    });
    expect(sessionDirectory.list()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('a session-created reply for a DIFFERENT (unmatched) requestId is ignored by this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1' });

    // Some other connection's create-session round trip.
    interpreter.emit({ type: 'session-created', requestId: 'not-mine', sessionId: 'sess-x', cwd: '/x' });

    expect(ws.sent.some((m) => m.kind === 'session-created')).toBe(false);
  });

  it('list-sessions returns the current directory contents', async () => {
    const ws = new FakeWs();
    const { options, sessionDirectory } = makeOptions();
    sessionDirectory.add({ sessionId: 'existing', cwd: '/existing' });
    await authed(ws, options);

    ws.clientSend({ kind: 'list-sessions' });

    expect(ws.sent).toContainEqual({
      kind: 'session-list',
      sessions: [{ sessionId: 'existing', cwd: '/existing' }],
    });
  });

  it('destroy-session removes it from the directory and posts to the interpreter', async () => {
    const ws = new FakeWs();
    const { options, interpreter, sessionDirectory } = makeOptions();
    sessionDirectory.add({ sessionId: 'sess-1', cwd: '/tmp' });
    await authed(ws, options);

    ws.clientSend({ kind: 'destroy-session', sessionId: 'sess-1' });

    expect(sessionDirectory.list()).toEqual([]);
    expect(interpreter.posted).toContainEqual({
      message: { type: 'destroy-session', sessionId: 'sess-1' },
      transfer: undefined,
    });
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

    expect(ws.sent).toContainEqual({ kind: 'run-list', runs });
  });

  it('a run-list reply for a DIFFERENT (unmatched) requestId is NOT relayed to this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'list-runs' });

    // Some other connection's list-runs round trip.
    interpreter.emit({ type: 'run-list', requestId: 'not-mine', runs: [] });

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
  it('relays an interpreter frame to the WS tagged with the correct runId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({ type: 'run', commandText: 'ls', sessionId: 'sess-1', runId: 'run-1' });
    expect(channels).toHaveLength(1);
    expect(channels[0].port1.started).toBe(true);

    channels[0].port2.postMessage({ type: 'start', commandText: 'ls', cwd: '/tmp' });

    expect(ws.sent).toContainEqual({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'start', commandText: 'ls', cwd: '/tmp' },
    });
  });

  it('encodes a pty-data frame as base64 on relay', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });

    channels[0].port2.postMessage({ type: 'pty-data', data: new Uint8Array([104, 105]) }); // "hi"

    const frameMsg = ws.sent.find((m) => m.kind === 'frame') as {
      kind: 'frame';
      runId: string;
      frame: { type: string; data: string };
    };
    expect(frameMsg.frame.type).toBe('pty-data');
    expect(typeof frameMsg.frame.data).toBe('string');
    expect(frameMsg.frame.data).not.toBeInstanceOf(Uint8Array);
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
  it('closing the WS closes every open run port and detaches the interpreter listener', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);
    expect(interpreter.listenerCount).toBe(1);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    ws.clientSend({ kind: 'run-command', runId: 'run-2', sessionId: 'sess-1', commandText: 'pwd' });
    expect(channels.every((c) => !c.port1.closed)).toBe(true);

    ws.close();

    expect(channels.every((c) => c.port1.closed)).toBe(true);
    expect(interpreter.listenerCount).toBe(0);
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

    expect(fileSource.openReadStream).toHaveBeenCalledWith('C:\\a.txt', 'text');
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
