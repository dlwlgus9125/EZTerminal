/**
 * RemoteBridge — WS multiplexer for the mobile remote-control bridge (M0).
 *
 * Reuses the SAME per-run MessagePort broker shape as `main.ts`'s
 * `run-command` IPC handler (a fresh port pair per run; one half transferred
 * to the interpreter, the other kept here): a WS connection stands in for the
 * renderer's side of that port, relaying `InterpreterFrame`/`RendererControl`
 * over the single multiplexed socket instead of a dedicated MessagePort.
 * `create-session`/`destroy-session`/`list-sessions` are handled the same way
 * main.ts's IPC handlers do (session-created round-trip correlated by a
 * bridge-minted `requestId`, distinct from the client's own `requestId`).
 *
 * Everything Electron-specific (the real `WebSocketServer`, the interpreter
 * `UtilityProcess`, real `MessageChannelMain`s) is injected — this module
 * never imports `electron`, so the connection-handling logic (`attachConnection`)
 * is unit-testable with fake ports/interpreter/WS objects.
 *
 * Auth: the FIRST message on a new connection must be `{kind:'auth', token}`
 * matching the persisted token — anything else (wrong kind, wrong token)
 * closes the socket immediately (WS close code 4001) and no other message is
 * processed before auth succeeds.
 *
 * `startRemoteBridge` also runs a ws ping/pong heartbeat sweep so a
 * half-open phone socket (app backgrounded/killed without a clean close)
 * doesn't keep a `statsSource`/packet-mirror acquire alive forever.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  MAX_GUARDED_DESTROY_RUN_IDS,
  type DestroySessionGuardResult,
  type InterpreterFrame,
  type PacketRow,
  type RendererControl,
  type RunAttachRejectReason,
  type SystemStatsSnapshot,
} from '../shared/ipc';
import {
  REMOTE_CAPABILITY_QUICK_COMMANDS_READ,
  REMOTE_PROTOCOL_VERSION,
  base64ToUint8Array,
  encodeFrame,
  uint8ArrayToBase64,
  type ClientToServerMessage,
  type OpenClawChatTicketFailureReason,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../shared/remote-protocol';
import {
  MAX_QUICK_COMMANDS,
  QuickCommandSchema,
  type QuickCommand,
} from '../shared/quick-command';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import type { FileReadStream } from './file-service';
import type { AgentActivitySnapshot, AgentFollowupResult } from '../shared/agent';
import {
  isWorktreeRequest,
  type WorktreeRequest,
  type WorktreeRequestOrigin,
  type WorktreeResult,
} from '../shared/worktree';
import type { InterpreterBroker, RemoteInterpreter, RemoteMessageChannel, RemotePort } from './interpreter-broker';
import { RemoteRunLeaseRegistry } from './remote-run-lease';
import { resolveTerminalFileLocation } from './terminal-path-resolver';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
import {
  OPENCLAW_CONFIG_ALLOWLIST,
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleResult,
  type OpenClawLogLine,
  type OpenClawSetConfigResult,
  type OpenClawStatus,
} from '../shared/openclaw';

/** Non-standard WS close code: auth was missing/wrong on this connection. */
export const AUTH_CLOSE_CODE = 4001;

/** Non-standard WS close code: desktop/mobile wire protocols are incompatible. */
export const PROTOCOL_CLOSE_CODE = 4002;

/** Default bridge port — overridable via `EZTERMINAL_REMOTE_PORT`. */
export const DEFAULT_REMOTE_BRIDGE_PORT = 7420;

/** Ping cadence + missed-pong tolerance for `startRemoteBridge`'s heartbeat sweep. */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED_PONGS = 2;

// ── Network hardening (public-repo security review) ─────────────────────────
/** Cap on a single inbound frame. The largest legitimate client frame is a
 * base64-encoded file-upload chunk (`FILE_CHUNK_BYTES * 2` raw ≈ 683 KiB of
 * base64); 1 MiB leaves headroom while stopping an unauthenticated client from
 * forcing `ws`'s 100 MiB default allocation on every frame (pre-auth DoS). */
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
/** Max concurrent connections — one phone plus a little slack. Beyond this the
 * server refuses new sockets (WS close 1013 "Try Again Later") so a socket
 * flood can't exhaust the main process. */
const MAX_REMOTE_CONNECTIONS = 64;
/** Opening and ready file reads both consume a per-connection slot. */
export const MAX_REMOTE_FILE_READS = 16;
/** Opening operations remain counted after socket close until the source
 * settles, preventing reconnect churn from accumulating slow filesystem work. */
export const MAX_REMOTE_PENDING_FILE_OPENS = 16;
/** A socket that hasn't authenticated within this window is terminated, so an
 * unauthenticated client can't sit holding a connection slot indefinitely
 * (which, with `MAX_REMOTE_CONNECTIONS`, would otherwise starve real clients). */
const AUTH_DEADLINE_MS = 10_000;
/** WebView/localhost origins allowed to open the bridge. The Capacitor Android
 * WebView presents `http://localhost` (capacitor.config.ts's `androidScheme`);
 * a real browser page presents its own site origin and is rejected — this is
 * the Cross-Site WebSocket Hijacking / DNS-rebinding defense. Non-browser
 * clients (the e2e Node `ws` client, curl) send no Origin header at all, which
 * is allowed: the token remains the real authentication gate. */
const ALLOWED_WS_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
]);

/** `verifyClient` predicate — allow no-Origin (non-browser) clients and the
 * known WebView origins; reject any explicit foreign browser origin. Exported
 * for unit testing (the real `verifyClient` wiring needs a live server). */
export function isRemoteOriginAllowed(origin: string | undefined): boolean {
  return !origin || ALLOWED_WS_ORIGINS.has(origin);
}

/** Constant-time token comparison. Length-checks first (so a length mismatch
 * never reaches `timingSafeEqual`, which throws on unequal-length buffers) and
 * then compares without an early-exit byte loop, so a network attacker learns
 * nothing about the token from response timing. Exported for unit testing. */
export function tokensMatch(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type UnknownRecord = Record<string, unknown>;
type WorktreeDispatchMessage = {
  readonly kind: 'worktree-request';
  readonly requestId: string;
  readonly request?: unknown;
};
type FileReadDispatchMessage = {
  readonly kind: 'file-read';
  readonly requestId?: unknown;
  readonly path?: unknown;
  readonly mode?: unknown;
  readonly terminalCapability?: unknown;
};
type RemoteFileReadRecord = {
  stream: FileReadStream | null;
  readonly abortController: AbortController;
  closed: boolean;
  inFlight: boolean;
  /** Cumulative byte offset required from the next ACK. `null` means no ACK
   * is currently admissible (opening, pulling, or terminal). */
  expectedAckOffset: number | null;
  nextOffset: number;
  sendBytes: number;
};
type DispatchableClientMessage =
  | Exclude<ClientToServerMessage, { readonly kind: 'worktree-request' | 'file-read' }>
  | WorktreeDispatchMessage
  | FileReadDispatchMessage;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

const MAX_GUARDED_DESTROY_ID_LENGTH = 256;

function isGuardedDestroyId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_GUARDED_DESTROY_ID_LENGTH
  );
}

function isGuardedDestroyRequest(value: UnknownRecord): boolean {
  if (
    !isGuardedDestroyId(value.requestId)
    || !isGuardedDestroyId(value.sessionId)
    || !Array.isArray(value.expectedActiveRunIds)
    || value.expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
  ) {
    return false;
  }
  const runIds = value.expectedActiveRunIds;
  return (
    runIds.every(isGuardedDestroyId)
    && new Set(runIds).size === runIds.length
  );
}

