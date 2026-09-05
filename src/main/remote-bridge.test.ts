import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as RealWebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachConnection,
  AUTH_CLOSE_CODE,
  PROTOCOL_CLOSE_CODE,
  MAX_REMOTE_FILE_READS,
  MAX_REMOTE_FILE_UPLOADS,
  MAX_REMOTE_PENDING_FILE_OPENS,
  isRemoteOriginAllowed,
  startRemoteBridge,
  tokensMatch,
  type OpenClawChatTicketResult,
  type RemoteBridgeOptions,
  type RemoteAgentCoordinationSource,
  type RemoteAgentOrchestrationSource,
  type RemoteAgentSource,
  type RemoteAgentHistorySource,
  type RemoteDaemonSource,
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
import { RemoteRunInitiatorRegistry } from './remote-run-initiator';
import { RemoteRunLeaseRegistry } from './remote-run-lease';
import { SessionWorktreeGuard } from './session-worktree-guard';
import type { FileReadStream } from './file-service';
import { FileService } from './file-service';
import type {
  InterpreterToMain,
  MainToInterpreter,
  PacketRow,
  RunAttachRejectReason,
  RunStartedInfo,
  SystemStatsSnapshot,
} from '../shared/ipc';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import {
  REMOTE_PROTOCOL_VERSION,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  uint8ArrayToBase64,
  type AuthMessage,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../shared/remote-protocol';
import type {
  OpenClawAgentSession,
  OpenClawControlSnapshot,
  OpenClawLifecycleReceipt,
  OpenClawLogLine,
  OpenClawStatus,
} from '../shared/openclaw';
import type { AgentActivitySnapshot, AgentDecisionResult, AgentFollowupResult } from '../shared/agent';
import type {
  AgentCoordinationSnapshot,
  AgentProjectCoordinationInput,
  ManagedMergeRequest,
} from '../shared/agent-coordination';
import {
  DEFAULT_COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_MERGE_POLICY,
  type AgentOrchestrationSnapshot,
  type CollaborationPolicy,
} from '../shared/agent-orchestration';
import { EMPTY_GIT_DIRECTORY_STATUS } from '../shared/git-status';
import type { WorktreeRequest } from '../shared/worktree';
import type { SessionSurfaceBinding } from '../shared/session-surface';
import {
  DAEMON_PROTOCOL_VERSION,
  createDaemonCommand,
  type DaemonEvent,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';

const TOKEN = 'the-secret-token';
const HOST_VERSION = '1.0.0-test';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function authMessage(token = TOKEN): AuthMessage {
  return {
    kind: 'auth',
    token,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    clientVersion: '1.0.0-test',
    buildSha: 'test-sha',
    clientIdentity: {
      clientId: '00000000-0000-4000-8000-000000000001',
      clientName: 'test-phone',
      platform: 'android',
    },
  };
}

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
  readonly sendFollowup = vi.fn(async (): Promise<AgentFollowupResult> => ({ ok: true }));
  readonly decideApproval = vi.fn((): AgentDecisionResult => ({ ok: true }));
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
  private readonly controlListeners = new Set<(snapshot: OpenClawControlSnapshot) => void>();
  private readonly logListeners = new Set<(line: OpenClawLogLine) => void>();
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();
  /** Mutable — tests flip this directly to script the M3 hidden-gating
   * scenarios, then call `emitVisibility` to also drive the broadcast path. */
  visible = true;
  readonly runLifecycle = vi.fn(async (): Promise<OpenClawLifecycleReceipt> => ({ accepted: true }));
  readonly listAgentSessions = vi.fn(async (): Promise<readonly OpenClawAgentSession[]> => []);
  readonly getCoreConfig = vi.fn(async () => ({ 'agents.defaults.model': 'unset', 'gateway.port': 'unset' }));
  readonly setCoreConfig = vi.fn(async () => ({ ok: true, restartRequired: true }));
  readonly mintChatTicket = vi.fn(async (): Promise<OpenClawChatTicketResult> => ({
    ticket: null,
    reason: 'proxy-unavailable',
  }));

  subscribeStatus(listener: (status: OpenClawStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  subscribeControl(listener: (snapshot: OpenClawControlSnapshot) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
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

  get controlListenerCount(): number {
    return this.controlListeners.size;
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

  emitControl(snapshot: OpenClawControlSnapshot): void {
    for (const listener of this.controlListeners) listener(snapshot);
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
    hostVersion: HOST_VERSION,
    broker,
    ...overrides,
  };
  return { options, interpreter, broker, channels };
}

async function authed(ws: FakeWs, options: RemoteBridgeOptions): Promise<void> {
  attachConnection(ws, options);
  ws.clientSend(authMessage());
  await flush();
}

function daemonSnapshot(revision = 3, eventSequence = 5): DaemonSnapshot {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision,
    eventSequence,
    generatedAt: '2026-09-04T10:00:00.000Z',
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: false,
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
  };
}

function makeDaemonSource(snapshot = daemonSnapshot()): {
  readonly source: RemoteDaemonSource;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly readTranscript: ReturnType<typeof vi.fn>;
  readonly emit: (event: DaemonEvent) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((event: DaemonEvent) => void) | undefined;
  const execute = vi.fn(async (command: { readonly commandId: string }) => ({
    ok: true as const,
    status: 'applied' as const,
    commandId: command.commandId,
    revision: snapshot.revision + 1,
    eventSequence: snapshot.eventSequence + 1,
  }));
  const readTranscript = vi.fn(() => ([{
    id: 'transcript-1',
    sessionId: 'agent-1',
    sequence: 2,
    kind: 'assistant-message' as const,
    text: 'Ready.',
    isDelta: false,
    isSensitive: false,
    createdAt: '2026-09-04T10:00:01.000Z',
  }]));
  const unsubscribe = vi.fn();
  return {
    source: {
      getSnapshot: () => snapshot,
      readTranscript,
      execute,
      onEvent: (next) => {
        listener = next;
        return unsubscribe;
      },
    },
    execute,
    readTranscript,
    emit: (event) => listener?.(event),
    unsubscribe,
  };
}

async function replyToRunList(
  ws: FakeWs,
  interpreter: FakeInterpreter,
  runs: readonly RunStartedInfo[],
): Promise<void> {
  ws.clientSend({ kind: 'list-runs' });
  const request = [...interpreter.posted]
    .reverse()
    .find((entry) => entry.message.type === 'list-runs')?.message;
  if (request?.type !== 'list-runs') throw new Error('no run-list request');
  interpreter.emit({ type: 'run-list', requestId: request.requestId, runs });
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
    ws.clientSend(authMessage('wrong'));
    await flush();
    expect(ws.sent).toContainEqual({ kind: 'auth-fail', reason: 'invalid-token' });
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('accepts the correct token: sends auth-ok and does not close', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions({ buildSha: 'release-sha' });
    await authed(ws, options);
    expect(ws.sent).toContainEqual({
      kind: 'auth-ok',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      hostBuildSha: 'release-sha',
    });
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
    ws.clientSend(authMessage());
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

  it.each([
    ['missing', { kind: 'auth', token: TOKEN, clientVersion: '1.0.0' }],
    ['unsupported', { ...authMessage(), protocolVersion: REMOTE_PROTOCOL_VERSION + 1 }],
  ])('rejects a %s protocol version distinctly from credentials', async (_label, payload) => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);

    ws.clientSend(payload);
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'auth-fail',
      reason: 'incompatible-protocol',
      supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
      hostVersion: HOST_VERSION,
    });
    expect(ws.closeCode).toBe(PROTOCOL_CLOSE_CODE);
  });

  it.each([1, 2, 3, 4, 5, 6])('rejects legacy protocol v%i without downgrade', async (version) => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);

    ws.clientSend({ ...authMessage(), protocolVersion: version });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'auth-fail',
      reason: 'incompatible-protocol',
      supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
      supportedProtocolVersions: [REMOTE_PROTOCOL_VERSION],
      hostVersion: HOST_VERSION,
    });
    expect(ws.closeCode).toBe(PROTOCOL_CLOSE_CODE);
  });

  it('validates the handshake before atomically consuming a pairing code', async () => {
    let live = true;
    const pairingSource = {
      match: vi.fn((candidate: string) => (
        live && candidate === 'PAIR-CODE' ? 1 : null
      )),
      consume: vi.fn((candidate: string, generation: number) => {
        if (!live || candidate !== 'PAIR-CODE' || generation !== 1) return false;
        live = false;
        return true;
      }),
    };
    const { options } = makeOptions({ pairingSource });

    const incompatible = new FakeWs();
    attachConnection(incompatible, options);
    incompatible.clientSend({
      ...authMessage('PAIR-CODE'),
      protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
    });
    await flush();
    expect(incompatible.closeCode).toBe(PROTOCOL_CLOSE_CODE);
    expect(pairingSource.consume).not.toHaveBeenCalled();

    const legacy = new FakeWs();
    attachConnection(legacy, options);
    legacy.clientSend({
      ...authMessage('PAIR-CODE'),
      protocolVersion: 2,
    });
    await flush();
    expect(legacy.sent).toContainEqual(expect.objectContaining({
      kind: 'auth-fail',
      reason: 'incompatible-protocol',
    }));
    expect(legacy.closeCode).toBe(PROTOCOL_CLOSE_CODE);
    expect(pairingSource.consume).not.toHaveBeenCalled();

    const compatible = new FakeWs();
    attachConnection(compatible, options);
    compatible.clientSend(authMessage('PAIR-CODE'));
    await flush();

    expect(compatible.sent).toContainEqual(expect.objectContaining({
      kind: 'auth-ok',
      issuedToken: TOKEN,
    }));
    expect(pairingSource.consume).toHaveBeenCalledTimes(1);
  });

  it('does not expose protocol metadata until the token is valid', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);

    ws.clientSend({ ...authMessage('wrong'), protocolVersion: 99 });
    await flush();

    expect(ws.sent).toContainEqual({ kind: 'auth-fail', reason: 'invalid-token' });
    expect(ws.sent.some((message) => (
      message.kind === 'auth-fail' && message.reason === 'incompatible-protocol'
    ))).toBe(false);
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('rejects control and bidi characters in a device display name', async () => {
    for (const clientName of ['Galaxy\nInjected', 'Galaxy\u202Etxt.exe']) {
      const ws = new FakeWs();
      const onClientPresence = vi.fn();
      const { options } = makeOptions({ onClientPresence });
      attachConnection(ws, options);

      ws.clientSend({
        ...authMessage(),
        clientIdentity: {
          clientId: '01947000-0000-4000-8000-000000000001',
          clientName,
          platform: 'android',
        },
      });
      await flush();

      expect(ws.closeCode).toBe(PROTOCOL_CLOSE_CODE);
      expect(onClientPresence).not.toHaveBeenCalled();
    }
  });

  it('uses one opaque connection id for matching presence transitions', async () => {
    const ws = new FakeWs();
    const onClientPresence = vi.fn();
    const identity = {
      clientId: '01947000-0000-4000-8000-000000000001',
      clientName: 'Galaxy A',
      platform: 'android' as const,
    };
    const { options } = makeOptions({ onClientPresence });
    attachConnection(ws, options);

    ws.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    ws.close();

    expect(onClientPresence).toHaveBeenCalledTimes(2);
    const connectedId = onClientPresence.mock.calls[0]?.[2];
    const disconnectedId = onClientPresence.mock.calls[1]?.[2];
    expect(connectedId).toEqual(expect.any(String));
    expect(disconnectedId).toBe(connectedId);
  });

  it('finishes every owned teardown when desktop and presence observers throw', async () => {
    const ws = new FakeWs();
    const statsSource = new FakeStatsSource();
    const packetSource = new FakePacketSource();
    const openclawSource = new FakeOpenClawSource();
    const agentSource = new FakeAgentSource();
    const fileSource = makeFileSource();
    let gitSignal: AbortSignal | undefined;
    const gitSource = {
      getStatus: vi.fn((_directory: string, signal?: AbortSignal) => {
        gitSignal = signal;
        return new Promise<import('../shared/git-status').GitDirectoryStatus>(() => undefined);
      }),
      getDiff: vi.fn(async () => ({ ok: false as const, error: 'git-failed' as const })),
    };
    const desktopSource = {
      connected: vi.fn(),
      start: vi.fn(async () => ({
        ok: false as const,
        reason: 'unavailable' as const,
        errorCode: 'OFFLINE',
      })),
      signal: vi.fn(() => false),
      stop: vi.fn(async () => false),
      disconnected: vi.fn(() => {
        throw new Error('destroyed desktop observer');
      }),
    } satisfies NonNullable<RemoteBridgeOptions['desktopSource']>;
    const onClientPresence = vi.fn((
      _identity: import('../shared/remote-protocol').RemoteClientIdentity,
      presence: 'connected' | 'disconnected',
    ) => {
      if (presence === 'disconnected') throw new Error('destroyed roster observer');
    });
    const { options } = makeOptions({
      statsSource,
      packetSource,
      openclawSource,
      agentSource,
      fileSource,
      gitSource,
      desktopSource,
      onClientPresence,
    });
    attachConnection(ws, options);
    ws.clientSend({
      ...authMessage(),
      clientIdentity: {
        clientId: '01947000-0000-4000-8000-000000000001',
        clientName: 'Galaxy A',
        platform: 'android',
      },
    });
    await flush();
    ws.clientSend({ kind: 'stats-visible', visible: true });
    ws.clientSend({ kind: 'packets-subscribe' });
    ws.clientSend({ kind: 'openclaw-status-subscribe' });
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });
    ws.clientSend({
      kind: 'file-upload-begin',
      requestId: 'upload-1',
      dirPath: 'C:\\repo',
      name: 'file.txt',
      size: 1,
    });
    await flush();
    ws.clientSend({ kind: 'git-status', requestId: 'git-1', directory: 'C:\\repo' });

    expect(() => ws.close()).not.toThrow();
    await flush();

    expect(desktopSource.disconnected).toHaveBeenCalledOnce();
    expect(statsSource.releaseCount).toBe(1);
    expect(packetSource.listenerCount).toBe(0);
    expect(openclawSource.statusListenerCount).toBe(0);
    expect(openclawSource.logListenerCount).toBe(0);
    expect(openclawSource.visibilityListenerCount).toBe(0);
    expect(agentSource.listenerCount).toBe(0);
    expect(fileSource.abortUpload).toHaveBeenCalledWith('up-1');
    expect(gitSignal?.aborted).toBe(true);
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

describe('RemoteBridge — desktop control', () => {
  const identity = {
    clientId: '01947000-0000-4000-8000-000000000001',
    clientName: 'Galaxy A',
    platform: 'android' as const,
  };

  it('advertises only to an identified v2 VPN peer and relays the bounded lifecycle', async () => {
    const ws = new FakeWs();
    const sessionId = '01947000-0000-4000-8000-000000000099';
    let emit: ((event: never) => void) | null = null;
    const desktopSource = {
      connected: vi.fn(),
      start: vi.fn(async (_identity, _connectionId, _endpoint, nextEmit) => {
        emit = nextEmit;
        return {
          ok: true as const,
          sessionId,
          displays: [],
          selectedDisplayId: null,
          endpoint: { address: '100.64.0.1', port: 7422 },
          capabilities: { ctrlAltDelete: false, clipboardText: true, directTouch: true, multiMonitor: true },
          resumed: false,
        };
      }),
      signal: vi.fn(() => true),
      stop: vi.fn(async () => true),
      disconnected: vi.fn(),
    };
    const { options } = makeOptions({ desktopSource });
    attachConnection(ws, options, { localAddress: '100.64.0.1', peerAddress: '100.64.0.2' });
    ws.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'auth-ok', capabilities: ['desktop-control-v1'],
    }));

    ws.clientSend({
      kind: 'desktop-control-start',
      requestId: 'desktop-1',
      viewport: {
        pixelWidth: 1_170,
        pixelHeight: 2_160,
        visibleRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.75 },
        revision: 3,
      },
      qualityPreference: 'clarity',
    });
    await flush();
    expect(desktopSource.start).toHaveBeenCalledWith(
      identity,
      expect.any(String),
      { localAddress: '100.64.0.1', peerAddress: '100.64.0.2' },
      expect.any(Function),
      {
        pixelWidth: 1_170,
        pixelHeight: 2_160,
        visibleRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.75 },
        revision: 3,
      },
      'clarity',
    );
    const connectionId = desktopSource.start.mock.calls[0]?.[1];
    expect(connectionId).toEqual(expect.any(String));
    expect(desktopSource.connected).toHaveBeenCalledWith(
      identity.clientId,
      connectionId,
    );
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'desktop-control-start-result', requestId: 'desktop-1', ok: true, sessionId,
    }));

    ws.clientSend({ kind: 'desktop-signal', sessionId, signal: { type: 'offer', sdp: 'v=0' } });
    expect(desktopSource.signal).toHaveBeenCalledWith(
      identity.clientId,
      connectionId,
      sessionId,
      { type: 'offer', sdp: 'v=0' },
    );
    (emit as unknown as (event: unknown) => void)({ kind: 'desktop-control-status', sessionId, state: 'active' });
    expect(ws.sent).toContainEqual({ kind: 'desktop-control-status', sessionId, state: 'active' });

    ws.clientSend({ kind: 'desktop-control-stop', sessionId, reason: 'client-stop' });
    await flush();
    expect(desktopSource.stop).toHaveBeenCalledWith(identity.clientId, connectionId, sessionId);
    ws.close();
    expect(desktopSource.disconnected).toHaveBeenCalledWith(identity.clientId, connectionId);
  });

  it('requires Android identity and does not expose desktop control without trusted socket addresses', async () => {
    const desktopSource = {
      connected: vi.fn(),
      start: vi.fn(), signal: vi.fn(), stop: vi.fn(), disconnected: vi.fn(),
    };
    const withoutIdentity = new FakeWs();
    const { options } = makeOptions({ desktopSource });
    attachConnection(withoutIdentity, options, { localAddress: '100.64.0.1', peerAddress: '100.64.0.2' });
    const missingIdentityAuth = { ...authMessage(), clientIdentity: undefined };
    withoutIdentity.clientSend(missingIdentityAuth);
    await flush();
    expect(withoutIdentity.sent).toContainEqual(expect.objectContaining({
      kind: 'auth-fail', reason: 'incompatible-protocol',
    }));

    const withoutEndpoint = new FakeWs();
    attachConnection(withoutEndpoint, options);
    withoutEndpoint.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    expect(withoutEndpoint.sent.find((message) => message.kind === 'auth-ok')).not.toHaveProperty('capabilities');
  });

  it('does not advertise desktop control while the installed host is unavailable', async () => {
    const desktopSource = {
      isAvailable: vi.fn(() => false),
      connected: vi.fn(),
      start: vi.fn(), signal: vi.fn(), stop: vi.fn(), disconnected: vi.fn(),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ desktopSource });
    attachConnection(ws, options, { localAddress: '100.64.0.1', peerAddress: '100.64.0.2' });
    ws.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();

    expect(ws.sent.find((message) => message.kind === 'auth-ok')).not.toHaveProperty('capabilities');
    ws.clientSend({ kind: 'desktop-control-start', requestId: 'desktop-unavailable' });
    await flush();
    expect(desktopSource.start).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'desktop-control-start-result',
      requestId: 'desktop-unavailable',
      ok: false,
      errorCode: 'DESKTOP_CONTROL_UNAVAILABLE',
    }));
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
      await fileService.dispose();
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
    ws.clientSend(authMessage());
    ws.clientSend(authMessage());
    await flush();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(ws.sent.filter((message) => message.kind === 'auth-ok')).toHaveLength(1);
  });

  it('never fires on a failed auth', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    const onAuthenticated = vi.fn();
    attachConnection(ws, options, { onAuthenticated });
    ws.clientSend(authMessage('wrong'));
    await flush();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

async function openRemoteOwner(
  ws: FakeWs,
  interpreter: FakeInterpreter,
  requestId = 'open-1',
  surfaceId = 'surface-1',
): Promise<SessionSurfaceBinding> {
  ws.clientSend({
    kind: 'session-surface-open',
    requestId,
    surfaceId,
    intent: { kind: 'create', cwd: '/tmp' },
  });
  await Promise.resolve();
  const create = interpreter.posted.at(-1)?.message;
  if (create?.type !== 'create-session') throw new Error('expected create-session');
  interpreter.emit({
    type: 'session-created',
    requestId: create.requestId,
    sessionId: `session-${surfaceId}`,
    cwd: '/tmp',
  });
  await flush();
  const reply = ws.sent.find(
    (message) => message.kind === 'session-surface-open-result' && message.requestId === requestId,
  );
  if (reply?.kind !== 'session-surface-open-result' || !reply.result.ok) {
    throw new Error('expected surface binding');
  }

  return reply.result.binding;
}

class FakeAgentCoordinationSource implements RemoteAgentCoordinationSource {
  snapshot: AgentCoordinationSnapshot;
  readonly markSeen = vi.fn(() => true);
  readonly saveProject = vi.fn(async (input: AgentProjectCoordinationInput) => ({
    ok: true as const,
    value: {
      projectId: input.projectId,
      goal: input.goal,
      defaultTargetBranch: input.defaultTargetBranch,
      validationCommands: input.validationCommands,
      configRevision: (input.expectedRevision ?? 0) + 1,
      participants: [],
      updatedAt: 40,
    },
  }));
  readonly decideManagedMerge = vi.fn(async () => ({
    ok: true as const,
    value: this.snapshot.mergeRequests[0]!,
  }));
  private readonly listeners = new Set<(snapshot: AgentCoordinationSnapshot) => void>();

  constructor(request: ManagedMergeRequest) {
    this.snapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [],
      projects: [],
      mergeRequests: [request],
    };
  }

  getSnapshot(): AgentCoordinationSnapshot {
    return this.snapshot;
  }

  onSnapshot(listener: (snapshot: AgentCoordinationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: AgentCoordinationSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeAgentOrchestrationSource implements RemoteAgentOrchestrationSource {
  readonly policy: CollaborationPolicy = {
    schemaVersion: 1,
    projectId: 'project-1',
    enabled: true,
    permissionMode: 'ask',
    allowedWorkerProfileIds: ['profile-1'],
    limits: DEFAULT_COLLABORATION_LIMITS,
    mergePolicy: DEFAULT_COLLABORATION_MERGE_POLICY,
    revision: 1,
    updatedAt: 1,
  };
  snapshot: AgentOrchestrationSnapshot = {
    revision: 1,
    providers: [{ providerId: 'builtin:codex', kind: 'builtin', displayName: 'Codex' }],
    profiles: [{
      profileId: 'profile-1',
      providerId: 'builtin:codex',
      launcherId: 'codex',
      name: 'Codex worker',
      description: 'Read and write worker',
      permissionMode: 'ask',
      capabilities: ['worker', 'read', 'write', 'verify'],
      available: true,
      revision: 1,
    }],
    policies: [this.policy],
    runs: [],
    events: [],
    migration: { required: false, catalogItemCount: 0, runCount: 0 },
  };
  readonly savePolicy = vi.fn(async () => ({ ok: true as const, value: this.policy }));
  readonly cancelWorker = vi.fn(async () => ({
    ok: false as const,
    error: 'not-found' as const,
    message: 'Worker task not found.',
  }));
  readonly archiveWorker = vi.fn(async () => ({
    ok: false as const,
    error: 'not-found' as const,
    message: 'Worker task not found.',
  }));
  readonly stopRun = vi.fn(async () => ({
    ok: false as const,
    error: 'not-found' as const,
    message: 'Lead run not found.',
  }));
  readonly confirmLegacyMigration = vi.fn(async () => ({
    required: false,
    catalogItemCount: 0,
    runCount: 0,
    confirmedAt: 10,
  }));
  private readonly listeners = new Set<(snapshot: AgentOrchestrationSnapshot) => void>();

  getSnapshot(): AgentOrchestrationSnapshot {
    return this.snapshot;
  }

  onSnapshot(listener: (snapshot: AgentOrchestrationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: AgentOrchestrationSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

describe('RemoteBridge — v7 session surface lifecycle', () => {
  it('opens an owner and replies before its session-added echo', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);

    const binding = await openRemoteOwner(ws, interpreter, 'client-open-1');

    expect(binding).toMatchObject({
      surfaceId: 'surface-1',
      role: 'owner',
      session: { sessionId: 'session-surface-1', cwd: '/tmp' },
    });
    const replyIndex = ws.sent.findIndex(
      (message) => message.kind === 'session-surface-open-result',
    );
    const broadcastIndex = ws.sent.findIndex((message) => message.kind === 'session-added');
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(broadcastIndex).toBeGreaterThan(replyIndex);
    expect(broker.listSessions()).toMatchObject([{ sessionId: 'session-surface-1' }]);
  });

  it('lists the shared session directory after a surface open', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    await openRemoteOwner(ws, interpreter);

    ws.clientSend({ kind: 'list-sessions' });

    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'session-list',
      sessions: [expect.objectContaining({ sessionId: 'session-surface-1' })],
    }));
  });

  it('prepares and atomically terminates an owner binding', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);
    const binding = await openRemoteOwner(ws, interpreter);

    ws.clientSend({
      kind: 'session-surface-prepare-close',
      requestId: 'prepare-1',
      entries: [{ bindingId: binding.bindingId, expectedActiveRunIds: ['run-b', 'run-a'] }],
    });
    const prepared = ws.sent.find(
      (message) => (
        message.kind === 'session-surface-prepare-close-result'
        && message.requestId === 'prepare-1'
      ),
    );
    if (prepared?.kind !== 'session-surface-prepare-close-result' || !prepared.result.ok) {
      throw new Error('expected close token');
    }

    ws.clientSend({
      kind: 'session-surface-commit-close',
      requestId: 'commit-1',
      closeToken: prepared.result.prepared.closeToken,
      decisions: [{ bindingId: binding.bindingId, disposition: 'terminate' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    const destroy = interpreter.posted.at(-1)?.message;
    expect(destroy).toEqual({
      type: 'destroy-sessions-guarded',
      requestId: 'id-2',
      sessions: [{
        sessionId: binding.session.sessionId,
        expectedActiveRunIds: ['run-a', 'run-b'],
      }],
      deadlineAt: expect.any(Number),
    });
    interpreter.emit({
      type: 'session-destroy-result',
      requestId: 'id-2',
      sessionIds: [binding.session.sessionId],
      destroyed: true,
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-surface-commit-close-result',
      requestId: 'commit-1',
      result: { ok: true, keptSessionIds: [] },
    });
    expect(broker.listSessions()).toEqual([]);
  });

  it('detaches an adopted binding without terminating its session', async () => {
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions();
    await authed(ws, options);
    const creating = broker.createSession('/external');
    interpreter.emit({
      type: 'session-created',
      requestId: 'id-1',
      sessionId: 'external',
      cwd: '/external',
    });
    await creating;
    ws.clientSend({
      kind: 'session-surface-open',
      requestId: 'adopt-1',
      surfaceId: 'surface-adopted',
      intent: { kind: 'adopt', sessionId: 'external' },
    });
    await flush();
    const opened = ws.sent.find(
      (message) => message.kind === 'session-surface-open-result' && message.requestId === 'adopt-1',
    );
    if (opened?.kind !== 'session-surface-open-result' || !opened.result.ok) {
      throw new Error('expected adopted binding');
    }

    ws.clientSend({
      kind: 'session-surface-prepare-close',
      requestId: 'prepare-adopted',
      entries: [{ bindingId: opened.result.binding.bindingId, expectedActiveRunIds: [] }],
    });
    const prepared = ws.sent.find(
      (message) => (
        message.kind === 'session-surface-prepare-close-result'
        && message.requestId === 'prepare-adopted'
      ),
    );
    if (prepared?.kind !== 'session-surface-prepare-close-result' || !prepared.result.ok) {
      throw new Error('expected adopted close token');
    }
    ws.clientSend({
      kind: 'session-surface-commit-close',
      requestId: 'commit-adopted',
      closeToken: prepared.result.prepared.closeToken,
      decisions: [],
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-surface-commit-close-result',
      requestId: 'commit-adopted',
      result: { ok: true, keptSessionIds: [] },
    });
    expect(broker.listSessions()).toMatchObject([{ sessionId: 'external' }]);
    expect(interpreter.posted.filter(
      (entry) => entry.message.type === 'destroy-sessions-guarded',
    )).toEqual([]);
  });

  it('keeps explicit SessionSwitcher termination independent of view ownership', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    const binding = await openRemoteOwner(ws, interpreter);

    ws.clientSend({
      kind: 'session-terminate-guarded',
      requestId: 'terminate-1',
      sessionId: binding.session.sessionId,
      expectedActiveRunIds: [],
    });
    await Promise.resolve();
    const destroy = interpreter.posted.at(-1)?.message;
    if (destroy?.type !== 'destroy-session') throw new Error('expected guarded destroy');
    if (typeof destroy.requestId !== 'string') throw new Error('expected destroy request id');
    interpreter.emit({
      type: 'session-destroy-result',
      requestId: destroy.requestId,
      sessionIds: [binding.session.sessionId],
      destroyed: true,
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'session-terminate-result',
      requestId: 'terminate-1',
      result: { ok: true },
    });
  });

  it('ignores malformed surface and termination capabilities at the boundary', async () => {
    const ws = new FakeWs();
    const { options, broker, interpreter } = makeOptions();
    await authed(ws, options);
    const terminate = vi.spyOn(broker, 'destroySessionGuarded');

    ws.clientSend({
      kind: 'session-surface-open',
      requestId: 'open-invalid',
      surfaceId: '',
      intent: { kind: 'create' },
    });
    ws.clientSend({
      kind: 'session-terminate-guarded',
      requestId: 'terminate-invalid',
      sessionId: 'session-1',
      expectedActiveRunIds: ['run-1', 'run-1'],
    });
    await flush();

    expect(terminate).not.toHaveBeenCalled();
    expect(interpreter.posted).toEqual([]);
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
    ws.clientSend(authMessage());
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
    await authed(ws, { port: 0, getToken: () => TOKEN, hostVersion: HOST_VERSION, broker });

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
  it('advertises a parked initiating run only to the same restarted mobile install', async () => {
    const identity = {
      clientId: '01947000-0000-4000-8000-000000000001',
      clientName: 'Restarting phone',
      platform: 'android' as const,
    };
    const first = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 60_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    attachConnection(first, options);
    first.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();

    first.clientSend({
      kind: 'run-command',
      runId: 'run-owned',
      sessionId: 'sess-1',
      commandText: 'codex',
    });
    first.close();
    expect(leases.size).toBe(1);

    const restarted = new FakeWs();
    attachConnection(restarted, options);
    restarted.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    await replyToRunList(restarted, interpreter, [{
      sessionId: 'sess-1',
      runId: 'run-owned',
      commandText: 'codex',
    }]);
    expect(restarted.sent).toContainEqual({
      kind: 'run-list',
      runs: [{
        sessionId: 'sess-1',
        runId: 'run-owned',
        commandText: 'codex',
        resumeOwned: true,
      }],
    });

    const other = new FakeWs();
    attachConnection(other, options);
    other.clientSend({
      ...authMessage(),
      clientIdentity: {
        ...identity,
        clientId: '01947000-0000-4000-8000-000000000002',
        clientName: 'Other phone',
      },
    });
    await flush();
    await replyToRunList(other, interpreter, [{
      sessionId: 'sess-1',
      runId: 'run-owned',
      commandText: 'codex',
    }]);
    expect(other.sent).toContainEqual({
      kind: 'run-list',
      runs: [{ sessionId: 'sess-1', runId: 'run-owned', commandText: 'codex' }],
    });

    restarted.clientSend({
      kind: 'resume-run',
      sessionId: 'sess-1',
      runId: 'run-owned',
      generation: 1,
    });
    acceptLatestAttach(interpreter);
    await flush();
    expect(restarted.sent).toContainEqual({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-owned',
      generation: 1,
    });
    expect(channels[1].port1.posted).toContainEqual({ type: 'pty-claim-control' });
    expect(channels[0].port1.closed).toBe(true);
    leases.dispose();
  });

  it('keeps the initiating install resumable after the port lease expires while the run remains active', async () => {
    const identity = {
      clientId: '01947000-0000-4000-8000-000000000003',
      clientName: 'Long-backgrounded phone',
      platform: 'android' as const,
    };
    const first = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 1_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    attachConnection(first, options);
    first.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();

    vi.useFakeTimers();
    try {
      first.clientSend({
        kind: 'run-command',
        runId: 'run-after-lease',
        sessionId: 'sess-1',
        commandText: 'codex',
      });
      first.close();
      expect(leases.size).toBe(1);

      vi.advanceTimersByTime(1_001);
      expect(leases.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    const restarted = new FakeWs();
    attachConnection(restarted, options);
    restarted.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    await replyToRunList(restarted, interpreter, [{
      sessionId: 'sess-1',
      runId: 'run-after-lease',
      commandText: 'codex',
    }]);

    expect(restarted.sent).toContainEqual({
      kind: 'run-list',
      runs: [{
        sessionId: 'sess-1',
        runId: 'run-after-lease',
        commandText: 'codex',
        resumeOwned: true,
      }],
    });

    restarted.clientSend({
      kind: 'resume-run',
      sessionId: 'sess-1',
      runId: 'run-after-lease',
      generation: 2,
    });
    acceptLatestAttach(interpreter);
    await flush();

    expect(restarted.sent).toContainEqual({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-after-lease',
      generation: 2,
    });
    expect(channels[1].port1.posted).toContainEqual({
      type: 'pty-claim-control',
    });
  });

  it('explicit release-runs relinquishes initiator restoration for a later reconnect', async () => {
    const identity = {
      clientId: '01947000-0000-4000-8000-000000000004',
      clientName: 'Disconnecting phone',
      platform: 'android' as const,
    };
    const first = new FakeWs();
    const { options, interpreter } = makeOptions();
    attachConnection(first, options);
    first.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    first.clientSend({
      kind: 'run-command',
      runId: 'run-relinquished',
      sessionId: 'sess-1',
      commandText: 'codex',
    });
    first.clientSend({ kind: 'release-runs' });

    const restarted = new FakeWs();
    attachConnection(restarted, options);
    restarted.clientSend({ ...authMessage(), clientIdentity: identity });
    await flush();
    await replyToRunList(restarted, interpreter, [{
      sessionId: 'sess-1',
      runId: 'run-relinquished',
      commandText: 'codex',
    }]);

    expect(restarted.sent).toContainEqual({
      kind: 'run-list',
      runs: [{
        sessionId: 'sess-1',
        runId: 'run-relinquished',
        commandText: 'codex',
      }],
    });
  });

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
    attachConnection(ws2, options);
    ws2.clientSend({
      ...authMessage(),
      clientIdentity: {
        clientId: '01947000-0000-4000-8000-000000000099',
        clientName: 'Viewing phone',
        platform: 'android',
      },
    });
    await flush();
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
    expect(channels[2].port1.posted).not.toContainEqual({ type: 'pty-claim-control' });
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

  it('coalesces duplicate in-flight resumes without changing a viewing-only lease into control', async () => {
    const first = new FakeWs();
    const leases = new RemoteRunLeaseRegistry({ ttlMs: 60_000 });
    const { options, interpreter, channels } = makeOptions({ runLeases: leases });
    await authed(first, options);
    first.clientSend({
      kind: 'run-command',
      runId: 'run-1',
      sessionId: 'sess-1',
      commandText: 'ls',
    });
    first.close();
    expect(leases.size).toBe(1);

    const resumed = new FakeWs();
    attachConnection(resumed, options);
    resumed.clientSend({
      ...authMessage(),
      clientIdentity: {
        clientId: '01947000-0000-4000-8000-000000000098',
        clientName: 'Viewing phone',
        platform: 'android',
      },
    });
    await flush();
    const request = {
      kind: 'resume-run' as const,
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
    };
    resumed.clientSend(request);
    resumed.clientSend(request);

    expect(channels).toHaveLength(2);
    acceptLatestAttach(interpreter);
    await flush();
    expect(resumed.sent).toContainEqual({
      kind: 'resume-run-ready',
      sessionId: 'sess-1',
      runId: 'run-1',
      generation: 2,
    });
    expect(channels[1].port1.posted).not.toContainEqual({ type: 'pty-claim-control' });
    leases.dispose();
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

  it('fails closed instead of decoding or queueing chunks while one ack is pending', async () => {
    type ChunkResult = Awaited<ReturnType<RemoteFileSource['writeUploadChunk']>>;
    let resolveFirstChunk!: (result: ChunkResult) => void;
    const firstChunk = new Promise<ChunkResult>((resolve) => {
      resolveFirstChunk = resolve;
    });
    const writeUploadChunk = vi.fn()
      .mockImplementationOnce(() => firstChunk)
      .mockResolvedValue({ ok: true as const, receivedBytes: 4 });
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({
        ok: true as const,
        uploadId: 'one-in-flight-upload',
        finalName: 'bounded.bin',
      })),
      writeUploadChunk,
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);
    ws.clientSend({
      kind: 'file-upload-begin',
      requestId: 'one-in-flight-begin',
      dirPath: 'C:\\x',
      name: 'bounded.bin',
      size: 103,
    });
    await flush();

    ws.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'one-in-flight-upload',
      offset: 0,
      data: uint8ArrayToBase64(new Uint8Array([1, 2, 3])),
    });
    await flush();
    expect(writeUploadChunk).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 100; index += 1) {
      ws.clientSend({
        kind: 'file-upload-chunk',
        uploadId: 'one-in-flight-upload',
        offset: 3 + index,
        data: uint8ArrayToBase64(new Uint8Array([index])),
      });
    }
    await flush();

    resolveFirstChunk({ ok: true, receivedBytes: 3 });
    await flush();
    await flush();

    expect(writeUploadChunk).toHaveBeenCalledTimes(1);
    expect(fileSource.abortUpload).toHaveBeenCalledTimes(1);
    expect(fileSource.commitUpload).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'file-upload-ack',
      uploadId: 'one-in-flight-upload',
      ok: false,
      error: 'upload chunk already in flight',
    });
  });

  it('fails closed when commit arrives before the current chunk acknowledgement', async () => {
    type ChunkResult = Awaited<ReturnType<RemoteFileSource['writeUploadChunk']>>;
    let resolveChunk!: (result: ChunkResult) => void;
    const chunk = new Promise<ChunkResult>((resolve) => {
      resolveChunk = resolve;
    });
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({
        ok: true as const,
        uploadId: 'early-commit-upload',
        finalName: 'early-commit.bin',
      })),
      writeUploadChunk: vi.fn(() => chunk),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);
    ws.clientSend({
      kind: 'file-upload-begin',
      requestId: 'early-commit-begin',
      dirPath: 'C:\\x',
      name: 'early-commit.bin',
      size: 1,
    });
    await flush();

    ws.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'early-commit-upload',
      offset: 0,
      data: uint8ArrayToBase64(new Uint8Array([1])),
    });
    await flush();
    expect(fileSource.writeUploadChunk).toHaveBeenCalledTimes(1);

    ws.clientSend({ kind: 'file-upload-commit', uploadId: 'early-commit-upload' });
    await flush();
    resolveChunk({ ok: true, receivedBytes: 1 });
    await flush();
    await flush();

    expect(fileSource.commitUpload).not.toHaveBeenCalled();
    expect(fileSource.abortUpload).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual({
      kind: 'file-upload-done',
      uploadId: 'early-commit-upload',
      ok: false,
      error: 'upload chunk is still in flight',
    });
  });

  it('enforces upload ownership for chunk, commit, and abort across connections', async () => {
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({
        ok: true as const,
        uploadId: 'socket-a-upload',
        finalName: 'owned.bin',
      })),
    });
    const { options } = makeOptions({ fileSource });
    const owner = new FakeWs();
    const attacker = new FakeWs();
    await authed(owner, options);
    await authed(attacker, options);
    owner.clientSend({
      kind: 'file-upload-begin',
      requestId: 'owned-begin',
      dirPath: 'C:\\x',
      name: 'owned.bin',
      size: 1,
    });
    await flush();
    vi.mocked(fileSource.writeUploadChunk).mockClear();
    vi.mocked(fileSource.commitUpload).mockClear();
    vi.mocked(fileSource.abortUpload).mockClear();

    attacker.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'socket-a-upload',
      offset: 0,
      data: uint8ArrayToBase64(new Uint8Array([1])),
    });
    attacker.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'socket-a-upload',
      offset: 0,
      data: '***not-base64***',
    });
    attacker.clientSend({
      kind: 'file-upload-chunk',
      uploadId: 'socket-a-upload',
      offset: 0,
      data: uint8ArrayToBase64(new Uint8Array(FILE_CHUNK_BYTES * 2 + 1)),
    });
    attacker.clientSend({ kind: 'file-upload-commit', uploadId: 'socket-a-upload' });
    attacker.clientSend({ kind: 'file-upload-abort', uploadId: 'socket-a-upload' });
    await flush();

    expect(fileSource.writeUploadChunk).not.toHaveBeenCalled();
    expect(fileSource.commitUpload).not.toHaveBeenCalled();
    expect(fileSource.abortUpload).not.toHaveBeenCalled();
    expect(attacker.sent).toContainEqual({
      kind: 'file-upload-ack',
      uploadId: 'socket-a-upload',
      ok: false,
      error: 'unknown uploadId',
    });
    expect(attacker.sent).toContainEqual({
      kind: 'file-upload-done',
      uploadId: 'socket-a-upload',
      ok: false,
      error: 'unknown uploadId',
    });

    owner.clientSend({ kind: 'file-upload-abort', uploadId: 'socket-a-upload' });
    await flush();
    expect(fileSource.abortUpload).toHaveBeenCalledTimes(1);
    expect(fileSource.abortUpload).toHaveBeenCalledWith('socket-a-upload');
  });

  it('bounds pending plus open uploads per connection before opening more files', async () => {
    type BeginResult = Awaited<ReturnType<RemoteFileSource['beginUpload']>>;
    const expectedPerConnectionLimit = MAX_REMOTE_FILE_UPLOADS;
    const pending: Array<(result: BeginResult) => void> = [];
    const beginUpload = vi.fn(() => new Promise<BeginResult>((resolve) => {
      pending.push(resolve);
    }));
    const fileSource = makeFileSource({ beginUpload });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    for (let index = 0; index < expectedPerConnectionLimit + 1; index += 1) {
      ws.clientSend({
        kind: 'file-upload-begin',
        requestId: `bounded-upload-${index}`,
        dirPath: 'C:\\x',
        name: `bounded-${index}.bin`,
        size: 0,
      });
    }
    const callsBeforeSettlement = beginUpload.mock.calls.length;
    pending.forEach((resolve, index) => resolve({
      ok: true,
      uploadId: `bounded-id-${index}`,
      finalName: `bounded-${index}.bin`,
    }));
    await flush();

    expect(callsBeforeSettlement).toBe(expectedPerConnectionLimit);
    expect(ws.sent).toContainEqual({
      kind: 'file-upload-begin-reply',
      requestId: `bounded-upload-${expectedPerConnectionLimit}`,
      ok: false,
      error: 'too many active uploads',
    });
    ws.close();
    await flush();
    expect(fileSource.abortUpload).toHaveBeenCalledTimes(expectedPerConnectionLimit);
  });

  it('keeps terminating uploads inside the connection cap until source abort settles', async () => {
    let nextUpload = 0;
    const beginUpload = vi.fn(async (_dirPath: string, name: string) => {
      const uploadId = `terminating-id-${nextUpload}`;
      nextUpload += 1;
      return { ok: true as const, uploadId, finalName: name };
    });
    const pendingAborts: Array<() => void> = [];
    const abortUpload = vi.fn(() => new Promise<void>((resolve) => {
      pendingAborts.push(resolve);
    }));
    const fileSource = makeFileSource({ beginUpload, abortUpload });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);

    for (let index = 0; index < MAX_REMOTE_FILE_UPLOADS; index += 1) {
      ws.clientSend({
        kind: 'file-upload-begin',
        requestId: `terminating-begin-${index}`,
        dirPath: 'C:\\x',
        name: `terminating-${index}.bin`,
        size: 0,
      });
    }
    await flush();
    for (let index = 0; index < MAX_REMOTE_FILE_UPLOADS; index += 1) {
      ws.clientSend({ kind: 'file-upload-abort', uploadId: `terminating-id-${index}` });
    }
    await flush();
    expect(abortUpload).toHaveBeenCalledTimes(MAX_REMOTE_FILE_UPLOADS);

    try {
      ws.clientSend({
        kind: 'file-upload-begin',
        requestId: 'blocked-by-terminating',
        dirPath: 'C:\\x',
        name: 'blocked.bin',
        size: 0,
      });
      await flush();
      expect(beginUpload).toHaveBeenCalledTimes(MAX_REMOTE_FILE_UPLOADS);
      expect(ws.sent).toContainEqual({
        kind: 'file-upload-begin-reply',
        requestId: 'blocked-by-terminating',
        ok: false,
        error: 'too many active uploads',
      });

      pendingAborts.splice(0).forEach((resolve) => resolve());
      await flush();
      await flush();
      ws.clientSend({
        kind: 'file-upload-begin',
        requestId: 'after-terminating',
        dirPath: 'C:\\x',
        name: 'after-terminating.bin',
        size: 0,
      });
      await flush();
      expect(beginUpload).toHaveBeenCalledTimes(MAX_REMOTE_FILE_UPLOADS + 1);

      ws.clientSend({
        kind: 'file-upload-abort',
        uploadId: `terminating-id-${MAX_REMOTE_FILE_UPLOADS}`,
      });
      await flush();
      pendingAborts.splice(0).forEach((resolve) => resolve());
      await flush();
    } finally {
      pendingAborts.splice(0).forEach((resolve) => resolve());
      ws.close();
      await flush();
      pendingAborts.splice(0).forEach((resolve) => resolve());
    }
  });

  it('an oversized chunk (>2x FILE_CHUNK_BYTES decoded) is hard-rejected: ack ok:false + abortUpload, writeUploadChunk never called', async () => {
    const fileSource = makeFileSource({
      beginUpload: vi.fn(async () => ({
        ok: true as const,
        uploadId: 'up-1',
        finalName: 'oversized.bin',
      })),
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ fileSource });
    await authed(ws, options);
    ws.clientSend({
      kind: 'file-upload-begin',
      requestId: 'oversized-begin',
      dirPath: 'C:\\x',
      name: 'oversized.bin',
      size: FILE_CHUNK_BYTES * 2 + 1,
    });
    await flush();

    const oversized = new Uint8Array(FILE_CHUNK_BYTES * 2 + 1);
    ws.clientSend({ kind: 'file-upload-chunk', uploadId: 'up-1', offset: 0, data: uint8ArrayToBase64(oversized) });
    await flush();

    expect(fileSource.writeUploadChunk).not.toHaveBeenCalled();
    expect(fileSource.abortUpload).toHaveBeenCalledWith('up-1');
    expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'file-upload-ack', uploadId: 'up-1', ok: false }));
  });

  it('rejects a chunk for an unowned uploadId without reaching the file source', async () => {
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

    expect(fileSource.writeUploadChunk).not.toHaveBeenCalled();
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
    await flush();

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
    expect(openclawSource.controlListenerCount).toBe(1);

    openclawSource.emitStatus({ state: 'running', port: 18789 });
    expect(ws.sent).toContainEqual({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    const control: OpenClawControlSnapshot = {
      schemaVersion: 1,
      intentId: 'intent-1',
      generation: 1,
      status: { state: 'stopped', port: 18789 },
      desiredState: 'running',
      supervisorState: 'ready',
      operation: null,
      issue: null,
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    openclawSource.emitControl(control);
    expect(ws.sent).toContainEqual({ kind: 'openclaw-control', control });
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
    expect(openclawSource.controlListenerCount).toBe(0);
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
    openclawSource.runLifecycle.mockResolvedValueOnce({
      accepted: false,
      issue: {
        code: 'gateway-unhealthy',
        detail: 'boom',
        remediation: 'retry',
        diagnosticId: 'diag-1',
      },
    });
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'restart' });
    await flush();

    expect(openclawSource.runLifecycle).toHaveBeenCalledWith('restart');
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-lifecycle-result',
      requestId: 'r1',
      result: {
        accepted: false,
        issue: {
          code: 'gateway-unhealthy',
          detail: 'boom',
          remediation: 'retry',
          diagnosticId: 'diag-1',
        },
      },
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
      result: {
        accepted: false,
        issue: {
          code: 'supervisor-failed',
          detail: 'boom',
          remediation: 'Retry the requested OpenClaw action.',
          diagnosticId: expect.stringMatching(/^remote-/u),
        },
      },
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

  it('openclaw-chat-ticket preserves a typed failure reason when no ticket could be minted', async () => {
    const openclawSource = new FakeOpenClawSource();
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
      reason: 'proxy-unavailable',
    });
  });

  it('bounds a chat-ticket source that never settles and replies with timeout', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.mintChatTicket.mockImplementationOnce(() => new Promise(() => undefined));
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    vi.useFakeTimers();

    ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'timeout-ticket' });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(ws.sent).toContainEqual({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'timeout-ticket',
      ticket: null,
      proxyPort: 0,
      token: null,
      reason: 'timeout',
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

  it('desktop visibility does not gate remote OpenClaw subscriptions', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);
    ws.sent.length = 0;

    ws.clientSend({ kind: 'openclaw-status-subscribe' });
    ws.clientSend({ kind: 'openclaw-logs-subscribe' });

    expect(openclawSource.statusListenerCount).toBe(1);
    expect(openclawSource.logListenerCount).toBe(1);
    expect(ws.sent).toHaveLength(0);
  });

  it('desktop visibility does not gate remote OpenClaw request/reply operations', async () => {
    const openclawSource = new FakeOpenClawSource();
    openclawSource.visible = false;
    openclawSource.runLifecycle.mockResolvedValueOnce({ accepted: true });
    openclawSource.listAgentSessions.mockResolvedValueOnce([{ key: 'k1', sessionId: 's1' }]);
    openclawSource.getCoreConfig.mockResolvedValueOnce({
      'agents.defaults.model': 'openai/gpt-5.5',
      'gateway.port': '18789',
    });
    openclawSource.setCoreConfig.mockResolvedValueOnce({ ok: true, restartRequired: true });
    openclawSource.mintChatTicket.mockResolvedValueOnce({ ticket: 'ticket-1', proxyPort: 7421, token: 'token-1' });
    const ws = new FakeWs();
    const { options } = makeOptions({ openclawSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'openclaw-lifecycle', requestId: 'r1', action: 'start' });
    ws.clientSend({ kind: 'openclaw-sessions-get', requestId: 'r2' });
    ws.clientSend({ kind: 'openclaw-config-get', requestId: 'r3' });
    ws.clientSend({ kind: 'openclaw-config-set', requestId: 'r4', key: 'agents.defaults.model', value: 'x' });
    ws.clientSend({ kind: 'openclaw-chat-ticket', requestId: 'r5' });
    await flush();

    expect(openclawSource.runLifecycle).toHaveBeenCalledWith('start');
    expect(openclawSource.listAgentSessions).toHaveBeenCalledOnce();
    expect(openclawSource.getCoreConfig).toHaveBeenCalledOnce();
    expect(openclawSource.setCoreConfig).toHaveBeenCalledWith('agents.defaults.model', 'x');
    expect(openclawSource.mintChatTicket).toHaveBeenCalledOnce();
    expect(ws.sent).toContainEqual({ kind: 'openclaw-lifecycle-result', requestId: 'r1', result: { accepted: true } });
    expect(ws.sent).toContainEqual({ kind: 'openclaw-sessions-reply', requestId: 'r2', sessions: [{ key: 'k1', sessionId: 's1' }] });
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-reply',
      requestId: 'r3',
      config: { 'agents.defaults.model': 'openai/gpt-5.5', 'gateway.port': '18789' },
    });
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-config-set-reply',
      requestId: 'r4',
      result: { ok: true, restartRequired: true },
    });
    expect(ws.sent).toContainEqual({
      kind: 'openclaw-chat-ticket-reply',
      requestId: 'r5',
      ticket: 'ticket-1',
      proxyPort: 7421,
      token: 'token-1',
    });
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
      state: 'done' as const,
      status: 'done' as const,
      stateSeq: 1,
      live: true,
      interactiveReady: true,
      stateSource: 'provider-hook' as const,
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
    await flush();
    expect(agentSource.sendFollowup).toHaveBeenCalledWith('activity-1', 'continue');
    expect(ws.sent).toContainEqual({ kind: 'agent-followup-reply', requestId: 'follow-1', result: { ok: true } });

    ws.clientSend({
      kind: 'agent-decision',
      requestId: 'decision-1',
      activityId: 'activity-1',
      approvalId: 'approval-1',
      decision: 'allow',
    });
    expect(agentSource.decideApproval).toHaveBeenCalledWith('activity-1', 'approval-1', 'allow');
    expect(ws.sent).toContainEqual({
      kind: 'agent-decision-reply',
      requestId: 'decision-1',
      result: { ok: true },
    });

    ws.close();
    expect(agentSource.listenerCount).toBe(0);
  });
});