/** Runtime boundary for the nested control union. The bridge itself reads
 * `control.type`, while the interpreter reads the variant fields, so both the
 * discriminant and the minimum fields for that variant are checked here. */
function isRendererControl(value: unknown): value is RendererControl {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'cancel':
    case 'close':
    case 'pty-claim-control':
      return true;
    case 'requestRows':
    case 'setViewport':
      return isFiniteNumber(value.start) && isFiniteNumber(value.count);
    case 'pty-input':
      return typeof value.data === 'string';
    case 'pty-resize':
      return isFiniteNumber(value.cols) && isFiniteNumber(value.rows);
    case 'pty-ack':
      return isFiniteNumber(value.bytes);
    case 'ssh-prompt-response':
      return (
        typeof value.promptId === 'string' &&
        isOptionalString(value.value) &&
        (value.accept === undefined || typeof value.accept === 'boolean')
      );
    default:
      return false;
  }
}

function isTerminalFileLocationRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.cwd === 'string' &&
    (value.executionKind === 'local' || value.executionKind === 'ssh') &&
    isOptionalNumber(value.line) &&
    isOptionalNumber(value.column)
  );
}

/** Validate enough of every authenticated client envelope that the selected
 * switch arm can safely dereference its fields. Worktree and file-read keep
 * their existing arm-local validation/reply behavior, so only their safe
 * outer correlation shape is required here. */
function isDispatchableClientMessage(value: unknown): value is DispatchableClientMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'list-sessions':
    case 'list-runs':
    case 'release-runs':
    case 'stats-history':
    case 'packets-subscribe':
    case 'packets-unsubscribe':
    case 'openclaw-status-subscribe':
    case 'openclaw-status-unsubscribe':
    case 'openclaw-logs-subscribe':
    case 'openclaw-logs-unsubscribe':
      return true;
    case 'auth':
      return typeof value.token === 'string';
    case 'create-session':
      return typeof value.requestId === 'string' && isOptionalString(value.cwd);
    case 'destroy-session':
      return typeof value.sessionId === 'string';
    case 'destroy-session-guarded':
      return isGuardedDestroyRequest(value);
    case 'run-command':
      return (
        typeof value.runId === 'string' &&
        typeof value.sessionId === 'string' &&
        typeof value.commandText === 'string'
      );
    case 'control':
      return typeof value.runId === 'string' && isRendererControl(value.control);
    case 'attach-run':
      return typeof value.sessionId === 'string' && typeof value.runId === 'string';
    case 'resume-run':
      return (
        typeof value.sessionId === 'string' &&
        typeof value.runId === 'string' &&
        isFiniteNumber(value.generation)
      );
    case 'stats-visible':
      return typeof value.visible === 'boolean';
    case 'agent-snapshot-get':
      return typeof value.requestId === 'string';
    case 'agent-followup':
      return (
        typeof value.requestId === 'string' &&
        typeof value.activityId === 'string' &&
        typeof value.text === 'string'
      );
    case 'worktree-request':
      return typeof value.requestId === 'string';
    case 'file-list':
      return typeof value.requestId === 'string' && typeof value.path === 'string';
    case 'file-roots':
      return typeof value.requestId === 'string';
    case 'terminal-file-location':
      return typeof value.requestId === 'string' && isTerminalFileLocationRequest(value.request);
    case 'file-read':
      return true;
    case 'file-read-ack':
      return typeof value.requestId === 'string' && isFiniteNumber(value.offset);
    case 'file-read-cancel':
      return typeof value.requestId === 'string';
    case 'file-mkdir':
      return (
        typeof value.requestId === 'string' &&
        typeof value.dirPath === 'string' &&
        typeof value.name === 'string'
      );
    case 'file-rename':
      return (
        typeof value.requestId === 'string' &&
        typeof value.path === 'string' &&
        typeof value.newName === 'string'
      );
    case 'file-trash':
      return typeof value.requestId === 'string' && typeof value.path === 'string';
    case 'file-upload-begin':
      return (
        typeof value.requestId === 'string' &&
        typeof value.dirPath === 'string' &&
        typeof value.name === 'string' &&
        isFiniteNumber(value.size)
      );
    case 'file-upload-chunk':
      return (
        typeof value.uploadId === 'string' &&
        isFiniteNumber(value.offset) &&
        typeof value.data === 'string'
      );
    case 'file-upload-commit':
    case 'file-upload-abort':
      return typeof value.uploadId === 'string';
    case 'openclaw-lifecycle':
      return (
        typeof value.requestId === 'string' &&
        (value.action === 'start' || value.action === 'stop' || value.action === 'restart')
      );
    case 'openclaw-sessions-get':
    case 'openclaw-config-get':
    case 'openclaw-chat-ticket':
    case 'quick-commands-list':
      return typeof value.requestId === 'string';
    case 'openclaw-config-set':
      return (
        typeof value.requestId === 'string' &&
        typeof value.key === 'string' &&
        typeof value.value === 'string'
      );
    default:
      return false;
  }
}

/** Per-connection packet-frame coalescing (M3): the host already flushes at
 * 100ms (`PACKET_FLUSH_INTERVAL_MS`); this widens it to 500ms over the phone
 * link so a busy LAN doesn't spam the socket at 10 msg/s. */
const MOBILE_PACKET_FLUSH_MS = 500;
/** Oldest rows drop once a connection's coalescing buffer exceeds this many
 * (mobile only ever renders `PACKET_ROW_CAP` (200) rows anyway). */
const MOBILE_PACKET_PENDING_CAP = 500;
/** Skip (and clear) a flush while the socket's send buffer is this backed up,
 * rather than piling more onto an already-slow link. 256 KiB. */
const MOBILE_PACKET_BACKPRESSURE_BYTES = 262_144;

/** OpenClaw log tail mirroring (M4) — same coalescing/backpressure shape as
 * the packet-frame constants above, just for `openclaw-log-lines`. */
const OPENCLAW_LOG_FLUSH_MS = 500;
const OPENCLAW_LOG_PENDING_CAP = 500;
const OPENCLAW_LOG_BACKPRESSURE_BYTES = 262_144;

// ── DI seams (narrow slices of Electron's MessagePortMain / UtilityProcess /
//    `ws`'s WebSocket — real instances satisfy these structurally, fakes in
//    tests need implement nothing more) ─────────────────────────────────────

// `RemotePort` / `RemoteMessageChannel` / `RemoteInterpreter` are owned by the
// interpreter broker (they describe its interpreter/port seams). Re-exported
// here so existing importers of this module (e.g. remote-bridge.test.ts) keep
// resolving them unchanged.
export type { RemoteInterpreter, RemoteMessageChannel, RemotePort };

export interface RemoteWs {
  readonly readyState: number;
  /** `ws`'s own backpressure gauge (bytes queued, not yet flushed to the OS
   * socket) — `undefined` on a fake that never reports one (never treated as
   * backed up). Used to skip a packet-frame flush rather than pile onto an
   * already-slow link (M3). */
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
}

/** Matches `ws`'s `WebSocket.OPEN` (standard WebSocket readyState 1). */
const WS_OPEN = 1;

/**
 * DI seam over the desktop's `StatsVisibility` + `SystemStatsService`: the
 * bridge only ever acquires/releases and reads snapshots/history through
 * this, so it never imports either directly. `onSnapshot`'s feed is
 * UNGATED (every 1Hz tick, regardless of desktop panel visibility) — this
 * connection's own `statsVisible` flag decides whether to relay it.
 */
export interface RemoteStatsSource {
  getHistory(): SystemStatsSnapshot[];
  onSnapshot(listener: (snapshot: SystemStatsSnapshot) => void): () => void;
  acquire(): void;
  release(): void;
}