describe('RemoteBridge — Agent coordination v8', () => {
  it('pushes bounded coordination state, marks seen, and keeps validation output off the wire', async () => {
    const mergeRequest: ManagedMergeRequest = {
      requestId: 'merge-1',
      revision: 4,
      projectId: 'project-1',
      participantId: 'participant-1',
      activityId: 'activity-1',
      sourceWorkspaceId: 'workspace-1',
      sourceBranch: 'agent/feature',
      sourceHead: '1'.repeat(40),
      targetBranch: 'main',
      targetHead: '2'.repeat(40),
      candidateHead: '3'.repeat(40),
      state: 'approval-required',
      validationConfigRevision: 2,
      validations: [{
        id: 'unit',
        name: 'Unit tests',
        status: 'passed',
        exitCode: 0,
        outputTail: 'SECRET VALIDATION OUTPUT',
      }],
      createdAt: 10,
      updatedAt: 20,
      expiresAt: 30,
    };
    const source = new FakeAgentCoordinationSource(mergeRequest);
    const ws = new FakeWs();
    const { options } = makeOptions({ agentCoordinationSource: source });
    await authed(ws, options);

    const initial = ws.sent.find((message) => message.kind === 'agent-coordination-snapshot');
    expect(initial).toBeDefined();
    expect(JSON.stringify(initial)).not.toContain('SECRET VALIDATION OUTPUT');
    expect(source.listenerCount).toBe(1);

    ws.clientSend({ kind: 'agent-coordination-snapshot-get', requestId: 'coord-1' });
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'agent-coordination-snapshot',
      requestId: 'coord-1',
    }));
    const projectInput = {
      projectId: 'project-1',
      goal: 'Ship mobile parity',
      defaultTargetBranch: 'main',
      validationCommands: [{
        id: 'unit',
        name: 'Unit tests',
        command: 'pnpm test:unit',
        timeoutMs: 300_000,
      }],
      expectedRevision: 0,
    };
    ws.clientSend({
      kind: 'agent-coordination-project-save',
      requestId: 'project-save-1',
      input: projectInput,
    });
    await flush();
    expect(source.saveProject).toHaveBeenCalledWith(projectInput);
    expect(ws.sent).toContainEqual({
      kind: 'agent-coordination-project-save-reply',
      requestId: 'project-save-1',
      result: expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ projectId: 'project-1', configRevision: 1 }),
      }),
    });
    ws.clientSend({ kind: 'agent-seen', requestId: 'seen-1', activityId: 'activity-1', stateSeq: 4 });
    expect(source.markSeen).toHaveBeenCalledWith('activity-1', 4);
    expect(ws.sent).toContainEqual({ kind: 'agent-seen-reply', requestId: 'seen-1', marked: true });

    ws.clientSend({
      kind: 'managed-merge-decision',
      requestId: 'decision-1',
      mergeRequestId: 'merge-1',
      revision: 4,
      decision: 'approve',
      overrideReason: 'Reviewed on mobile.',
    });
    await flush();
    expect(source.decideManagedMerge).toHaveBeenCalledWith({
      requestId: 'merge-1',
      revision: 4,
      decision: 'approve',
      actor: 'mobile',
      overrideReason: 'Reviewed on mobile.',
    });
    const reply = ws.sent.find((message) => (
      message.kind === 'managed-merge-decision-reply' && message.requestId === 'decision-1'
    ));
    expect(reply).toMatchObject({ kind: 'managed-merge-decision-reply', result: { ok: true } });
    expect(JSON.stringify(reply)).not.toContain('SECRET VALIDATION OUTPUT');

    ws.clientSend({
      kind: 'managed-merge-decision',
      requestId: 'invalid-decision',
      mergeRequestId: 'merge-1',
      revision: 0,
      decision: 'approve',
    });
    expect(source.decideManagedMerge).toHaveBeenCalledTimes(1);
    ws.close();
    expect(source.listenerCount).toBe(0);
  });
});