/**
 * DI seam over `PacketMirror` (src/main/packet-mirror.ts): the bridge only
 * ever subscribes/unsubscribes through this, so it never imports the mirror
 * (or `PacketCaptureRegistry`) directly. Each `subscribe()` call is this
 * connection's OWN feed — `PacketMirror` gives every subscriber its own
 * viewer port, so one connection's subscribe/unsubscribe never affects
 * another's.
 */
export interface RemotePacketSource {
  subscribe(listener: (frame: RemotePacketFrame) => void): () => void;
}

/**
 * DI seam over `FileService` (src/main/file-service.ts, file-explorer plan
 * M0): the bridge only ever calls through this, so it never imports
 * `FileService` directly — the method signatures mirror it exactly so
 * `fileService satisfies RemoteFileSource` (main.ts) holds structurally with
 * zero adaptation. Deliberately has NO `readTextFile` — the bridge always
 * streams via `openReadStream`, even for `'text'` (viewer) mode.
 */
export interface RemoteFileSource {
  listDirectory(dirPath: string): Promise<FileListResult>;
  listRoots(): Promise<string[]>;
  openReadStream(
    filePath: string,
    mode: 'text' | 'raw' | 'preview',
    authorizedHandle?: FileHandle,
    signal?: AbortSignal,
  ): Promise<{ ok: false; error: string } | ({ ok: true } & FileReadStream)>;
  createFolder(dirPath: string, name: string): Promise<FileOpResult>;
  renameEntry(entryPath: string, newName: string): Promise<FileOpResult>;
  trashEntry(entryPath: string): Promise<FileOpResult>;
  beginUpload(
    dirPath: string,
    name: string,
    size: number,
  ): Promise<{ ok: true; uploadId: string; finalName: string } | { ok: false; error: string }>;
  writeUploadChunk(
    uploadId: string,
    offset: number,
    data: Uint8Array,
  ): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }>;
  commitUpload(uploadId: string): Promise<{ ok: true; finalName: string } | { ok: false; error: string }>;
  abortUpload(uploadId: string): Promise<void>;
}

/** Typed result of a chat-ticket mint (openclaw-management M4/M5). */
export type OpenClawChatTicketResult =
  | { readonly ticket: string; readonly proxyPort: number; readonly token: string }
  | { readonly ticket: null; readonly reason: OpenClawChatTicketFailureReason };

const OPENCLAW_CHAT_TICKET_TIMEOUT_MS = 15_000;

/**
 * DI seam over `OpenClawService` (src/main/openclaw-service.ts) + the proxy's
 * `mintTicket()` (src/main/openclaw-proxy.ts): the bridge only ever calls
 * through this, so it never imports either directly. The method names below
 * mirror `OpenClawService`'s own public surface exactly (same "structural
 * match, zero adaptation" precedent as `RemoteFileSource`/`FileService`) —
 * `mintChatTicket` is the one method main.ts actually composes from TWO
 * sources (the service's `getChatToken()` + the proxy's `mintTicket()`),
 * since ticket-minting itself lives on the proxy, not the service.
 * `setCoreConfig` MAY REJECT (a non-allowlisted key throws on the service) —
 * every caller below must catch that and reply with an `ok:false` result,
 * never let it propagate and crash the connection handler. */
export interface RemoteOpenClawSource {
  subscribeStatus(listener: (status: OpenClawStatus) => void): () => void;
  runLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleResult>;
  subscribeLogs(listener: (line: OpenClawLogLine) => void): () => void;
  listAgentSessions(): Promise<readonly OpenClawAgentSession[]>;
  getCoreConfig(): Promise<OpenClawCoreConfig>;
  setCoreConfig(key: string, value: string): Promise<OpenClawSetConfigResult>;
  mintChatTicket(): Promise<OpenClawChatTicketResult>;
  /** Effective desktop presentation visibility right now. This is only an
   * availability hint pushed to mobile; it does not authorize remote APIs. */
  isVisible(): boolean;
  /** Fires whenever desktop visibility changes (the tri-state mode was
   * toggled) — relayed to every authed connection as `openclaw-availability`. */
  subscribeVisibility(listener: (visible: boolean) => void): () => void;
}

const pendingFileOpensBySource = new WeakMap<RemoteFileSource, Set<AbortController>>();

function pendingFileOpensFor(source: RemoteFileSource): Set<AbortController> {
  let pending = pendingFileOpensBySource.get(source);
  if (!pending) {
    pending = new Set();
    pendingFileOpensBySource.set(source, pending);
  }
  return pending;
}

function isDefinitiveAttachMiss(reason: RunAttachRejectReason): boolean {
  return reason === 'run-not-found' || reason === 'session-mismatch' || reason === 'run-ended';
}

function describeResumeBusy(reason: RunAttachRejectReason): {
  readonly reason: 'capacity' | 'unsupported' | 'unavailable';
  readonly retryable: boolean;
} {
  if (reason === 'mirror-capacity') return { reason: 'capacity', retryable: true };
  if (reason === 'ssh-unsupported') return { reason: 'unsupported', retryable: false };
  return { reason: 'unavailable', retryable: !isDefinitiveAttachMiss(reason) };
}

/** Shared AgentActivityService surface. No hook configuration or bearer data
 * is exposed to remote clients; only sanitized snapshots and waiting followup. */
export interface RemoteAgentSource {
  getSnapshot(): AgentActivitySnapshot;
  onSnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void;
  sendFollowup(activityId: string, text: string): AgentFollowupResult;
}

/** Main-owned Git worktree service. The bridge always supplies the `mobile`
 * origin so the service itself remains the authority that denies mutations. */
export interface RemoteWorktreeSource {
  execute(
    request: WorktreeRequest,
    origin: WorktreeRequestOrigin,
  ): Promise<WorktreeResult>;
}

/** Read-only projection of the main-owned Quick Command store. */
export interface RemoteQuickCommandSource {
  list(): Promise<readonly QuickCommand[]>;
}

export interface RemoteBridgeOptions {
  readonly port: number;
  readonly getToken: () => Promise<string> | string;
  /** Public application version returned in the authenticated handshake. */
  readonly hostVersion: string;
  /** Optional release identity for local diagnostics; never used for auth. */
  readonly buildSha?: string;
  /** The single shared interpreter broker — main.ts and this bridge adapt to
   * ONE instance, so there is exactly one interpreter listener + one session
   * directory across both transports. */
  readonly broker: InterpreterBroker;
  /** Optional so existing fixtures/tests without stats wiring keep working. */
  readonly statsSource?: RemoteStatsSource;
  /** Optional so existing fixtures/tests without packet wiring keep working. */
  readonly packetSource?: RemotePacketSource;
  /** Optional so existing fixtures/tests without file wiring keep working. */
  readonly fileSource?: RemoteFileSource;
  /** Optional so existing fixtures/tests without OpenClaw wiring keep working. */
  readonly openclawSource?: RemoteOpenClawSource;
  readonly agentSource?: RemoteAgentSource;
  /** Optional so older bridge fixtures remain valid. */
  readonly worktreeSource?: RemoteWorktreeSource;
  /** Optional capability: old hosts omit it and mobile hides the surface. */
  readonly quickCommandSource?: RemoteQuickCommandSource;
  /** Shared across websocket generations so transiently orphaned runs resume. */
  readonly runLeases?: RemoteRunLeaseRegistry;
}

const defaultRunLeases = new WeakMap<InterpreterBroker, RemoteRunLeaseRegistry>();

function leasesFor(options: RemoteBridgeOptions): RemoteRunLeaseRegistry {
  if (options.runLeases) return options.runLeases;
  let leases = defaultRunLeases.get(options.broker);
  if (!leases) {
    leases = new RemoteRunLeaseRegistry();
    defaultRunLeases.set(options.broker, leases);
  }
  return leases;
}