describe('RemoteBridge — Lead orchestration v10', () => {
  it('pushes snapshots and correlates policy and worker actions', async () => {
    const source = new FakeAgentOrchestrationSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ agentOrchestrationSource: source });
    await authed(ws, options);

    expect(ws.sent).toContainEqual({
      kind: 'agent-orchestration-snapshot',
      snapshot: source.snapshot,
    });
    expect(source.listenerCount).toBe(1);

    source.emit({ ...source.snapshot, revision: 2 });
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'agent-orchestration-snapshot',
      snapshot: expect.objectContaining({ revision: 2 }),
    }));

    ws.clientSend({ kind: 'agent-orchestration-snapshot-get', requestId: 'orchestration-1' });
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'agent-orchestration-snapshot',
      requestId: 'orchestration-1',
      snapshot: expect.objectContaining({ revision: 2 }),
    }));

    const input = {
      projectId: 'project-1',
      enabled: true,
      permissionMode: 'ask' as const,
      allowedWorkerProfileIds: ['profile-1'],
      expectedRevision: 1,
    };
    ws.clientSend({ kind: 'agent-collaboration-policy-save', requestId: 'policy-1', input });
    await flush();
    expect(source.savePolicy).toHaveBeenCalledWith(input);
    expect(ws.sent).toContainEqual({
      kind: 'agent-collaboration-policy-save-reply',
      requestId: 'policy-1',
      result: { ok: true, value: source.policy },
    });

    ws.clientSend({
      kind: 'agent-orchestration-action',
      requestId: 'cancel-1',
      action: 'cancel-worker',
      runId: 'run-1',
      taskId: 'task-1',
    });
    ws.clientSend({
      kind: 'agent-orchestration-action',
      requestId: 'stop-1',
      action: 'stop-run',
      runId: 'run-1',
    });
    await flush();
    expect(source.cancelWorker).toHaveBeenCalledWith('run-1', 'task-1');
    expect(source.stopRun).toHaveBeenCalledWith('run-1');

    ws.clientSend({ kind: 'agent-legacy-migration-confirm', requestId: 'migration-1' });
    await flush();
    expect(source.confirmLegacyMigration).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual({
      kind: 'agent-legacy-migration-confirm-reply',
      requestId: 'migration-1',
      result: {
        ok: true,
        value: { required: false, catalogItemCount: 0, runCount: 0, confirmedAt: 10 },
      },
    });

    ws.clientSend({
      kind: 'agent-orchestration-action',
      requestId: 'invalid-1',
      action: 'archive-worker',
      runId: 'run-1',
    });
    expect(source.archiveWorker).not.toHaveBeenCalled();

    ws.close();
    expect(source.listenerCount).toBe(0);
  });
});

describe('RemoteBridge — Agent history v4', () => {
  it('correlates on-demand history reads and keeps the provider id out of the wire', async () => {
    const project = {
      projectId: 'project-1',
      name: 'Workspace',
      primaryRoot: 'C:\\workspace',
      additionalRoots: ['C:\\shared'],
      pinned: true,
      saved: true,
      sessionCount: 1,
      providers: ['codex' as const],
      lastActiveAt: 20,
    };
    const session = {
      historyId: 'codex_0123456789abcdef01234567',
      projectId: project.projectId,
      provider: 'codex' as const,
      title: 'Previous task',
      preview: 'preview',
      createdAt: 10,
      updatedAt: 20,
      roots: [project.primaryRoot, ...project.additionalRoots],
      source: 'cli',
    };
    const preparation = {
      historyId: session.historyId,
      provider: 'codex' as const,
      recordedRoots: session.roots,
      currentRoots: session.roots,
      rootsMatch: true,
      missingRecordedRoots: [],
      missingCurrentRoots: [],
      canResume: true,
      revision: 'revision-1',
    };
    const historySource: RemoteAgentHistorySource = {
      listProjects: vi.fn(async () => ({ items: [project], nextCursor: null })),
      listSessions: vi.fn(async () => ({ items: [session], nextCursor: null })),
      readTranscript: vi.fn(async () => ({
        historyId: session.historyId,
        provider: 'codex' as const,
        turns: [{
          id: 'turn-1',
          status: 'completed',
          entries: [{
            type: 'message' as const,
            id: 'message-1',
            role: 'user' as const,
            markdown: 'hello',
          }],
        }],
        nextCursor: null,
      })),
      prepareResume: vi.fn(async () => preparation),
      resolveResume: vi.fn(async () => ({
        ok: true as const,
        roots: session.roots,
        commandText: '!codex --cd \'C:\\workspace\' resume \'provider-private-thread-id\'',
        displayCommandText: 'codex resume',
      })),
      recordLaunchTargetWork: vi.fn(async () => undefined),
      recordResumeWork: vi.fn(async () => undefined),
    };
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions({ agentHistorySource: historySource });
    await authed(ws, options);
    const creating = broker.createSession(project.primaryRoot);
    const createRequest = interpreter.posted.find((entry) => entry.message.type === 'create-session')?.message;
    if (createRequest?.type !== 'create-session') throw new Error('missing rooted session request');
    interpreter.emit({
      type: 'session-created',
      requestId: createRequest.requestId,
      sessionId: 'terminal-1',
      cwd: project.primaryRoot,
    });
    await creating;

    ws.clientSend({ kind: 'agent-projects-list', requestId: 'projects-1', force: true });
    ws.clientSend({
      kind: 'agent-history-sessions',
      requestId: 'sessions-1',
      projectId: project.projectId,
    });
    ws.clientSend({
      kind: 'agent-history-read',
      requestId: 'read-1',
      historyId: session.historyId,
    });
    ws.clientSend({
      kind: 'agent-history-prepare-resume',
      requestId: 'prepare-1',
      historyId: session.historyId,
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'agent-projects-list-reply',
      requestId: 'projects-1',
      result: { items: [project], nextCursor: null },
    });
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'agent-history-sessions-reply',
      requestId: 'sessions-1',
      result: { items: [session], nextCursor: null },
    }));
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'agent-history-read-reply',
      requestId: 'read-1',
    }));
    expect(ws.sent).toContainEqual({
      kind: 'agent-history-prepare-resume-reply',
      requestId: 'prepare-1',
      result: preparation,
    });

    ws.clientSend({
      kind: 'agent-history-start-resume',
      requestId: 'resume-1',
      request: {
        historyId: session.historyId,
        sessionId: 'terminal-1',
        runId: 'run-1',
        rootChoice: 'recorded',
        revision: preparation.revision,
      },
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'agent-history-start-resume-reply',
      requestId: 'resume-1',
      result: { ok: true },
    });
    const run = interpreter.posted.find((entry) => entry.message.type === 'run')?.message;
    expect(run).toMatchObject({
      type: 'run',
      sessionId: 'terminal-1',
      runId: 'run-1',
      displayCommandText: 'codex resume',
      requestOrigin: 'mobile',
    });
    expect(run?.type === 'run' && run.commandText).toContain('provider-private-thread-id');
    expect(JSON.stringify(ws.sent)).not.toContain('provider-private-thread-id');
    expect(historySource.recordResumeWork)
      .toHaveBeenCalledWith(session.historyId, expect.any(Number));
  });

  it('dispatches a Claude resume with the provider label and no session id on the wire', async () => {
    const historySource: RemoteAgentHistorySource = {
      listProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listSessions: vi.fn(async () => ({ items: [], nextCursor: null })),
      readTranscript: vi.fn(async () => null),
      prepareResume: vi.fn(async () => null),
      resolveResume: vi.fn(async () => ({
        ok: true as const,
        roots: ['C:\\workspace'],
        commandText: '!claude --resume \'9f2c1b74-1111-4222-8333-444455556666\'',
        displayCommandText: 'claude resume',
      })),
      recordLaunchTargetWork: vi.fn(async () => undefined),
      recordResumeWork: vi.fn(async () => undefined),
    };
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions({ agentHistorySource: historySource });
    await authed(ws, options);
    const creating = broker.createSession('C:\\workspace');
    const createRequest = interpreter.posted.find((entry) => entry.message.type === 'create-session')?.message;
    if (createRequest?.type !== 'create-session') throw new Error('missing rooted session request');
    interpreter.emit({
      type: 'session-created',
      requestId: createRequest.requestId,
      sessionId: 'terminal-1',
      cwd: 'C:\\workspace',
    });
    await creating;

    ws.clientSend({
      kind: 'agent-history-start-resume',
      requestId: 'claude-resume-1',
      request: {
        historyId: 'claude_0123456789abcdef01234567',
        sessionId: 'terminal-1',
        runId: 'run-1',
        rootChoice: 'recorded',
        revision: 'revision-1',
      },
    });
    await flush();

    const run = interpreter.posted.find((entry) => entry.message.type === 'run')?.message;
    expect(run).toMatchObject({
      type: 'run',
      displayCommandText: 'claude resume',
      requestOrigin: 'mobile',
    });
    expect(run?.type === 'run' && run.commandText)
      .toContain('9f2c1b74-1111-4222-8333-444455556666');
    expect(JSON.stringify(ws.sent)).not.toContain('9f2c1b74-1111-4222-8333-444455556666');
    // Resume recency is tied to the opaque history owner, so a removed Project
    // cannot be re-imported from roots observed after its deletion.
    expect(historySource.recordResumeWork)
      .toHaveBeenCalledWith('claude_0123456789abcdef01234567', expect.any(Number));
  });
});