/**
 * Attach the bridge's protocol handling to one already-open WS connection.
 * Exported standalone (not bundled into `startRemoteBridge`) so tests can
 * drive it with a fake `RemoteWs` without opening a real network socket.
 */
export function attachConnection(
  ws: RemoteWs,
  options: RemoteBridgeOptions,
  hooks?: { onAuthenticated?: () => void },
): void {
  let authed = false;
  let authPending = false;
  let releaseRunsOnClose = false;
  let connectionClosed = false;
  const runLeases = leasesFor(options);
  const terminalCapabilities = new TerminalFileCapabilityStore();
  const runs = new Map<string, { readonly sessionId: string; readonly port: RemotePort }>();
  const pendingLeaseResumes = new Map<string, { readonly sessionId: string; readonly runId: string }>();
  // This connection's own stats subscription (independent of the desktop panel
  // and of every other connection — statsSource.acquire()/release() combine
  // them all via refcount, see StatsVisibility).
  let statsVisible = false;
  let statsUnsub: (() => void) | null = null;
  // This connection's own packet subscription (M3) — independent of every
  // other connection, same shape as stats above. Batch frames are coalesced
  // into `pendingPacketRows` and flushed on `packetFlushTimer`; status frames
  // bypass coalescing entirely (sent immediately, see the subscribe handler).
  let packetsSubscribed = false;
  let packetsUnsub: (() => void) | null = null;
  let pendingPacketRows: PacketRow[] = [];
  let packetFlushTimer: ReturnType<typeof setInterval> | null = null;
  // File explorer (M3): open read streams keyed by the client's `requestId`,
  // and uploadIds this connection currently owns (for close-teardown abort —
  // FileService's own idle sweep is a backstop, not relied on here).
  const fileReads = new Map<string, RemoteFileReadRecord>();
  const pendingFileOpens = options.fileSource ? pendingFileOpensFor(options.fileSource) : null;
  const fileUploads = new Set<string>();
  // OpenClaw management (M4): this connection's own status/logs subscription
  // state — same shape as stats/packets above (refcounted on the service
  // side via `subscribeStatus`/`subscribeLogs`; per-connection here is just
  // "do I currently have one, and its unsubscribe").
  let openclawStatusSubscribed = false;
  let openclawStatusUnsub: (() => void) | null = null;
  let openclawLogsSubscribed = false;
  let openclawLogsUnsub: (() => void) | null = null;
  let pendingOpenClawLogLines: OpenClawLogLine[] = [];
  let openclawLogFlushTimer: ReturnType<typeof setInterval> | null = null;
  const send = (msg: ServerToClientMessage): void => {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // A close can race the readyState check. The socket close path owns all
      // pending cleanup; transport exceptions must not escape into main.
    }
  };

  const closeFileRead = async (requestId: string, record: RemoteFileReadRecord): Promise<void> => {
    if (record.closed) return;
    record.closed = true;
    record.abortController.abort();
    record.expectedAckOffset = null;
    if (fileReads.get(requestId) === record) fileReads.delete(requestId);
    const stream = record.stream;
    record.stream = null;
    if (stream) await stream.close().catch(() => undefined);
  };

  const failFileRead = (requestId: string, record: RemoteFileReadRecord, error: string): void => {
    if (fileReads.get(requestId) === record && !record.closed) {
      send({ kind: 'file-read-meta', requestId, ok: false, error });
    }
    void closeFileRead(requestId, record);
  };

  const releasePendingResumeLeases = (): void => {
    for (const pending of pendingLeaseResumes.values()) {
      runLeases.release(pending.sessionId, pending.runId);
    }
    pendingLeaseResumes.clear();
  };

  const resumeRun = async (sessionId: string, runId: string, generation: number): Promise<void> => {
    const pendingKey = `${sessionId}\0${runId}`;
    const leaseWasPresent = runLeases.has(sessionId, runId);
    if (leaseWasPresent) pendingLeaseResumes.set(pendingKey, { sessionId, runId });
    const attached = await options.broker.attachRunChecked(sessionId, runId);
    if (leaseWasPresent) pendingLeaseResumes.delete(pendingKey);

    if (!attached.accepted) {
      if (releaseRunsOnClose && leaseWasPresent) runLeases.release(sessionId, runId);
      if (connectionClosed || releaseRunsOnClose) return;
      if (!leaseWasPresent && isDefinitiveAttachMiss(attached.reason)) {
        send({ kind: 'resume-run-missing', sessionId, runId, generation });
        return;
      }
      const busy = describeResumeBusy(attached.reason);
      send({ kind: 'resume-run-busy', sessionId, runId, generation, ...busy });
      return;
    }

    const port1 = attached.port;
    // Keep the liveness-holding lease parked until the replacement attach is
    // authoritative. Taking it earlier creates a last-port-close race and
    // re-parking it on every busy retry would accumulate port listeners.
    const orphan = runLeases.take(sessionId, runId);
    if (releaseRunsOnClose) {
      port1.close();
      orphan?.close();
      return;
    }
    if (connectionClosed) {
      runLeases.park(sessionId, runId, port1);
      port1.start();
      orphan?.close();
      return;
    }

    const record = { sessionId, port: port1 };
    runs.get(runId)?.port.close();
    runs.set(runId, record);
    port1.on('message', (event) => {
      send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
    });
    port1.on('close', () => {
      if (runs.get(runId) === record) runs.delete(runId);
    });
    // Reset the stable renderer before starting the replay queue. If no lease
    // existed, the old server-side socket may still be half-open, so explicitly
    // take PTY control rather than waiting for its eventual close.
    send({ kind: 'resume-run-ready', sessionId, runId, generation });
    if (!orphan) port1.postMessage({ type: 'pty-claim-control' });
    port1.start();
    orphan?.close();
  };

  /** Pull one chunk from an open read stream and send it — called once right
   * after `file-read-meta` and again on every `file-read-ack` (the one-in-
   * flight-chunk contract documented in remote-protocol.ts). */
  const sendNextReadChunk = async (requestId: string, record: RemoteFileReadRecord): Promise<void> => {
    const stream = record.stream;
    if (
      !stream
      || record.closed
      || record.inFlight
      || record.expectedAckOffset !== null
      || fileReads.get(requestId) !== record
    ) return;
    record.inFlight = true;
    try {
      const { offset, data, done } = await stream.next();
      if (record.closed || fileReads.get(requestId) !== record) return;
      const nextOffset = offset + data.length;
      if (
        !Number.isSafeInteger(offset)
        || offset !== record.nextOffset
        || data.length <= 0
        || nextOffset > record.sendBytes
        || (done && nextOffset !== record.sendBytes)
        || (!done && nextOffset >= record.sendBytes)
      ) {
        failFileRead(requestId, record, 'invalid file read stream state');
        return;
      }
      record.nextOffset = nextOffset;
      send({ kind: 'file-read-chunk', requestId, offset, data: uint8ArrayToBase64(data), done });
      if (done) await closeFileRead(requestId, record);
      else record.expectedAckOffset = nextOffset;
    } catch {
      failFileRead(requestId, record, 'file read failed');
    } finally {
      record.inFlight = false;
    }
  };

  const flushPendingPackets = (): void => {
    if (pendingPacketRows.length === 0) return;
    if ((ws.bufferedAmount ?? 0) > MOBILE_PACKET_BACKPRESSURE_BYTES) {
      pendingPacketRows = []; // skip AND clear — don't pile onto a backed-up link
      return;
    }
    const rows = pendingPacketRows;
    pendingPacketRows = [];
    send({ kind: 'packet-frame', frame: { type: 'packets', rows } });
  };

  const stopPacketsSubscription = (): void => {
    if (!packetsSubscribed) return;
    packetsSubscribed = false;
    packetsUnsub?.();
    packetsUnsub = null;
    if (packetFlushTimer !== null) {
      clearInterval(packetFlushTimer);
      packetFlushTimer = null;
    }
    pendingPacketRows = [];
  };

  // OpenClaw management (M4): status/logs subscription teardown — same
  // idempotent-stop + backpressure-aware-flush shape as packets above.
  const stopOpenClawStatusSubscription = (): void => {
    if (!openclawStatusSubscribed) return;
    openclawStatusSubscribed = false;
    openclawStatusUnsub?.();
    openclawStatusUnsub = null;
  };

  const flushPendingOpenClawLogs = (): void => {
    if (pendingOpenClawLogLines.length === 0) return;
    if ((ws.bufferedAmount ?? 0) > OPENCLAW_LOG_BACKPRESSURE_BYTES) {
      pendingOpenClawLogLines = []; // skip AND clear — don't pile onto a backed-up link
      return;
    }
    const lines = pendingOpenClawLogLines;
    pendingOpenClawLogLines = [];
    send({ kind: 'openclaw-log-lines', lines });
  };

  const stopOpenClawLogsSubscription = (): void => {
    if (!openclawLogsSubscribed) return;
    openclawLogsSubscribed = false;
    openclawLogsUnsub?.();
    openclawLogsUnsub = null;
    if (openclawLogFlushTimer !== null) {
      clearInterval(openclawLogFlushTimer);
      openclawLogFlushTimer = null;
    }
    pendingOpenClawLogLines = [];
  };

  // Session/run mirroring (M2): every connection observes every session/run
  // change via the SHARED broker, origin-agnostic (including one THIS connection
  // just created — the broker resolves the create-session reply BEFORE its
  // deferred onSessionAdded fan-out, so a requester always learns "this sessionId
  // is mine" before the broadcast echo, see ADR C6). Gated on `authed` so an
  // unauthenticated socket never sees session/run data. The broker holds the
  // single interpreter listener; this connection adds none.
  const unsubSessionAdded = options.broker.onSessionAdded((session) => {
    if (authed) send({ kind: 'session-added', session });
  });
  const unsubSessionRemoved = options.broker.onSessionRemoved((sessionId) => {
    if (authed) send({ kind: 'session-removed', sessionId });
  });
  const unsubRunStarted = options.broker.onRunStarted((info) => {
    // runId is caller-minted, so unlike session-added there's no "learn my own
    // id first" race — a plain broadcast is enough.
    if (authed) {
      send({
        kind: 'run-started',
        sessionId: info.sessionId,
        runId: info.runId,
        commandText: info.commandText,
        executionKind: info.executionKind,
      });
    }
  });

  // OpenClaw availability (M3): same unconditional-broadcast shape as the
  // session/run mirroring above — `visible` changes with the desktop's
  // tri-state mode, not per-connection state, so there's nothing to gate this
  // subscription on besides `authed`.
  const unsubOpenClawVisibility =
    options.openclawSource?.subscribeVisibility((visible) => {
      if (authed) send({ kind: 'openclaw-availability', visible });
    }) ?? (() => undefined);
  const unsubAgentSnapshot =
    options.agentSource?.onSnapshot((snapshot) => {
      if (authed) send({ kind: 'agent-snapshot', snapshot });
    }) ?? (() => undefined);

  ws.on('close', () => {
    connectionClosed = true;
    terminalCapabilities.clear();
    if (releaseRunsOnClose) releasePendingResumeLeases();
    unsubSessionAdded();
    unsubSessionRemoved();
    unsubRunStarted();
    unsubOpenClawVisibility();
    unsubAgentSnapshot();
    for (const [runId, record] of runs) {
      if (releaseRunsOnClose) record.port.close();
      else runLeases.park(record.sessionId, runId, record.port);
    }
    runs.clear();
    if (statsVisible) {
      statsVisible = false;
      statsUnsub?.();
      statsUnsub = null;
      options.statsSource?.release();
    }
    stopPacketsSubscription();
    // File explorer (M3): a dropped connection is the only owner of its open
    // reads/uploads — close every stream and abort every upload rather than
    // leaving a `.ezpart` file or an fd open until the idle sweep gets to it.
    for (const [requestId, record] of fileReads) void closeFileRead(requestId, record);
    for (const uploadId of fileUploads) void options.fileSource?.abortUpload(uploadId);
    fileUploads.clear();
    // OpenClaw management (M4): same teardown discipline as stats/packets above.
    stopOpenClawStatusSubscription();
    stopOpenClawLogsSubscription();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // never sent by a compliant client — ignore
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }

    if (!authed) {
      // getToken() may be asynchronous. Ignore every frame until that one
      // decision settles so duplicate auth frames cannot authenticate twice.
      if (authPending) return;
      if (!isRecord(parsed) || parsed.kind !== 'auth') {
        ws.close(AUTH_CLOSE_CODE);
        return;
      }
      if (typeof parsed.token !== 'string') {
        send({ kind: 'auth-fail', reason: 'invalid-token' });
        ws.close(AUTH_CLOSE_CODE);
        return;
      }
      const protocolCompatible = (
        parsed.protocolVersion === REMOTE_PROTOCOL_VERSION
        && typeof parsed.clientVersion === 'string'
        && parsed.clientVersion.trim().length > 0
      );
      const candidateToken = parsed.token;
      authPending = true;
      void Promise.resolve(options.getToken()).then((token) => {
        if (connectionClosed || authed) return;
        if (tokensMatch(candidateToken, token)) {
          if (!protocolCompatible) {
            send({
              kind: 'auth-fail',
              reason: 'incompatible-protocol',
              supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
              hostVersion: options.hostVersion,
            });
            ws.close(PROTOCOL_CLOSE_CODE);
            return;
          }
          authed = true;
          hooks?.onAuthenticated?.();
          send({
            kind: 'auth-ok',
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            hostVersion: options.hostVersion,
            ...(options.buildSha ? { hostBuildSha: options.buildSha } : {}),
            ...(options.quickCommandSource
              ? { capabilities: [REMOTE_CAPABILITY_QUICK_COMMANDS_READ] as const }
              : {}),
          });
          if (options.agentSource) send({ kind: 'agent-snapshot', snapshot: options.agentSource.getSnapshot() });
          // OpenClaw availability (M3): initial state, right after auth —
          // `subscribeVisibility` above only covers CHANGES from here on.
          if (options.openclawSource) send({ kind: 'openclaw-availability', visible: options.openclawSource.isVisible() });
        } else {
          send({ kind: 'auth-fail', reason: 'invalid-token' });
          ws.close(AUTH_CLOSE_CODE);
        }
      }).catch(() => {
        if (connectionClosed || authed) return;
        send({ kind: 'auth-fail', reason: 'invalid-token' });
        ws.close(AUTH_CLOSE_CODE);
      });
      return;
    }

    if (!isDispatchableClientMessage(parsed)) return;
    const msg = parsed;

    switch (msg.kind) {
      case 'list-sessions':
        send({ kind: 'session-list', sessions: options.broker.listSessions() });
        break;

      case 'list-runs': {
        // The reply now flows through a `.then` microtask (the broker resolves
        // the pending promise), still strictly ahead of any onSessionAdded
        // fan-out (setImmediate). `.catch` swallows a post-interpreter-death
        // reject — no error frame, keeping the client's silent-hang parity (M1/G2).
        options.broker
          .listRuns()
          .then((runs) => {
            if (authed) send({ kind: 'run-list', runs });
          })
          .catch(() => {});
        break;
      }

      case 'create-session': {
        // Echo the CLIENT's own requestId (captured here) on reply so mobile
        // correlation holds; `.catch` swallows a post-death reject (silent-hang
        // parity, M1/G2).
        const { requestId, cwd } = msg;
        options.broker
          .createSession(cwd)
          .then((session) => {
            send({ kind: 'session-created', requestId, session });
          })
          .catch(() => {});
        break;
      }

      case 'destroy-session':
        options.broker.destroySession(msg.sessionId);
        break;

      case 'destroy-session-guarded': {
        const { requestId, sessionId, expectedActiveRunIds } = msg;
        void (async (): Promise<void> => {
          let result: DestroySessionGuardResult;
          try {
            result = await options.broker.destroySessionGuarded(sessionId, expectedActiveRunIds);
          } catch {
            result = { ok: false, reason: 'unavailable' };
          }
          send({ kind: 'session-destroy-result', requestId, result });
        })();
        break;
      }

      case 'quick-commands-list': {
        const { requestId } = msg;
        const source = options.quickCommandSource;
        if (!source) {
          send({ kind: 'quick-commands-list-reply', requestId, ok: false, error: 'unavailable' });
          break;
        }
        source.list().then((commands) => {
          if (!authed) return;
          const safeCommands = commands
            .slice(0, MAX_QUICK_COMMANDS)
            .flatMap((command) => {
              const parsed = QuickCommandSchema.safeParse(command);
              return parsed.success ? [parsed.data] : [];
            });
          send({ kind: 'quick-commands-list-reply', requestId, ok: true, commands: safeCommands });
        }).catch(() => {
          if (authed) send({ kind: 'quick-commands-list-reply', requestId, ok: false, error: 'unavailable' });
        });
        break;
      }

      case 'run-command': {
        const { runId, sessionId } = msg;
        // Broker mints the port pair + posts port2 to the interpreter; a `null`
        // return (dead interpreter) means no port to relay — skip, don't throw.
        const port1 = options.broker.runCommand(msg.sessionId, runId, msg.commandText, 'mobile');
        if (!port1) break;
        const record = { sessionId, port: port1 };
        runs.get(runId)?.port.close();
        runs.set(runId, record);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => {
          if (runs.get(runId) === record) runs.delete(runId);
        });
        port1.start();
        break;
      }

      // Attach as a non-initiating observer to a run (M2 mirroring) — reuses
      // the SAME `runs` map + frame-relay/control-forwarding shape as
      // `run-command` above (a `control` for this `runId` already forwards
      // correctly with no further changes needed).
      case 'attach-run': {
        const { runId, sessionId } = msg;
        // Same null-guard as run-command: a dead interpreter yields no port.
        const port1 = options.broker.attachRun(sessionId, runId);
        if (!port1) break;
        const record = { sessionId, port: port1 };
        runs.get(runId)?.port.close();
        runs.set(runId, record);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => {
          if (runs.get(runId) === record) runs.delete(runId);
        });
        port1.start();
        break;
      }

      case 'resume-run': {
        const { sessionId, runId, generation } = msg;
        void resumeRun(sessionId, runId, generation);
        break;
      }

      case 'release-runs':
        releaseRunsOnClose = true;
        releasePendingResumeLeases();
        for (const record of runs.values()) record.port.close();
        runs.clear();
        break;

      case 'control': {
        const record = runs.get(msg.runId);
        if (!record) break;
        record.port.postMessage(msg.control);
        if (msg.control.type === 'close') {
          record.port.close();
          runs.delete(msg.runId);
        }
        break;
      }

      case 'stats-visible': {
        if (!options.statsSource) break;
        if (msg.visible) {
          if (statsVisible) break; // idempotent — already on
          statsVisible = true;
          options.statsSource.acquire();
          statsUnsub = options.statsSource.onSnapshot((snapshot) => send({ kind: 'stats-update', snapshot }));
        } else {
          if (!statsVisible) break; // idempotent — already off
          statsVisible = false;
          statsUnsub?.();
          statsUnsub = null;
          options.statsSource.release();
        }
        break;
      }

      case 'stats-history':
        send({ kind: 'stats-history', snapshots: options.statsSource?.getHistory() ?? [] });
        break;

      case 'agent-snapshot-get':
        send({
          kind: 'agent-snapshot',
          requestId: msg.requestId,
          snapshot: options.agentSource?.getSnapshot() ?? { revision: 0, items: [] },
        });
        break;

      case 'agent-followup':
        send({
          kind: 'agent-followup-reply',
          requestId: msg.requestId,
          result: options.agentSource?.sendFollowup(msg.activityId, msg.text) ?? {
            ok: false,
            error: 'delivery-failed',
          },
        });
        break;

      case 'packets-subscribe': {
        if (!options.packetSource) break;
        if (packetsSubscribed) break; // idempotent — already on
        packetsSubscribed = true;
        packetsUnsub = options.packetSource.subscribe((frame) => {
          if (frame.type === 'status') {
            send({ kind: 'packet-frame', frame }); // never coalesced — always immediate
            return;
          }
          pendingPacketRows.push(...frame.rows);
          if (pendingPacketRows.length > MOBILE_PACKET_PENDING_CAP) {
            pendingPacketRows = pendingPacketRows.slice(pendingPacketRows.length - MOBILE_PACKET_PENDING_CAP);
          }
        });
        packetFlushTimer = setInterval(flushPendingPackets, MOBILE_PACKET_FLUSH_MS);
        break;
      }

      case 'packets-unsubscribe':
        stopPacketsSubscription();
        break;

      // ── File explorer (file-explorer plan, M3) ────────────────────────────
      // Every arm below guards `if (!options.fileSource) break;` — silent
      // no-op, same convention as stats/packets above when their source is absent.

      case 'file-list': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.listDirectory(msg.path).then((result) => {
          send({ kind: 'file-list-reply', requestId, result });
        });
        break;
      }

      case 'file-roots': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.listRoots().then((roots) => {
          send({ kind: 'file-roots-reply', requestId, roots });
        });
        break;
      }

      case 'terminal-file-location':
        void resolveTerminalFileLocation(msg.request, terminalCapabilities).then((result) => {
          send({ kind: 'terminal-file-location-reply', requestId: msg.requestId, result });
        });
        break;

      case 'worktree-request': {
        const { requestId } = msg;
        if (!isWorktreeRequest(msg.request)) {
          send({
            kind: 'worktree-reply',
            requestId,
            result: {
              ok: false,
              action: 'list',
              error: 'INVALID_REQUEST',
              message: 'Invalid worktree request.',
            },
          });
          break;
        }
        const request = msg.request;
        if (!options.worktreeSource) {
          send({
            kind: 'worktree-reply',
            requestId,
            result: {
              ok: false,
              action: request.action,
              error: 'IO_ERROR',
              message: 'Worktree service is unavailable.',
            },
          });
          break;
        }
        void options.worktreeSource
          .execute(request, 'mobile')
          .then((result) => send({ kind: 'worktree-reply', requestId, result }))
          .catch(() => {
            send({
              kind: 'worktree-reply',
              requestId,
              result: {
                ok: false,
                action: request.action,
                error: 'IO_ERROR',
                message: 'Worktree operation failed.',
              },
            });
          });
        break;
      }

      case 'file-mkdir': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.createFolder(msg.dirPath, msg.name).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-rename': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.renameEntry(msg.path, msg.newName).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-trash': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.trashEntry(msg.path).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-read': {
        const fileSource = options.fileSource;
        if (!fileSource) break;
        const { requestId } = msg;
        if (
          typeof requestId !== 'string' ||
          typeof msg.path !== 'string' ||
          (msg.mode !== 'text' && msg.mode !== 'raw' && msg.mode !== 'preview') ||
          (msg.terminalCapability !== undefined && typeof msg.terminalCapability !== 'string')
        ) {
          if (typeof requestId === 'string') {
            send({ kind: 'file-read-meta', requestId, ok: false, error: 'invalid file-read request' });
          }
          break;
        }
        const { path: filePath, mode, terminalCapability } = msg;
        const existing = fileReads.get(requestId);
        if (existing) {
          // One id has one owner for its entire opening+streaming lifetime.
          // Ambiguous reuse cancels the original and rejects the duplicate.
          void closeFileRead(requestId, existing);
          send({ kind: 'file-read-meta', requestId, ok: false, error: 'duplicate file-read request id' });
          break;
        }
        if (
          fileReads.size >= MAX_REMOTE_FILE_READS
          || !pendingFileOpens
          || pendingFileOpens.size >= MAX_REMOTE_PENDING_FILE_OPENS
        ) {
          send({ kind: 'file-read-meta', requestId, ok: false, error: 'too many active file reads' });
          break;
        }
        const abortController = new AbortController();
        const record: RemoteFileReadRecord = {
          stream: null,
          abortController,
          closed: false,
          inFlight: false,
          expectedAckOffset: null,
          nextOffset: 0,
          sendBytes: 0,
        };
        // Reserve synchronously, before capability consumption/opening awaits.
        fileReads.set(requestId, record);
        pendingFileOpens.add(abortController);
        const isCurrent = (): boolean => (
          !connectionClosed
          && !record.closed
          && fileReads.get(requestId) === record
        );
        void (async () => {
          let authorizedHandle: FileHandle | undefined;
          try {
            if (!isCurrent()) return;
            if (terminalCapability !== undefined) {
              if (mode !== 'preview') {
                failFileRead(requestId, record, 'invalid terminal preview request');
                return;
              }
              const authorized = await terminalCapabilities.consumeAndOpen(terminalCapability, filePath);
              if (!authorized.ok) {
                failFileRead(requestId, record, 'Terminal preview authorization expired or the file changed.');
                return;
              }
              authorizedHandle = authorized.handle;
              if (!isCurrent()) {
                await authorizedHandle.close().catch(() => undefined);
                return;
              }
            }

            const result = await fileSource.openReadStream(
              filePath,
              mode,
              authorizedHandle,
              abortController.signal,
            );
            if (!isCurrent()) {
              if (result.ok) await result.close().catch(() => undefined);
              else await authorizedHandle?.close().catch(() => undefined);
              return;
            }
            if (!result.ok) {
              await authorizedHandle?.close().catch(() => undefined);
              failFileRead(requestId, record, result.error);
              return;
            }
            const { meta } = result;
            record.stream = result;
            record.sendBytes = meta.sendBytes;
            send({
              kind: 'file-read-meta',
              requestId,
              ok: true,
              fileSize: meta.fileSize,
              sendBytes: meta.sendBytes,
              isText: meta.isText,
              truncated: meta.truncated,
              ...(meta.preview ? { preview: meta.preview } : {}),
            });
            if (meta.sendBytes <= 0) {
              await closeFileRead(requestId, record); // binary in text mode, or empty
              return;
            }
            await sendNextReadChunk(requestId, record);
          } catch {
            await authorizedHandle?.close().catch(() => undefined);
            failFileRead(requestId, record, 'file read failed');
          } finally {
            pendingFileOpens.delete(abortController);
          }
        })();
        break;
      }

      case 'file-read-ack': {
        const record = fileReads.get(msg.requestId);
        if (!record || record.closed || !record.stream) break;
        if (
          !Number.isSafeInteger(msg.offset)
          || record.expectedAckOffset === null
          || msg.offset !== record.expectedAckOffset
        ) {
          failFileRead(msg.requestId, record, 'invalid or duplicate file read acknowledgement');
          break;
        }
        record.expectedAckOffset = null;
        void sendNextReadChunk(msg.requestId, record);
        break;
      }

      case 'file-read-cancel': {
        const record = fileReads.get(msg.requestId);
        if (!record) break;
        void closeFileRead(msg.requestId, record);
        break;
      }

      case 'file-upload-begin': {
        const fileSource = options.fileSource;
        if (!fileSource) break;
        const { requestId } = msg;
        void fileSource.beginUpload(msg.dirPath, msg.name, msg.size)
          .then(async (result) => {
            if (!result.ok) {
              send({ kind: 'file-upload-begin-reply', requestId, ok: false, error: result.error });
              return;
            }
            if (connectionClosed) {
              // beginUpload may finish after close teardown enumerated the
              // tracked ids. Abort this late fd/.ezpart directly instead of
              // leaving it for FileService's idle sweep.
              await fileSource.abortUpload(result.uploadId).catch(() => undefined);
              return;
            }
            fileUploads.add(result.uploadId);
            send({
              kind: 'file-upload-begin-reply',
              requestId,
              ok: true,
              uploadId: result.uploadId,
              finalName: result.finalName,
            });
          })
          .catch(() => {
            send({ kind: 'file-upload-begin-reply', requestId, ok: false, error: 'file upload failed' });
          });
        break;
      }

      case 'file-upload-chunk': {
        if (!options.fileSource) break;
        const { uploadId, offset } = msg;
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8Array(msg.data);
        } catch {
          fileUploads.delete(uploadId);
          void options.fileSource.abortUpload(uploadId);
          send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'malformed chunk' });
          break;
        }
        // Hard cap regardless of what the client claims — never trust size alone.
        if (bytes.length > FILE_CHUNK_BYTES * 2) {
          fileUploads.delete(uploadId);
          void options.fileSource.abortUpload(uploadId);
          send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'chunk exceeds the wire chunk limit' });
          break;
        }
        void options.fileSource.writeUploadChunk(uploadId, offset, bytes).then((result) => {
          if (!result.ok) {
            // FileService already aborted+unlinked on any rejection (out-of-
            // order/oversized/write-error) — this id is done either way.
            fileUploads.delete(uploadId);
            send({ kind: 'file-upload-ack', uploadId, ok: false, error: result.error });
            return;
          }
          send({ kind: 'file-upload-ack', uploadId, ok: true, receivedBytes: result.receivedBytes });
        });
        break;
      }

      case 'file-upload-commit': {
        if (!options.fileSource) break;
        const { uploadId } = msg;
        void options.fileSource.commitUpload(uploadId).then((result) => {
          fileUploads.delete(uploadId);
          if (!result.ok) {
            send({ kind: 'file-upload-done', uploadId, ok: false, error: result.error });
            return;
          }
          send({ kind: 'file-upload-done', uploadId, ok: true, finalName: result.finalName });
        });
        break;
      }

      case 'file-upload-abort':
        if (!options.fileSource) break;
        fileUploads.delete(msg.uploadId);
        void options.fileSource.abortUpload(msg.uploadId);
        break;

      // ── OpenClaw management (openclaw-management M4) ────────────────────
      // Every arm below guards `if (!options.openclawSource) break;` — silent
      // no-op, same convention as stats/packets/file-* above when their
      // source is absent. Desktop presentation visibility is deliberately not
      // an authorization gate: an authenticated mobile client can manage
      // OpenClaw even while the desktop panel is hidden.

      case 'openclaw-status-subscribe': {
        if (!options.openclawSource) break;
        if (openclawStatusSubscribed) break; // idempotent — already on
        openclawStatusSubscribed = true;
        openclawStatusUnsub = options.openclawSource.subscribeStatus((status) => {
          send({ kind: 'openclaw-status', status });
        });
        break;
      }

      case 'openclaw-status-unsubscribe':
        stopOpenClawStatusSubscription();
        break;

      case 'openclaw-lifecycle': {
        if (!options.openclawSource) break;
        const { requestId, action } = msg;
        options.openclawSource
          .runLifecycle(action)
          .then((result) => send({ kind: 'openclaw-lifecycle-result', requestId, result }))
          .catch((err: unknown) => {
            send({
              kind: 'openclaw-lifecycle-result',
              requestId,
              result: { ok: false, stderr: err instanceof Error ? err.message : String(err) },
            });
          });
        break;
      }

      case 'openclaw-logs-subscribe': {
        if (!options.openclawSource) break;
        if (openclawLogsSubscribed) break; // idempotent — already on
        openclawLogsSubscribed = true;
        openclawLogsUnsub = options.openclawSource.subscribeLogs((line) => {
          pendingOpenClawLogLines.push(line);
          if (pendingOpenClawLogLines.length > OPENCLAW_LOG_PENDING_CAP) {
            pendingOpenClawLogLines = pendingOpenClawLogLines.slice(
              pendingOpenClawLogLines.length - OPENCLAW_LOG_PENDING_CAP,
            );
          }
        });
        openclawLogFlushTimer = setInterval(flushPendingOpenClawLogs, OPENCLAW_LOG_FLUSH_MS);
        break;
      }

      case 'openclaw-logs-unsubscribe':
        stopOpenClawLogsSubscription();
        break;

      case 'openclaw-sessions-get': {
        if (!options.openclawSource) break;
        const { requestId } = msg;
        options.openclawSource
          .listAgentSessions()
          .then((sessions) => send({ kind: 'openclaw-sessions-reply', requestId, sessions }))
          .catch(() => send({ kind: 'openclaw-sessions-reply', requestId, sessions: [] }));
        break;
      }

      case 'openclaw-config-get': {
        if (!options.openclawSource) break;
        const { requestId } = msg;
        options.openclawSource
          .getCoreConfig()
          .then((config) => send({ kind: 'openclaw-config-reply', requestId, config }))
          .catch(() =>
            send({
              kind: 'openclaw-config-reply',
              requestId,
              config: Object.fromEntries(OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET])) as OpenClawCoreConfig,
            }),
          );
        break;
      }

      case 'openclaw-config-set': {
        if (!options.openclawSource) break;
        const { requestId, key, value } = msg;
        // `setCoreConfig` REJECTS for a non-allowlisted key (defense against a
        // hostile/buggy client, see OpenClawService's own doc) — that must
        // surface as an `ok:false` reply, never crash this connection handler.
        options.openclawSource
          .setCoreConfig(key, value)
          .then((result) => send({ kind: 'openclaw-config-set-reply', requestId, result }))
          .catch((err: unknown) => {
            send({
              kind: 'openclaw-config-set-reply',
              requestId,
              result: { ok: false, restartRequired: false, error: err instanceof Error ? err.message : String(err) },
            });
          });
        break;
      }

      case 'openclaw-chat-ticket': {
        if (!options.openclawSource) break;
        const { requestId } = msg;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          send({
            kind: 'openclaw-chat-ticket-reply',
            requestId,
            ticket: null,
            proxyPort: 0,
            token: null,
            reason: 'timeout',
          });
        }, OPENCLAW_CHAT_TICKET_TIMEOUT_MS);
        timeout.unref?.();
        void options.openclawSource
          .mintChatTicket()
          .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (result.ticket === null) {
              send({
                kind: 'openclaw-chat-ticket-reply',
                requestId,
                ticket: null,
                proxyPort: 0,
                token: null,
                reason: result.reason,
              });
              return;
            }
            send({
              kind: 'openclaw-chat-ticket-reply',
              requestId,
              ticket: result.ticket,
              proxyPort: result.proxyPort,
              token: result.token,
            });
          })
          .catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            send({
              kind: 'openclaw-chat-ticket-reply',
              requestId,
              ticket: null,
              proxyPort: 0,
              token: null,
              reason: 'proxy-unavailable',
            });
          });
        break;
      }

      // 'auth' after auth already succeeded — ignored (no-op, not an error).
      default:
        break;
    }
  });
}