describe('RemoteBridge — Agent projects v5', () => {
  it('correlates CRUD/catalog/search and installs a private new-chat run only at the primary root', async () => {
    const project = {
      projectId: 'project-1',
      name: 'Workspace',
      primaryRoot: 'C:\\workspace',
      additionalRoots: ['C:\\shared'],
      pinned: true,
      saved: true,
      sessionCount: 0,
      providers: [] as const,
      lastActiveAt: 20,
    };
    const launcher = {
      launcherId: 'codex',
      provider: 'codex' as const,
      name: 'Codex',
      supportsAdditionalRoots: true,
    };
    const preparation = {
      ok: true as const,
      target: { kind: 'project' as const, projectId: project.projectId },
      launcherId: launcher.launcherId,
      provider: launcher.provider,
      name: launcher.name,
      cwd: project.primaryRoot,
      roots: [project.primaryRoot, ...project.additionalRoots],
      ignoredAdditionalRootCount: 0,
      revision: 'launch-revision-1',
    };
    const historySource: RemoteAgentHistorySource = {
      listProjects: vi.fn(async () => ({ items: [project], nextCursor: null })),
      saveProject: vi.fn(async () => ({ ok: true as const, project })),
      removeProject: vi.fn(async () => true),
      listLaunchers: vi.fn(() => [launcher]),
      prepareLaunch: vi.fn(async () => preparation),
      resolveLaunch: vi.fn(async () => ({
        ok: true as const,
        roots: preparation.roots,
        commandText: "!codex --cd 'C:\\\\workspace' --private-launch-secret",
        displayCommandText: 'codex',
      })),
      listSessions: vi.fn(async () => ({ items: [], nextCursor: null })),
      readTranscript: vi.fn(async () => null),
      prepareResume: vi.fn(async () => null),
      resolveResume: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
      recordLaunchTargetWork: vi.fn(async () => undefined),
      recordResumeWork: vi.fn(async () => undefined),
    };
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions({ agentHistorySource: historySource });
    await authed(ws, options);

    ws.clientSend({
      kind: 'agent-projects-list',
      requestId: 'projects-query',
      force: false,
      query: 'work',
      limit: 40,
    });
    ws.clientSend({
      kind: 'agent-project-save',
      requestId: 'project-save',
      input: {
        projectId: project.projectId,
        name: project.name,
        primaryRoot: project.primaryRoot,
        additionalRoots: project.additionalRoots,
        pinned: project.pinned,
      },
    });
    ws.clientSend({
      kind: 'agent-project-remove',
      requestId: 'project-remove',
      projectId: project.projectId,
    });
    ws.clientSend({ kind: 'agent-project-launchers', requestId: 'launchers' });
    ws.clientSend({
      kind: 'agent-project-prepare-launch',
      requestId: 'prepare-launch',
      projectId: project.projectId,
      launcherId: launcher.launcherId,
    });
    await flush();

    expect(historySource.listProjects).toHaveBeenCalledWith(false, undefined, 40, 'work');
    expect(ws.sent).toContainEqual({
      kind: 'agent-project-save-reply',
      requestId: 'project-save',
      result: { ok: true, project },
    });
    expect(ws.sent).toContainEqual({
      kind: 'agent-project-remove-reply',
      requestId: 'project-remove',
      removed: true,
    });
    expect(ws.sent).toContainEqual({
      kind: 'agent-project-launchers-reply',
      requestId: 'launchers',
      result: [launcher],
    });
    expect(ws.sent).toContainEqual({
      kind: 'agent-project-prepare-launch-reply',
      requestId: 'prepare-launch',
      result: {
        ok: true,
        projectId: project.projectId,
        launcherId: launcher.launcherId,
        provider: launcher.provider,
        name: launcher.name,
        cwd: project.primaryRoot,
        roots: preparation.roots,
        revision: preparation.revision,
      },
    });

    const creating = broker.createSession(project.primaryRoot);
    const createRequest = [...interpreter.posted]
      .reverse()
      .find((entry) => entry.message.type === 'create-session')?.message;
    if (createRequest?.type !== 'create-session') throw new Error('missing rooted session request');
    interpreter.emit({
      type: 'session-created',
      requestId: createRequest.requestId,
      sessionId: 'project-terminal',
      cwd: project.primaryRoot,
    });
    await creating;

    ws.clientSend({
      kind: 'agent-project-start-launch',
      requestId: 'start-launch',
      request: {
        projectId: project.projectId,
        launcherId: launcher.launcherId,
        sessionId: 'project-terminal',
        runId: 'project-run',
        revision: preparation.revision,
      },
    });
    await flush();

    expect(ws.sent).toContainEqual({
      kind: 'agent-project-start-launch-reply',
      requestId: 'start-launch',
      result: { ok: true },
    });
    const run = interpreter.posted.find((entry) => (
      entry.message.type === 'run' && entry.message.runId === 'project-run'
    ))?.message;
    expect(run).toMatchObject({
      type: 'run',
      sessionId: 'project-terminal',
      displayCommandText: 'codex',
      requestOrigin: 'mobile',
    });
    expect(run?.type === 'run' && run.commandText).toContain('--private-launch-secret');
    expect(JSON.stringify(ws.sent)).not.toContain('--private-launch-secret');
    expect(historySource.recordLaunchTargetWork)
      .toHaveBeenCalledWith(preparation.target, preparation.roots, expect.any(Number));

    ws.clientSend({
      kind: 'agent-project-start-launch',
      requestId: 'start-mismatch',
      request: {
        projectId: project.projectId,
        launcherId: launcher.launcherId,
        sessionId: 'missing-terminal',
        runId: 'mismatch-run',
        revision: preparation.revision,
      },
    });
    await flush();
    expect(ws.sent).toContainEqual({
      kind: 'agent-project-start-launch-reply',
      requestId: 'start-mismatch',
      result: { ok: false, reason: 'session-mismatch' },
    });
    expect(interpreter.posted.some((entry) => (
      entry.message.type === 'run' && entry.message.runId === 'mismatch-run'
    ))).toBe(false);
  });

  it('prepares and starts a v6 direct-directory launch without exposing its private command', async () => {
    const target = { kind: 'directory' as const, directory: 'C:\\direct-work' };
    const preparation = {
      ok: true as const,
      target,
      launcherId: 'claude',
      provider: 'claude' as const,
      name: 'Claude Code',
      cwd: target.directory,
      roots: [target.directory],
      ignoredAdditionalRootCount: 0,
      revision: 'direct-revision-1',
    };
    const historySource = {
      prepareLaunch: vi.fn(async () => preparation),
      resolveLaunch: vi.fn(async () => ({
        ok: true as const,
        roots: preparation.roots,
        commandText: '!claude --private-direct-secret',
        displayCommandText: 'claude',
      })),
      recordLaunchTargetWork: vi.fn(async () => undefined),
    } as unknown as RemoteAgentHistorySource;
    const ws = new FakeWs();
    const { options, interpreter, broker } = makeOptions({ agentHistorySource: historySource });
    await authed(ws, options);

    ws.clientSend({
      kind: 'agent-launch-prepare',
      requestId: 'direct-prepare',
      target,
      launcherId: preparation.launcherId,
    });
    await flush();
    expect(historySource.prepareLaunch).toHaveBeenCalledWith(target, preparation.launcherId);
    expect(ws.sent).toContainEqual({
      kind: 'agent-launch-prepare-reply',
      requestId: 'direct-prepare',
      result: preparation,
    });

    const creating = broker.createSession(target.directory);
    const createRequest = [...interpreter.posted]
      .reverse()
      .find((entry) => entry.message.type === 'create-session')?.message;
    if (createRequest?.type !== 'create-session') throw new Error('missing direct session request');
    interpreter.emit({
      type: 'session-created',
      requestId: createRequest.requestId,
      sessionId: 'direct-terminal',
      cwd: target.directory,
    });
    await creating;

    ws.clientSend({
      kind: 'agent-launch-start',
      requestId: 'direct-start',
      request: {
        target,
        launcherId: preparation.launcherId,
        sessionId: 'direct-terminal',
        runId: 'direct-run',
        revision: preparation.revision,
      },
    });
    await flush();

    expect(historySource.resolveLaunch)
      .toHaveBeenCalledWith(target, preparation.launcherId, preparation.revision);
    expect(ws.sent).toContainEqual({
      kind: 'agent-launch-start-reply',
      requestId: 'direct-start',
      result: { ok: true },
    });
    const run = interpreter.posted.find((entry) => (
      entry.message.type === 'run' && entry.message.runId === 'direct-run'
    ))?.message;
    expect(run).toMatchObject({
      type: 'run',
      sessionId: 'direct-terminal',
      displayCommandText: 'claude',
      requestOrigin: 'mobile',
    });
    expect(run?.type === 'run' && run.commandText).toContain('--private-direct-secret');
    expect(JSON.stringify(ws.sent)).not.toContain('--private-direct-secret');
    expect(historySource.recordLaunchTargetWork)
      .toHaveBeenCalledWith(target, preparation.roots, expect.any(Number));
  });

});