export interface RemoteBridgeHandle {
  /** Actual bound port (useful when tests or future callers request port 0). */
  readonly port: number;
  /** Terminates every connected client (fires each socket's 'close', see
   * attachConnection's per-connection teardown) then closes the listening
   * socket — resolves only once the port is actually released, so an
   * immediate restart on the same port never races EADDRINUSE. */
  stop(): Promise<void>;
}

/**
 * Start the WS server. Binds `0.0.0.0` (LAN/Tailscale reachable) — remote
 * control is OFF by default (see `LayoutStore.getRemoteEnabled`), so the
 * listener only exists once the user opts in. Access is gated by the persisted
 * token (`tokensMatch`, constant-time); browser origins are rejected
 * (`isRemoteOriginAllowed`); frames are capped (`MAX_INBOUND_FRAME_BYTES`) and
 * connections are bounded (`MAX_REMOTE_CONNECTIONS` + `AUTH_DEADLINE_MS`). The
 * transport itself is plain `ws://` — intended for a trusted LAN or an
 * encrypted overlay (Tailscale/WireGuard); see SECURITY.md.
 */
export async function startRemoteBridge(options: RemoteBridgeOptions): Promise<RemoteBridgeHandle> {
  const runLeases = leasesFor(options);
  const connectionOptions = options.runLeases ? options : { ...options, runLeases };
  const wss = new WebSocketServer({
    port: options.port,
    host: '0.0.0.0',
    maxPayload: MAX_INBOUND_FRAME_BYTES,
    verifyClient: (info: { origin?: string }) => isRemoteOriginAllowed(info.origin),
  });
  // `WebSocketServer` begins binding in its constructor but reports the result
  // asynchronously. Do not hand a handle to main until the listener is real;
  // an EADDRINUSE/EACCES is part of the start operation, not a background log.
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      wss.off('error', onBindError);
      resolve();
    };
    const onBindError = (error: Error): void => {
      wss.off('listening', onListening);
      reject(error);
    };
    wss.once('listening', onListening);
    wss.once('error', onBindError);
  });
  // Errors after a successful bind are unexpected but must remain contained.
  wss.on('error', (err) => console.error('[remote-bridge] WebSocketServer error:', err));

  // Heartbeat sweep (attachConnection itself is untouched — fakes/tests never
  // see this): counts consecutive missed pongs per socket, terminating once a
  // connection misses HEARTBEAT_MAX_MISSED_PONGS in a row.
  const missedPongs = new WeakMap<WebSocket, number>();
  wss.on('connection', (ws) => {
    // Refuse beyond the connection cap so a socket flood can't exhaust main
    // (1013 = Try Again Later). `wss.clients` already includes this socket.
    if (wss.clients.size > MAX_REMOTE_CONNECTIONS) {
      ws.close(1013);
      return;
    }
    // Terminate a socket that never authenticates in time (cleared the moment
    // auth succeeds, via the onAuthenticated hook, or when the socket closes).
    // `.unref()` so the timer never keeps the process alive on its own.
    const authTimer = setTimeout(() => ws.terminate(), AUTH_DEADLINE_MS);
    authTimer.unref?.();
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
    ws.on('close', () => clearTimeout(authTimer));
    attachConnection(ws as unknown as RemoteWs, connectionOptions, {
      onAuthenticated: () => clearTimeout(authTimer),
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= HEARTBEAT_MAX_MISSED_PONGS) {
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const address = wss.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
  let stopPromise: Promise<void> | null = null;
  return {
    port: boundPort,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close((err) => {
          runLeases.dispose();
          if (err) console.error('[remote-bridge] error closing WebSocketServer:', err);
          resolve();
        });
      });
      return stopPromise;
    },
  };
}