describe('RemoteBridge - correlated latency probe', () => {
  it('echoes a bounded probe id and ignores malformed probes', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'ping', probeId: 'probe-1', sentAt: 123 });
    ws.clientSend({ kind: 'ping', sentAt: 124 });
    ws.clientSend({ kind: 'ping', probeId: 'x'.repeat(129), sentAt: 125 });

    expect(ws.sent.filter((message) => message.kind === 'pong')).toEqual([
      { kind: 'pong', probeId: 'probe-1', sentAt: 123 },
    ]);
  });
});

describe('RemoteBridge - bounded Git request ownership', () => {
  it('keeps distinct concurrent status requests alive and correlates every reply', async () => {
    const pending: Array<{
      readonly signal: AbortSignal | undefined;
      readonly resolve: (status: import('../shared/git-status').GitDirectoryStatus) => void;
    }> = [];
    const gitSource = {
      getStatus: vi.fn((_directory: string, signal?: AbortSignal) => (
        new Promise<import('../shared/git-status').GitDirectoryStatus>((resolve) => {
          pending.push({ signal, resolve });
        })
      )),
      getDiff: vi.fn(async () => ({ ok: false as const, error: 'git-failed' as const })),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ gitSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'git-status', requestId: 'status-1', directory: '/old' });
    ws.clientSend({ kind: 'git-status', requestId: 'status-2', directory: '/new' });
    expect(pending).toHaveLength(2);
    expect(pending[0].signal?.aborted).toBe(false);
    expect(pending[1].signal?.aborted).toBe(false);

    pending[0].resolve({
      availability: 'ready',
      tracked: true,
      branch: 'old',
      changes: [],
      truncated: false,
    });
    await flush();
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'git-status-reply',
      requestId: 'status-1',
      status: expect.objectContaining({ branch: 'old' }),
    }));

    pending[1].resolve({
      availability: 'ready',
      tracked: true,
      branch: 'new',
      changes: [],
      truncated: false,
    });
    await flush();
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'git-status-reply',
      requestId: 'status-2',
      status: expect.objectContaining({ branch: 'new' }),
    }));
  });

  it('bounds concurrent Git work and fails the excess request closed', async () => {
    const pending: AbortSignal[] = [];
    const gitSource = {
      getStatus: vi.fn((_directory: string, signal?: AbortSignal) => (
        new Promise<import('../shared/git-status').GitDirectoryStatus>(() => {
          if (signal) pending.push(signal);
        })
      )),
      getDiff: vi.fn(async () => ({ ok: false as const, error: 'git-failed' as const })),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ gitSource });
    await authed(ws, options);

    for (let index = 0; index < 17; index += 1) {
      ws.clientSend({
        kind: 'git-status',
        requestId: `status-${index}`,
        directory: `/repo-${index}`,
      });
    }

    expect(gitSource.getStatus).toHaveBeenCalledTimes(16);
    expect(pending).toHaveLength(16);
    expect(ws.sent).toContainEqual({
      kind: 'git-status-reply',
      requestId: 'status-16',
      status: expect.objectContaining({ availability: 'unavailable', tracked: false }),
    });

    ws.close();
    expect(pending.every((signal) => signal.aborted)).toBe(true);
  });

  it('fails a cross-family duplicate id without orphaning the original request', async () => {
    let resolveStatus!: (
      status: import('../shared/git-status').GitDirectoryStatus,
    ) => void;
    const gitSource = {
      getStatus: vi.fn(() => (
        new Promise<import('../shared/git-status').GitDirectoryStatus>((resolve) => {
          resolveStatus = resolve;
        })
      )),
      getDiff: vi.fn(async () => ({ ok: true as const, text: '', truncated: false, omissions: [] })),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ gitSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'git-status', requestId: 'shared-id', directory: '/repo' });
    ws.clientSend({ kind: 'git-diff', requestId: 'shared-id', directory: '/repo' });
    expect(gitSource.getDiff).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      kind: 'git-diff-reply',
      requestId: 'shared-id',
      result: { ok: false, error: 'git-failed' },
    });

    resolveStatus({
      availability: 'ready',
      tracked: true,
      branch: 'main',
      changes: [],
      truncated: false,
    });
    await flush();
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'git-status-reply',
      requestId: 'shared-id',
      status: expect.objectContaining({ branch: 'main' }),
    }));
  });

  it('rejects oversized Git request ids and directories before the service', async () => {
    const gitSource = {
      getStatus: vi.fn(async () => EMPTY_GIT_DIRECTORY_STATUS),
      getDiff: vi.fn(async () => ({ ok: false as const, error: 'git-failed' as const })),
    };
    const ws = new FakeWs();
    const { options } = makeOptions({ gitSource });
    await authed(ws, options);

    ws.clientSend({ kind: 'git-status', requestId: 'x'.repeat(129), directory: '/repo' });
    ws.clientSend({ kind: 'git-diff', requestId: 'diff-1', directory: `/${'x'.repeat(8_192)}` });

    expect(gitSource.getStatus).not.toHaveBeenCalled();
    expect(gitSource.getDiff).not.toHaveBeenCalled();
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

    expect(ws.sent).toContainEqual({
      kind: 'auth-ok',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      capabilities: ['quick-commands-read'],
    });

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

    expect(ws.sent).toContainEqual({
      kind: 'auth-ok',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
    });
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

  function waitForRealMessage(
    client: RealWebSocket,
    kind: ServerToClientMessage['kind'],
  ): Promise<ServerToClientMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('message', onMessage);
        reject(new Error(`timed out waiting for ${kind}`));
      }, 2_000);
      const onMessage = (data: Parameters<Parameters<RealWebSocket['on']>[1]>[0]): void => {
        let parsed: ServerToClientMessage;
        try {
          parsed = JSON.parse(data.toString()) as ServerToClientMessage;
        } catch {
          return;
        }
        if (parsed.kind !== kind) return;
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(parsed);
      };
      client.on('message', onMessage);
    });
  }

  it('returns a promise that settles only after the listener is accepting connections', async () => {
    const { options } = makeOptions({ port: TEST_PORT });
    const started = startRemoteBridge(options);
    const isPromise = started instanceof Promise;
    const handle = await started;
    const client = await connect(TEST_PORT);

    client.close();
    await handle.stop();
    expect(isPromise).toBe(true);
  });

  it('rejects with EADDRINUSE and leaves no false-positive handle when bind fails', async () => {
    const { options } = makeOptions({ port: TEST_PORT });
    const owner = await startRemoteBridge(options);
    let contender: Awaited<ReturnType<typeof startRemoteBridge>> | undefined;
    let bindError: unknown;

    try {
      contender = await startRemoteBridge(options);
    } catch (error) {
      bindError = error;
    }

    expect(bindError).toMatchObject({ code: 'EADDRINUSE' });
    await contender?.stop();
    await owner.stop();
  });

  it('stop() terminates connected clients (their close fires) and releases the port for an immediate same-port restart', async () => {
    const { options } = makeOptions({ port: TEST_PORT });
    const handle = await startRemoteBridge(options);
    const client = await connect(TEST_PORT);

    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await handle.stop();
    await clientClosed; // wss's per-client ws.terminate() fired the client's own close

    // Immediate restart on the SAME port must not throw EADDRINUSE: stop()
    // only resolves once wss.close's callback fires, guaranteeing the
    // previous listening socket is released first.
    const handle2 = await startRemoteBridge(options);
    const client2 = await connect(TEST_PORT);
    client2.close();
    await handle2.stop();
  }, 10_000);

  it('stop() waits for active aborts and a begin that resolves after connection close', async () => {
    type BeginResult = Awaited<ReturnType<RemoteFileSource['beginUpload']>>;
    let resolveLateBegin!: (result: BeginResult) => void;
    const lateBegin = new Promise<BeginResult>((resolve) => {
      resolveLateBegin = resolve;
    });
    const beginUpload = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        uploadId: 'stop-active-upload',
        finalName: 'active.bin',
      })
      .mockImplementationOnce(() => lateBegin);
    let releaseAborts!: () => void;
    const abortGate = new Promise<void>((resolve) => {
      releaseAborts = resolve;
    });
    const abortUpload = vi.fn(() => abortGate);
    const fileSource = makeFileSource({ beginUpload, abortUpload });
    const { options } = makeOptions({ port: TEST_PORT, fileSource });
    const handle = await startRemoteBridge(options);
    const client = await connect(TEST_PORT);
    let stopPromise: Promise<void> | undefined;

    try {
      const authReply = waitForRealMessage(client, 'auth-ok');
      client.send(JSON.stringify(authMessage()));
      await authReply;

      const activeReply = waitForRealMessage(client, 'file-upload-begin-reply');
      client.send(JSON.stringify({
        kind: 'file-upload-begin',
        requestId: 'stop-active-begin',
        dirPath: 'C:\\x',
        name: 'active.bin',
        size: 0,
      }));
      await activeReply;
      client.send(JSON.stringify({
        kind: 'file-upload-begin',
        requestId: 'stop-late-begin',
        dirPath: 'C:\\x',
        name: 'late.bin',
        size: 0,
      }));
      await vi.waitFor(() => {
        expect(beginUpload).toHaveBeenCalledTimes(2);
      });

      let stopSettled = false;
      stopPromise = handle.stop().then(() => {
        stopSettled = true;
      });
      await vi.waitFor(() => {
        expect(abortUpload).toHaveBeenCalledWith('stop-active-upload');
      });
      await flush();
      expect(stopSettled).toBe(false);

      resolveLateBegin({
        ok: true,
        uploadId: 'stop-late-upload',
        finalName: 'late.bin',
      });
      await vi.waitFor(() => {
        expect(abortUpload).toHaveBeenCalledWith('stop-late-upload');
      });
      await flush();
      expect(stopSettled).toBe(false);

      releaseAborts();
      await stopPromise;
      expect(stopSettled).toBe(true);
    } finally {
      resolveLateBegin({
        ok: false,
        error: 'test cleanup',
      });
      releaseAborts();
      client.terminate();
      await (stopPromise ?? handle.stop());
    }
  }, 10_000);

  it('stop() preserves initiator identities for later bridge generations (run lifetime, not bridge lifetime)', async () => {
    const { options } = makeOptions({ port: TEST_PORT });
    // Same registry shape production memoizes per broker: identity must have
    // the RUN's lifetime (registry doc), so a remote toggle off/on cannot
    // demote an install's own still-active run to viewing-only on resume.
    const initiators = new RemoteRunInitiatorRegistry(options.broker);
    initiators.remember('session-own', 'run-own', 'client-own');

    const handle = await startRemoteBridge({ ...options, runInitiators: initiators });
    await handle.stop();

    expect(initiators.isInitiatedBy('session-own', 'run-own', 'client-own')).toBe(true);
  }, 10_000);
});

describe('RemoteBridge — daemon protocol v12', () => {
  it('pushes the authoritative daemon snapshot after authentication', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ daemonSource: daemon.source });

    await authed(ws, options);

    expect(ws.sent).toContainEqual({ kind: 'daemon-snapshot', snapshot: daemonSnapshot() });
  });

  it('keeps authentication and legacy terminal transport alive when daemon authority is in safe mode', async () => {
    const daemon = makeDaemonSource();
    const getSnapshot = vi.fn(() => {
      throw new Error('database unavailable');
    });
    const ws = new FakeWs();
    const { options } = makeOptions({
      daemonSource: {
        ...daemon.source,
        getAvailability: () => ({
          state: 'legacy-only-safe-mode',
          initializationCode: 'database-corrupt',
          databaseDisposition: 'quarantined',
          supportedSchemaVersion: 3,
          currentSchemaVersion: 3,
          recoveryPath: 'C:\\private\\daemon-recovery',
        }),
        getSnapshot,
      },
    });

    await authed(ws, options);

    expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'auth-ok' }));
    expect(ws.sent).toContainEqual({
      kind: 'daemon-availability',
      availability: {
        state: 'legacy-only-safe-mode',
        initializationCode: 'database-corrupt',
        databaseDisposition: 'quarantined',
        supportedSchemaVersion: 3,
        currentSchemaVersion: 3,
      },
    });
    expect(ws.sent.some((message) => message.kind === 'auth-fail')).toBe(false);
    expect(ws.readyState).toBe(1);
    expect(getSnapshot).not.toHaveBeenCalled();

    ws.clientSend({ kind: 'daemon-snapshot-get', requestId: 'safe-snapshot' });
    expect(ws.sent).toContainEqual({
      kind: 'daemon-snapshot',
      requestId: 'safe-snapshot',
      snapshot: null,
      unavailable: true,
    });

    ws.clientSend({
      kind: 'daemon-transcript-get',
      requestId: 'safe-transcript',
      sessionId: 'agent-1',
      afterSequence: 0,
      limit: 100,
    });
    expect(ws.sent).toContainEqual({
      kind: 'daemon-transcript',
      requestId: 'safe-transcript',
      sessionId: 'agent-1',
      items: [],
      unavailable: true,
    });

    const command = createDaemonCommand({
      commandId: 'safe-command',
      idempotencyKey: 'safe-command',
      expectedRevision: 0,
      issuedAt: '2026-09-04T10:00:01.000Z',
      principal: { kind: 'android', id: 'phone' },
      type: 'runtime.set-settings',
      payload: { browserEnabled: false },
    });
    ws.clientSend({ kind: 'daemon-command', requestId: 'safe-command-request', command });
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'daemon-command-reply',
      requestId: 'safe-command-request',
      receipt: expect.objectContaining({
        ok: false,
        status: 'rejected',
        commandId: 'safe-command',
        error: expect.objectContaining({ code: 'internal-error', retryable: false }),
      }),
    }));
    expect(daemon.execute).not.toHaveBeenCalled();
  });

  it('isolates an unexpected daemon snapshot failure from successful bearer authentication', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({
      daemonSource: {
        ...daemon.source,
        getAvailability: () => ({
          state: 'ready', supportedSchemaVersion: 3, currentSchemaVersion: 3,
        }),
        getSnapshot: () => { throw new Error('unexpected snapshot failure'); },
      },
    });

    await authed(ws, options);

    expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'auth-ok' }));
    expect(ws.sent).toContainEqual({
      kind: 'daemon-snapshot', snapshot: null, unavailable: true,
    });
    expect(ws.sent.some((message) => message.kind === 'auth-fail')).toBe(false);
    expect(ws.readyState).toBe(1);
  });

  it('returns a bounded semantic transcript page', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ daemonSource: daemon.source });
    await authed(ws, options);

    ws.clientSend({
      kind: 'daemon-transcript-get',
      requestId: 'transcript-request-1',
      sessionId: 'agent-1',
      afterSequence: 1,
      limit: 200,
    });

    expect(daemon.readTranscript).toHaveBeenCalledWith('agent-1', 1, 200);
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'daemon-transcript',
      requestId: 'transcript-request-1',
      sessionId: 'agent-1',
      items: [expect.objectContaining({ sequence: 2, text: 'Ready.' })],
    }));
  });

  it('replaces a wire-supplied principal with the authenticated Android identity', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ daemonSource: daemon.source });
    await authed(ws, options);
    const command = createDaemonCommand({
      commandId: 'mobile-command-1',
      idempotencyKey: 'mobile:command-1',
      expectedRevision: 3,
      issuedAt: '2026-09-04T10:00:01.000Z',
      principal: { kind: 'mcp', id: 'spoofed', sessionId: 'victim' },
      type: 'agent.submit',
      payload: { sessionId: 'agent-1', prompt: 'Continue.' },
    });

    ws.clientSend({ kind: 'daemon-command', requestId: 'request-1', command });
    await flush();

    expect(daemon.execute).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'mobile-command-1',
      principal: {
        kind: 'android',
        id: '00000000-0000-4000-8000-000000000001',
      },
    }));
    expect(ws.sent).toContainEqual(expect.objectContaining({
      kind: 'daemon-command-reply',
      requestId: 'request-1',
      receipt: expect.objectContaining({ ok: true, commandId: 'mobile-command-1' }),
    }));
  });

  it('streams subscribed events and repairs a cursor gap with a snapshot', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ daemonSource: daemon.source });
    await authed(ws, options);
    ws.sent.length = 0;

    ws.clientSend({ kind: 'daemon-events-subscribe', afterSequence: 2 });
    expect(ws.sent).toContainEqual({ kind: 'daemon-snapshot', snapshot: daemonSnapshot() });

    const event = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      eventId: 'event-6',
      sequence: 6,
      revision: 4,
      occurredAt: '2026-09-04T10:00:02.000Z',
      kind: 'entity.upserted',
      payload: { entityType: 'session', entityId: 'agent-1' },
    } satisfies DaemonEvent;
    daemon.emit(event);
    expect(ws.sent).toContainEqual({ kind: 'daemon-event', event });

    ws.clientSend({ kind: 'daemon-events-unsubscribe' });
    daemon.emit({ ...event, eventId: 'event-7', sequence: 7 });
    expect(ws.sent.filter((message) => message.kind === 'daemon-event')).toHaveLength(1);
  });

  it('releases its daemon event observer when the socket closes', async () => {
    const daemon = makeDaemonSource();
    const ws = new FakeWs();
    const { options } = makeOptions({ daemonSource: daemon.source });
    await authed(ws, options);

    ws.close();

    expect(daemon.unsubscribe).toHaveBeenCalledOnce();
  });
});
