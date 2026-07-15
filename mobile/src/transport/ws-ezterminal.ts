/**
 * WsEzTerminalTransport — implements the desktop's `EzTerminalApi` (see
 * `src/shared/ipc.ts`) over the WS bridge from `src/main/remote-bridge.ts`
 * (mobile remote-control M0/M1), so `BlockController` and the block-rendering
 * components can be reused UNMODIFIED on mobile.
 *
 * The seam that makes this possible: the desktop preload can't hand a
 * MessagePort through contextBridge, so it forwards the port to the renderer
 * world via `window.postMessage({ _ezPort: runId }, '/', [port])`, and
 * `TerminalPane.tsx` picks it up with `window.addEventListener('message', ...)`
 * (see preload.ts's module doc + TerminalPane.tsx's `onWindowMessage`). This
 * transport reproduces the SAME observable event — `ev.data._ezPort === runId`
 * + a port-like object in `ev.ports[0]` — but can't use a REAL
 * `window.postMessage(msg, origin, [port])` to do it: that call's structured-
 * clone-with-transfer algorithm requires a genuine `Transferable` (a real
 * `MessagePort`/`ArrayBuffer`/etc.) and throws `DataCloneError` on a plain
 * object. Instead it constructs the `MessageEvent` directly (`new
 * MessageEvent('message', { data, ports, source })`) and dispatches it on
 * `window` — the DOM does not validate `ports`' contents for a manually
 * constructed event, only for `postMessage`'s transfer list, so a duck-typed
 * `FakeMessagePort` (an `EventTarget` implementing the four methods
 * `BlockController`/`dispose()` actually call: `addEventListener('message')`,
 * `postMessage`, `start`, `close`) works without ever being a real
 * `MessagePort`. `source: window` is required too — TerminalPane's listener
 * only trusts `ev.source === window` (or a matching origin), and a
 * synthetically-constructed event defaults `source` to `null`.
 *
 * `pty-data`'s `Uint8Array` travels the wire as base64 text (`remote-
 * protocol.ts`'s `encodeFrame`/`decodeFrame`) — this transport decodes it
 * back to a real `Uint8Array` before dispatching, so `BlockController` (which
 * reads `frame.data.byteLength`) never has to know the difference.
 *
 * Methods outside mobile's scope (layout/presets/theme persistence — all
 * explicitly excluded, see the mobile remote-control plan) are implemented as
 * inert stubs purely to satisfy the shared `EzTerminalApi` type; nothing
 * calls them from the mobile UI. The stats overlay (M2) and the packet-tee
 * (M3) ARE in scope — `onStatsUpdate`/`getStatsHistory`/
 * `setStatsPanelVisible`/`subscribePackets`/`unsubscribePackets` below are all
 * real implementations.
 *
 * `subscribePackets`/`unsubscribePackets` reuse the SAME `_ezPort`-style
 * handoff as `runCommand`, but with ONE important difference: the packet port
 * is created ONCE (on the first `subscribePackets()` call) and kept alive for
 * the lifetime of the subscription, including across reconnects — unlike a
 * per-run `FakeMessagePort`, there is no `runId` to correlate a fresh port to,
 * and the consumer (`MobileStatsView`'s capture tab) only ever listens on the
 * one port it received from the one handoff. A reconnect's 'auth-ok' replays
 * `packets-subscribe` (mirroring `stats-visible`'s replay) WITHOUT a second
 * handoff — the server's `PacketMirror` replays the current status on its own.
 */
import {
  MAX_GUARDED_DESTROY_RUN_IDS,
  type DestroySessionGuardResult,
  type EzTerminalApi,
  type GuardedSessionDestroyRequest,
  type InterpreterFrame,
  type RemoteConnectionInfo,
  type RemoteRuntimeStatus,
  type RendererControl,
  type RunStartedInfo,
  type RuntimeVersions,
  type SessionInfo,
  type SystemStatsSnapshot,
} from '../../../src/shared/ipc';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult, type FileReadTextResult } from '../../../src/shared/files';
import type {
  FilePreviewResult,
  FilePreviewStreamMetadata,
} from '../../../src/shared/file-preview';
import type { StartupPref, ThemeName } from '../../../src/shared/layout-schema';
import type {
  TerminalFileLocationRequest,
  TerminalFileLocationResult,
} from '../../../src/shared/terminal-file-location';
import type {
  WorktreeAction,
  WorktreeInfo,
  WorktreeRequest,
  WorktreeResult,
} from '../../../src/shared/worktree';
import {
  EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  type AgentActivitySnapshot,
  type AgentFollowupResult,
} from '../../../src/shared/agent';
import {
  base64ToUint8Array,
  decodeFrame,
  REMOTE_CAPABILITY_QUICK_COMMANDS_READ,
  REMOTE_PROTOCOL_VERSION,
  uint8ArrayToBase64,
  type BuildInfo,
  type ClientToServerMessage,
  type OpenClawChatTicketFailureReason,
  type RemoteCapability,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../../../src/shared/remote-protocol';
import {
  MAX_QUICK_COMMANDS,
  QuickCommandSchema,
  type QuickCommand,
} from '../../../src/shared/quick-command';
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
} from '../../../src/shared/openclaw';
import {
  classifyEndpoint,
  type ConnectionHealthSnapshot,
  type RemoteConnectionState,
} from './connection-health';
import { MOBILE_BUILD_INFO } from '../build-info';
import { e2eLog } from '../e2e-telemetry';

export type { ConnectionHealthSnapshot, RemoteConnectionState } from './connection-health';

/** WebView-74-compatible RFC 4122 v4 request id. Android 10 may start with a
 * WebView that predates `crypto.randomUUID`, but it still provides the secure
 * `crypto.getRandomValues` primitive. */
export function createSecureRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generic result of one `file-read` round trip (M4) — `readTextFile`/
 * `downloadFile` each reshape this into their own public return type. */
type FileReadResult =
  | {
      readonly ok: true;
      readonly fileSize: number;
      readonly isText: boolean;
      readonly truncated: boolean;
      readonly bytes: Uint8Array;
      readonly preview?: FilePreviewStreamMetadata;
    }
  | { readonly ok: false; readonly error: string };

/** Tracks one in-flight `file-read` request between `file-read-meta` and the
 * last `file-read-chunk` — `buffer` is allocated once `sendBytes` is known
 * (null beforehand, and stays null for a binary file in `'text'` mode, which
 * never streams any chunk). `onProgress` is only used by `downloadFile`. */
interface FileReadAssembly {
  buffer: Uint8Array | null;
  fileSize: number;
  isText: boolean;
  truncated: boolean;
  preview: FilePreviewStreamMetadata | null;
  readonly onProgress?: (received: number, total: number) => void;
  readonly resolve: (result: FileReadResult) => void;
}

/** Local mirrors of the wire's `ok:true/false` reply shapes (M5), same
 * "small local result type, not imported from remote-protocol.ts" precedent
 * as `FileReadResult` above — `uploadFile` throws on `ok:false` at each
 * `await`, which is what actually rejects its outer promise. */
type UploadBeginResult = { ok: true; uploadId: string; finalName: string } | { ok: false; error: string };
type UploadAckResult = { ok: true; receivedBytes: number } | { ok: false; error: string };
type UploadDoneResult = { ok: true; finalName: string } | { ok: false; error: string };

/** Reply shape for `getOpenClawChatTicket()` (openclaw-management M4/M5) —
 * mirrors `OpenClawChatTicketReply` on the wire; `ticket`/`token` are `null`
 * when no ticket could be minted (see remote-protocol.ts's doc). */
export type OpenClawChatFailureReason = OpenClawChatTicketFailureReason;

export type OpenClawChatTicket =
  | { readonly ok: true; readonly ticket: string; readonly proxyPort: number; readonly token: string }
  | { readonly ok: false; readonly reason: OpenClawChatFailureReason };

const OPENCLAW_TICKET_TIMEOUT_MS = 20_000;
const OPENCLAW_CONFIG_TIMEOUT_MS = 25_000;
const OPENCLAW_LIFECYCLE_TIMEOUT_MS = 40_000;

function isOpenClawChatFailureReason(value: unknown): value is OpenClawChatFailureReason {
  return value === 'gateway-stopped'
    || value === 'gateway-unreachable'
    || value === 'token-unavailable'
    || value === 'proxy-unavailable'
    || value === 'insecure-auth-required'
    || value === 'timeout';
}

// ── DI seam over the browser `WebSocket` (real instances satisfy this
//    structurally; tests inject a fake) ──────────────────────────────────────

export interface WsLike {
  /** Browser WebSocket readiness when exposed by the injected implementation. */
  readonly readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type CreateSocket = (url: string) => WsLike;

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8000;
const WS_OPEN = 1;
const RESUME_RETRY_INITIAL_MS = 250;
const RESUME_RETRY_MAX_MS = 4000;
const RESUME_RETRY_MAX_ATTEMPTS = 5;
const MAX_GUARDED_DESTROY_ID_LENGTH = 256;

function isGuardedDestroyId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_GUARDED_DESTROY_ID_LENGTH
  );
}

/** Read-only desktop Quick Command snapshot. An older host is distinguished
 * from a temporary transport/store failure so the mobile affordance can stay
 * hidden instead of presenting a permanently failing action. */
export type RemoteQuickCommandsResult =
  | { readonly ok: true; readonly commands: readonly QuickCommand[] }
  | { readonly ok: false; readonly error: 'unsupported' | 'offline' | 'unavailable' };
/**
 * How long a single connection attempt may sit un-authenticated before it is
 * abandoned and retried. Covers BOTH "the socket never opened" (unreachable
 * host — the browser's own TCP timeout can be tens of seconds) AND the nastier
 * "socket opened but `auth-ok` never came and `close` never fired" half-open
 * case (e.g. a VPN link that is mid-handshake), which otherwise stalls the
 * reconnect loop forever because reconnects are only scheduled on `close`.
 */
const DEFAULT_AUTH_TIMEOUT_MS = 6000;

/**
 * A duck-typed stand-in for a real `MessagePort` — see the module doc for why
 * a genuine `MessagePort` can't be used here. Implements only the surface
 * `BlockController` actually calls: `addEventListener('message', ...)` (native
 * `EventTarget` behavior), `postMessage`, `start`, `close`.
 *
 * Generic over the delivered frame type so the SAME class serves both the
 * per-run cmd port (`FakeMessagePort<InterpreterFrame>`, the default) and the
 * persistent packet port (`FakeMessagePort<RemotePacketFrame>`) — the class
 * itself is just an `EventTarget` wrapper; only the type of what flows over
 * `deliver()` differs.
 */
export class FakeMessagePort<TFrame = InterpreterFrame> extends EventTarget {
  private disposed = false;

  constructor(private readonly onControl: (control: RendererControl) => void) {
    super();
  }

  /** BlockController -> here: relay the control to the server as `{kind:'control', runId, control}`. */
  postMessage(control: RendererControl): void {
    if (this.disposed) return;
    this.onControl(control);
  }

  /** No-op: unlike a real MessagePort, this port never queues — `deliver()` below
   * dispatches directly, so there is nothing held back for `start()` to release. */
  start(): void {
    /* intentionally empty */
  }

  close(): void {
    this.disposed = true;
  }

  /** Transport-internal: push a decoded frame in as a 'message' event. */
  deliver(frame: TFrame): void {
    if (this.disposed) return;
    this.dispatchEvent(new MessageEvent('message', { data: frame }));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

export interface WsEzTerminalOptions {
  readonly url: string;
  readonly token: string;
  /** Test/release seam for the public handshake and copied diagnostics. */
  readonly buildInfo?: BuildInfo;
  /** Test seam: defaults to the real browser `WebSocket`. */
  readonly createSocket?: CreateSocket;
  /** Test seam: defaults to the secure WebView-compatible v4 generator. */
  readonly newId?: () => string;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Test seam: how long an attempt may stay un-authed before retry. */
  readonly authTimeoutMs?: number;
  /** Test seams for bounded OpenClaw request/reply operations. */
  readonly openClawTicketTimeoutMs?: number;
  readonly openClawConfigTimeoutMs?: number;
  readonly openClawLifecycleTimeoutMs?: number;
}

interface RunPortRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly port: FakeMessagePort;
  /** True only for this transport's initiating run, never an attach mirror. */
  readonly initiatedHere: boolean;
}

interface ResumeRetryState {
  readonly generation: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WsEzTerminalTransport implements EzTerminalApi {
  /** Not meaningful for a remote WS client — no local Electron/Chrome/Node process. */
  readonly versions: RuntimeVersions;

  private readonly url: string;
  private readonly token: string;
  private readonly buildInfo: BuildInfo;
  private readonly createSocket: CreateSocket;
  private readonly newId: () => string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly authTimeoutMs: number;
  private readonly openClawTicketTimeoutMs: number;
  private readonly openClawConfigTimeoutMs: number;
  private readonly openClawLifecycleTimeoutMs: number;

  private socket: WsLike | null = null;
  private authed = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-attempt auth watchdog — self-heals a stuck/half-open connection. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private everAuthed = false;
  private generation = 0;
  private connectionState: RemoteConnectionState = 'connecting';
  private reconnectAttempts = 0;
  private nextRetryAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private hostVersion = 'unknown';
  private hostBuildSha = 'unknown';
  private reattachPrioritySessionId: string | null = null;

  /** Stable renderer-side ports. They deliberately survive transient sockets;
   * `resume-run` rebinds the same BlockController/xterm after authentication. */
  private readonly ports = new Map<string, RunPortRecord>();
  /** Capacity can be transient while another mirror releases its PTY slot.
   * Retry only within the current authenticated generation, with a bounded
   * exponential backoff so a permanently busy run cannot spin forever. */
  private readonly resumeRetries = new Map<string, ResumeRetryState>();
  private readonly pendingCreates = new Map<
    string,
    { resolve: (session: SessionInfo) => void; reject: (err: Error) => void }
  >();
  private readonly pendingGuardedDestroys = new Map<
    string,
    (result: DestroySessionGuardResult) => void
  >();
  /** `list-sessions` has no request/response correlation id on the wire (M0) —
   * concurrent callers are served FIFO as `session-list` replies arrive. */
  private readonly pendingListSessions: Array<(sessions: readonly SessionInfo[]) => void> = [];
  /** `list-runs` has no correlation id on the wire either (M1 mirror-active-
   * runs) — same FIFO precedent as `pendingListSessions` above. */
  private readonly pendingListRuns: Array<(runs: readonly RunStartedInfo[]) => void> = [];
  private readonly sessionDeadListeners = new Set<(info?: { logPath?: string | null }) => void>();
  /** Mobile-only (M2 ConnectScreen): fires on every authed transition, including
   * an immediate replay of the CURRENT state to a listener that just subscribed. */
  private readonly authListeners = new Set<(authed: boolean) => void>();
  private readonly connectionStateListeners = new Set<(state: RemoteConnectionState) => void>();
  private readonly connectionHealthListeners = new Set<(snapshot: ConnectionHealthSnapshot) => void>();
  private remoteCapabilities = new Set<RemoteCapability>();
  private readonly pendingQuickCommands = new Map<
    string,
    (result: RemoteQuickCommandsResult) => void
  >();
  private readonly connectionDiagnostics: Array<{
    readonly at: string;
    readonly event: 'connect' | 'connected' | 'retry-scheduled' | 'retry-now' | 'auth-rejected' | 'protocol-incompatible' | 'disconnected';
    readonly state: RemoteConnectionState;
    readonly attempt: number;
  }> = [];

  // Session mirroring (M2): full mirroring across desktop tabs + mobile. These
  // three broadcasts are origin-agnostic (fire for sessions/runs THIS
  // connection itself started too, same as desktop's ipc.ts) — the caller
  // self-filters, it already has the id from its own local call.
  private readonly sessionAddedListeners = new Set<(session: SessionInfo) => void>();
  private readonly sessionRemovedListeners = new Set<(sessionId: string) => void>();
  private readonly runStartedListeners = new Set<(info: RunStartedInfo) => void>();

  private agentSnapshot: AgentActivitySnapshot = EMPTY_AGENT_ACTIVITY_SNAPSHOT;
  /** Revisions are process-local to the desktop. The first snapshot from each
   * newly-created socket is therefore an authoritative epoch seed even when
   * its revision is below the cache retained across reconnects. */
  private awaitingAgentSeed = true;
  private readonly agentSnapshotListeners = new Set<(snapshot: AgentActivitySnapshot) => void>();
  private readonly pendingAgentSnapshots = new Map<string, (snapshot: AgentActivitySnapshot) => void>();
  private readonly pendingAgentFollowups = new Map<string, (result: AgentFollowupResult) => void>();

  /** The desired stats-visible state, remembered across reconnects — see the
   * 'auth-ok' replay in `handleServerMessage`. */
  private statsVisible = false;
  private readonly statsListeners = new Set<(snapshot: SystemStatsSnapshot) => void>();
  /** `stats-history` has no correlation id on the wire (same precedent as
   * `list-sessions`) — concurrent callers are served FIFO as replies arrive. */
  private readonly pendingStatsHistory: Array<(snapshots: readonly SystemStatsSnapshot[]) => void> = [];

  /** The desired packets-subscribed state, remembered across reconnects — see
   * the 'auth-ok' replay in `handleServerMessage`. */
  private packetsSubscribed = false;
  /** ONE persistent port for the lifetime of a subscription (see module doc —
   * unlike cmd ports, there's no per-run correlation id, and it survives a
   * reconnect without a second handoff). */
  private packetPort: FakeMessagePort<RemotePacketFrame> | null = null;

  // File explorer (M4) — pending request maps, one per reply shape, keyed by
  // the client-minted `requestId`. A dropped connection resolves every
  // in-flight entry with a "connection lost" result (see `endConnection`)
  // rather than leaving the caller's promise hanging forever — the same
  // ok:false/empty-array convention `FileListResult`/`FileOpResult` already
  // use for an expected failure, so callers need no separate try/catch path.
  private readonly pendingFileList = new Map<string, (result: FileListResult) => void>();
  private readonly pendingFileRoots = new Map<string, (roots: string[]) => void>();
  private readonly pendingTerminalFileLocations = new Map<string, (result: TerminalFileLocationResult) => void>();
  private readonly pendingWorktrees = new Map<
    string,
    { readonly action: WorktreeAction; readonly resolve: (result: WorktreeResult) => void }
  >();
  private readonly worktreeOpenListeners = new Set<(worktree: WorktreeInfo) => void>();
  /** Survives socket generations so attach replay repairs a lost intent
   * without opening a second tab when the original frame was already seen. */
  private readonly handledWorktreeOpenIntents = new Set<string>();
  private readonly pendingFileOps = new Map<string, (result: FileOpResult) => void>();
  private readonly pendingFileReads = new Map<string, FileReadAssembly>();

  // Upload (M5) — `pendingUploadBegins` keys by the client-minted requestId
  // (the only round trip that has one); every message after that correlates
  // by the server-minted `uploadId` instead.
  private readonly pendingUploadBegins = new Map<string, (result: UploadBeginResult) => void>();
  private readonly pendingUploadAcks = new Map<string, (result: UploadAckResult) => void>();
  private readonly pendingUploadDones = new Map<string, (result: UploadDoneResult) => void>();

  // OpenClaw management (M4) — status/logs use the SAME two-method split as
  // stats (`onStatsUpdate`/`setStatsPanelVisible`): a plain listener set, plus
  // a separate desired-state flag that is remembered and REPLAYED on the
  // 'auth-ok' handler below (same reconnect-safety precedent as
  // `statsVisible`/`packetsSubscribed`). Lifecycle/sessions/config/chat-ticket
  // are request/reply, correlated by a locally-minted `requestId` (same FIFO-
  // map precedent as `pendingFileOps` above) — a dropped connection resolves
  // every in-flight entry with a "connection lost" result, never left pending.
  private readonly openclawStatusListeners = new Set<(status: OpenClawStatus) => void>();
  /** REFCOUNT, not a boolean (openclaw-stabilization M3): MobileWorkspace
   * (for the entry-button status dot) and MobileOpenClawView (while it's
   * open) both call `setOpenClawStatusSubscribed` independently on the SAME
   * transport instance — a boolean would let the view's unmount-time
   * `setOpenClawStatusSubscribed(false)` cancel the workspace's own still-
   * wanted subscription. Clamped at 0, same "combine independent
   * acquire/release callers" shape as `StatsVisibility` (src/main/stats-
   * visibility.ts) on the desktop side, just inlined here rather than a
   * separate class (only one subscription to combine, not N remote viewers). */
  private openclawStatusRefcount = 0;
  private readonly openclawLogListeners = new Set<(lines: readonly OpenClawLogLine[]) => void>();
  private openclawLogsSubscribed = false;
  private readonly pendingOpenClawLifecycle = new Map<string, (result: OpenClawLifecycleResult) => void>();
  private readonly pendingOpenClawSessions = new Map<string, (sessions: readonly OpenClawAgentSession[]) => void>();
  private readonly pendingOpenClawConfigGet = new Map<string, (config: OpenClawCoreConfig) => void>();
  private readonly pendingOpenClawConfigSet = new Map<string, (result: OpenClawSetConfigResult) => void>();
  private readonly pendingOpenClawChatTicket = new Map<string, (reply: OpenClawChatTicket) => void>();

  // OpenClaw availability (M3) — pushed unconditionally (no subscribe
  // message, unlike status/logs above) right after auth and on every desktop
  // mode change. `openclawAvailable` is `undefined` until the first push
  // arrives (or after a disconnect resets it — see `endConnection`); `onOpen
  // ClawAvailability` folds that to `false` on replay, same "unknown reads as
  // not-visible" contract MobileWorkspace's effective-visibility derivation uses.
  private openclawAvailable: boolean | undefined;
  private readonly openclawAvailabilityListeners = new Set<(visible: boolean) => void>();

  constructor(options: WsEzTerminalOptions) {
    this.url = options.url;
    this.token = options.token;
    this.buildInfo = options.buildInfo ?? MOBILE_BUILD_INFO;
    this.versions = {
      app: this.buildInfo.appVersion,
      protocol: this.buildInfo.protocolVersion,
      buildSha: this.buildInfo.buildSha,
      electron: 'n/a',
      chrome: 'n/a',
      node: 'n/a',
    };
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.newId = options.newId ?? createSecureRequestId;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.openClawTicketTimeoutMs = options.openClawTicketTimeoutMs ?? OPENCLAW_TICKET_TIMEOUT_MS;
    this.openClawConfigTimeoutMs = options.openClawConfigTimeoutMs ?? OPENCLAW_CONFIG_TIMEOUT_MS;
    this.openClawLifecycleTimeoutMs = options.openClawLifecycleTimeoutMs ?? OPENCLAW_LIFECYCLE_TIMEOUT_MS;
    this.backoffMs = this.initialBackoffMs;
    this.connect();
  }

  /** Stop reconnecting and close the live socket (app backgrounding/teardown). */
  disconnect(): void {
    this.stopped = true;
    // This is a user-authorized disconnect, not a transient radio handoff.
    // Tell main to close live run ports instead of placing them in the lease.
    if (this.authed) this.send({ kind: 'release-runs' });
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    this.socket?.close();
    this.socket = null;
    this.nextRetryAt = null;
    this.remoteCapabilities.clear();
    this.setAuthed(false);
    this.setConnectionState('disconnected');
    this.recordConnectionDiagnostic('disconnected');
    this.resolvePendingRequestsUnavailable();
    this.failAndClearPorts('Disconnected from EZTerminal');
  }

  /** Mobile-only (not part of `EzTerminalApi`): drives the SessionSwitcher drawer (M2). */
  listSessions(): Promise<readonly SessionInfo[]> {
    return new Promise((resolve) => {
      if (!this.tryStartFifoRequest(
        { kind: 'list-sessions' },
        this.pendingListSessions,
        resolve,
      )) resolve([]);
    });
  }

  // ── EzTerminalApi ─────────────────────────────────────────────────────────

  createSession(cwd?: string): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const requestId = this.newId();
      const pending = { resolve, reject };
      if (!this.tryStartMapRequest(
        { kind: 'create-session', requestId, cwd },
        this.pendingCreates,
        requestId,
        pending,
      )) reject(new Error('Not connected to EZTerminal'));
    });
  }

  destroySession(sessionId: string): void {
    this.send({ kind: 'destroy-session', sessionId });
  }

  destroySessionGuarded(
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ): Promise<DestroySessionGuardResult> {
    if (
      !this.authed
      || !isGuardedDestroyId(sessionId)
      || !Array.isArray(expectedActiveRunIds)
      || expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
      || !expectedActiveRunIds.every(isGuardedDestroyId)
      || new Set(expectedActiveRunIds).size !== expectedActiveRunIds.length
    ) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const requestId = this.newId();
    if (!isGuardedDestroyId(requestId)) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    return new Promise((resolve) => {
      if (!this.tryStartMapRequest(
        {
          kind: 'destroy-session-guarded',
          requestId,
          sessionId,
          expectedActiveRunIds,
        },
        this.pendingGuardedDestroys,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  destroySessionsGuarded(
    sessions: readonly GuardedSessionDestroyRequest[],
  ): Promise<DestroySessionGuardResult> {
    if (sessions.length === 0) return Promise.resolve({ ok: true });
    if (sessions.length === 1) {
      return this.destroySessionGuarded(
        sessions[0].sessionId,
        sessions[0].expectedActiveRunIds,
      );
    }
    // Mobile has no preset/layout replacement surface and the WS protocol
    // intentionally exposes only a single-session guarded destroy. Never
    // emulate an atomic batch with sequential requests.
    return Promise.resolve({ ok: false, reason: 'unavailable' });
  }

  runCommand(commandText: string, runId: string, sessionId: string): Promise<void> {
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(runId);
        this.ports.delete(runId);
      }
    });
    this.clearResumeRetry(runId);
    this.ports.get(runId)?.port.close();
    this.ports.set(runId, { sessionId, runId, port, initiatedHere: true });
    this.send({ kind: 'run-command', runId, sessionId, commandText });
    // Mirrors preload.ts's `_ezPort` handoff (see module doc for why this is a
    // synthetic dispatchEvent rather than a real window.postMessage transfer).
    // `ports` is set as an own property AFTER construction, not via the
    // MessageEventInit dict: passing a non-genuine MessagePort through the
    // constructor's `ports` sequence goes through a WebIDL coercion step that
    // silently strips FakeMessagePort's methods (confirmed under jsdom) —
    // defining it directly on the instance bypasses that conversion entirely.
    const event = new MessageEvent('message', { data: { _ezPort: runId }, source: window });
    Object.defineProperty(event, 'ports', { value: [port], enumerable: true, configurable: true });
    window.dispatchEvent(event);
    return Promise.resolve();
  }

  onSessionDead(listener: (info?: { logPath?: string | null }) => void): () => void {
    this.sessionDeadListeners.add(listener);
    return () => this.sessionDeadListeners.delete(listener);
  }

  // Desktop main-process recovery is an in-window IPC event. A mobile bridge
  // connection remains usable through the stable broker and needs no local
  // latch transition, so this shared-API hook is intentionally inert here.
  onSessionRecovered(): () => void {
    return () => undefined;
  }

  // ── Session mirroring (M2) ────────────────────────────────────────────────

  onSessionAdded(listener: (session: SessionInfo) => void): () => void {
    this.sessionAddedListeners.add(listener);
    return () => this.sessionAddedListeners.delete(listener);
  }

  onSessionRemoved(listener: (sessionId: string) => void): () => void {
    this.sessionRemovedListeners.add(listener);
    return () => this.sessionRemovedListeners.delete(listener);
  }

  onRunStarted(listener: (info: RunStartedInfo) => void): () => void {
    this.runStartedListeners.add(listener);
    return () => this.runStartedListeners.delete(listener);
  }

  /** Every currently-active run across every session (M1 mirror-active-runs
   * gap fix) — mirrors `listSessions()`'s FIFO wire shape above. */
  listRuns(): Promise<readonly RunStartedInfo[]> {
    return new Promise((resolve) => {
      if (!this.tryStartFifoRequest(
        { kind: 'list-runs' },
        this.pendingListRuns,
        resolve,
      )) resolve([]);
    });
  }

  /** Mirrors `runCommand`'s `_ezAttachPort` handoff (see its doc + module doc)
   * — same `FakeMessagePort`/`ports` map, keyed by `runId` regardless of
   * whether this connection is the run's initiator or an attacher, since
   * `frame` messages carry only `runId` either way. */
  attachRun(sessionId: string, runId: string): Promise<void> {
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(runId);
        this.ports.delete(runId);
      }
    });
    this.clearResumeRetry(runId);
    this.ports.get(runId)?.port.close();
    this.ports.set(runId, { sessionId, runId, port, initiatedHere: false });
    this.send({ kind: 'attach-run', sessionId, runId });
    const event = new MessageEvent('message', { data: { _ezAttachPort: runId }, source: window });
    Object.defineProperty(event, 'ports', { value: [port], enumerable: true, configurable: true });
    window.dispatchEvent(event);
    return Promise.resolve();
  }

  executeWorktree(request: WorktreeRequest): Promise<WorktreeResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      const pending = { action: request.action, resolve };
      if (!this.tryStartMapRequest(
        { kind: 'worktree-request', requestId, request },
        this.pendingWorktrees,
        requestId,
        pending,
      )) {
        resolve({
          ok: false,
          action: request.action,
          error: 'IO_ERROR',
          message: 'Not connected to EZTerminal.',
        });
      }
    });
  }

  /** Mobile UI seam: a validated open selects a fresh ordinary terminal tab. */
  onWorktreeOpenRequested(listener: (worktree: WorktreeInfo) => void): () => void {
    this.worktreeOpenListeners.add(listener);
    return () => this.worktreeOpenListeners.delete(listener);
  }

  private emitWorktreeOpen(worktree: WorktreeInfo): void {
    for (const listener of this.worktreeOpenListeners) listener(worktree);
  }

  private acceptWorktreeOpenIntent(intentId: string): boolean {
    if (this.handledWorktreeOpenIntents.has(intentId)) return false;
    this.handledWorktreeOpenIntents.add(intentId);
    if (this.handledWorktreeOpenIntents.size > 256) {
      const oldest = this.handledWorktreeOpenIntents.values().next().value as string | undefined;
      if (oldest) this.handledWorktreeOpenIntents.delete(oldest);
    }
    return true;
  }

  getAgentActivitySnapshot(): Promise<AgentActivitySnapshot> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-snapshot-get', requestId },
        this.pendingAgentSnapshots,
        requestId,
        resolve,
      )) resolve(this.agentSnapshot);
    });
  }

  onAgentActivitySnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void {
    this.agentSnapshotListeners.add(listener);
    listener(this.agentSnapshot);
    return () => this.agentSnapshotListeners.delete(listener);
  }

  sendAgentFollowup(activityId: string, text: string): Promise<AgentFollowupResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-followup', requestId, activityId, text },
        this.pendingAgentFollowups,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'delivery-failed' });
    });
  }

  /** Mobile-only (not part of `EzTerminalApi`): drives the ConnectScreen's
   * connecting/connected/failed states. Replays the current state immediately. */
  onAuthChange(listener: (authed: boolean) => void): () => void {
    this.authListeners.add(listener);
    listener(this.authed);
    return () => this.authListeners.delete(listener);
  }

  /** One 1Hz stats push while `setStatsPanelVisible(true)` — mirrors the desktop's `StatusPanel.tsx`. */
  onStatsUpdate(listener: (snapshot: SystemStatsSnapshot) => void): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  getStatsHistory(): Promise<SystemStatsSnapshot[]> {
    return new Promise((resolve) => {
      // Copy to a mutable array — the wire reply is `readonly` but this method's
      // `EzTerminalApi` signature (unlike mobile-only `listSessions`) is not.
      const pending = (snapshots: readonly SystemStatsSnapshot[]): void => resolve([...snapshots]);
      if (!this.tryStartFifoRequest(
        { kind: 'stats-history' },
        this.pendingStatsHistory,
        pending,
      )) resolve([]);
    });
  }

  /** Tell the bridge whether THIS connection wants the 1Hz push. Only sent while
   * authed — sending anything before `auth-ok` gets the connection closed by the
   * bridge (see `remote-bridge.ts`'s un-authed guard) — but the desired state is
   * always remembered so a not-yet-authed (or reconnecting) call is replayed by
   * the 'auth-ok' handler below once the handshake completes. */
  setStatsPanelVisible(visible: boolean): void {
    this.statsVisible = visible;
    if (this.authed) this.send({ kind: 'stats-visible', visible });
  }

  // ── Out of scope for mobile (layout/presets/theme persistence) — inert
  //    stubs only, to satisfy `EzTerminalApi`. Nothing in the mobile UI calls
  //    these (see the mobile remote-control plan's exclusions). ─────────────

  loadLayout(): Promise<null> {
    return Promise.resolve(null);
  }
  saveLayout(): Promise<void> {
    return Promise.resolve();
  }
  flushLayout(): Promise<void> {
    return Promise.resolve();
  }
  quarantineLayout(): Promise<void> {
    return Promise.resolve();
  }
  listPresets(): Promise<string[]> {
    return Promise.resolve([]);
  }
  getPreset(): Promise<null> {
    return Promise.resolve(null);
  }
  savePreset(): Promise<boolean> {
    return Promise.resolve(false);
  }
  deletePreset(): Promise<void> {
    return Promise.resolve();
  }
  getStartup(): Promise<StartupPref> {
    return Promise.resolve({ mode: 'last' });
  }
  setStartup(): Promise<void> {
    return Promise.resolve();
  }
  getTheme(): Promise<ThemeName> {
    return Promise.resolve('dark');
  }
  setTheme(): Promise<void> {
    return Promise.resolve();
  }
  // UI scale (v0.2.0 D1) is mobile's own localStorage choice (mobile/src/ui-scale.ts),
  // same "out of scope" reasoning as theme above — inert stubs only.
  getUiScale(): Promise<number> {
    return Promise.resolve(100);
  }
  setUiScale(): Promise<void> {
    return Promise.resolve();
  }
  // Scrollback (WT-parity M5) is out of scope for mobile the same way UI scale
  // is above — inert stubs only, to satisfy `EzTerminalApi`.
  getScrollback(): Promise<number> {
    return Promise.resolve(5000);
  }
  setScrollback(): Promise<void> {
    return Promise.resolve();
  }

  /** Ask the bridge to tee packet-capture frames to this connection
   * (view-only — the desktop owns start/stop). Sends immediately if authed
   * (like `setStatsPanelVisible`); the desired state is always remembered so
   * a not-yet-authed (or reconnecting) call is replayed on 'auth-ok'. The
   * `_ezPacketPort` handoff (module doc) only happens ONCE — a second call
   * before `unsubscribePackets()` just re-sends the wire message. */
  subscribePackets(): void {
    this.packetsSubscribed = true;
    if (this.authed) this.send({ kind: 'packets-subscribe' });
    if (!this.packetPort) {
      const port = new FakeMessagePort<RemotePacketFrame>(() => undefined);
      this.packetPort = port;
      const event = new MessageEvent('message', { data: { _ezPacketPort: true }, source: window });
      Object.defineProperty(event, 'ports', { value: [port], enumerable: true, configurable: true });
      window.dispatchEvent(event);
    }
  }

  unsubscribePackets(): void {
    this.packetsSubscribed = false;
    if (this.authed) this.send({ kind: 'packets-unsubscribe' });
    this.packetPort?.close();
    this.packetPort = null;
  }

  // ── OpenClaw management (openclaw-management M4, mobile-only) ────────────
  // Mirrors the desktop drawer's IPC surface (src/shared/openclaw.ts +
  // openclaw-service.ts's method names) over the wire protocol added in
  // remote-protocol.ts. Not part of `EzTerminalApi` — see the module doc.

  /** Fires on every `openclaw-status` push while subscribed (see
   * `setOpenClawStatusSubscribed`). */
  onOpenClawStatus(listener: (status: OpenClawStatus) => void): () => void {
    this.openclawStatusListeners.add(listener);
    return () => this.openclawStatusListeners.delete(listener);
  }

  /** Tell the bridge whether THIS caller wants the OpenClaw status push —
   * REFCOUNTED (see `openclawStatusRefcount`'s doc): only the 0->1 and 1->0
   * transitions actually send a wire message; an already-subscribed second
   * caller (or a not-yet-zero release) is a no-op on the wire, same
   * "transition only" discipline as `StatsVisibility.recompute`. */
  setOpenClawStatusSubscribed(subscribed: boolean): void {
    const wasSubscribed = this.openclawStatusRefcount > 0;
    this.openclawStatusRefcount = Math.max(0, this.openclawStatusRefcount + (subscribed ? 1 : -1));
    const isSubscribed = this.openclawStatusRefcount > 0;
    if (wasSubscribed === isSubscribed) return;
    if (this.authed) this.send({ kind: isSubscribed ? 'openclaw-status-subscribe' : 'openclaw-status-unsubscribe' });
  }

  /** Fires on every `openclaw-log-lines` push (coalesced batch of lines, see
   * remote-protocol.ts) while subscribed. */
  onOpenClawLogLines(listener: (lines: readonly OpenClawLogLine[]) => void): () => void {
    this.openclawLogListeners.add(listener);
    return () => this.openclawLogListeners.delete(listener);
  }

  /** Tell the bridge whether THIS connection wants the OpenClaw log tail —
   * same replay-on-reconnect shape as `setOpenClawStatusSubscribed`. */
  setOpenClawLogsSubscribed(subscribed: boolean): void {
    this.openclawLogsSubscribed = subscribed;
    if (this.authed) this.send({ kind: subscribed ? 'openclaw-logs-subscribe' : 'openclaw-logs-unsubscribe' });
  }

  runOpenClawLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-lifecycle', requestId, action },
        this.pendingOpenClawLifecycle,
        requestId,
        resolve,
        this.openClawLifecycleTimeoutMs,
        { ok: false, code: 'timeout', stderr: 'OpenClaw lifecycle request timed out' },
      )) resolve({ ok: false, stderr: 'Not connected to EZTerminal' });
    });
  }

  getOpenClawSessions(): Promise<readonly OpenClawAgentSession[]> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-sessions-get', requestId },
        this.pendingOpenClawSessions,
        requestId,
        resolve,
        this.openClawConfigTimeoutMs,
        [],
      )) resolve([]);
    });
  }

  getOpenClawConfig(): Promise<OpenClawCoreConfig> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-config-get', requestId },
        this.pendingOpenClawConfigGet,
        requestId,
        resolve,
        this.openClawConfigTimeoutMs,
        Object.fromEntries(
          OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET]),
        ) as OpenClawCoreConfig,
      )) {
        resolve(Object.fromEntries(
          OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET]),
        ) as OpenClawCoreConfig);
      }
    });
  }

  setOpenClawConfig(key: string, value: string): Promise<OpenClawSetConfigResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-config-set', requestId, key, value },
        this.pendingOpenClawConfigSet,
        requestId,
        resolve,
        this.openClawConfigTimeoutMs,
        { ok: false, restartRequired: false, code: 'timeout', error: 'OpenClaw config request timed out' },
      )) {
        resolve({
          ok: false,
          restartRequired: false,
          error: 'Not connected to EZTerminal',
        });
      }
    });
  }

  /** Fires on every `openclaw-availability` push (openclaw-stabilization
   * M3) — the desktop's effective OpenClaw visibility. REPLAYS the current
   * cached value immediately to a new subscriber (same precedent as
   * `onAuthChange` above), folding "haven't heard yet" to `false`. No
   * subscribe/unsubscribe call needed (unlike `onOpenClawStatus`) — the
   * bridge pushes this unconditionally to every authed connection. */
  onOpenClawAvailability(listener: (visible: boolean) => void): () => void {
    this.openclawAvailabilityListeners.add(listener);
    listener(this.openclawAvailable ?? false);
    return () => this.openclawAvailabilityListeners.delete(listener);
  }

  /** Mint a fresh chat ticket for the mobile chat embed (M5) — see
   * openclaw-proxy.ts's module doc for the ticket+cookie auth flow this feeds. */
  getOpenClawChatTicket(): Promise<OpenClawChatTicket> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-chat-ticket', requestId },
        this.pendingOpenClawChatTicket,
        requestId,
        resolve,
        this.openClawTicketTimeoutMs,
        { ok: false, reason: 'timeout' },
      )) resolve({ ok: false, reason: 'gateway-unreachable' });
    });
  }

  // ── Mobile remote-control pairing (M4, desktop-side pairing panel only) ───
  // A mobile CLIENT has no reason to query its own bridge's LAN URLs or rotate
  // the token it just used to connect — these exist on `EzTerminalApi` for the
  // DESKTOP pairing panel. `getRemoteToken` returns the token this transport
  // was actually configured with (accurate, if ever useful for a "connected as"
  // display); the other two are inert stubs.
  getRemoteConnectionInfo(): Promise<RemoteConnectionInfo> {
    return Promise.resolve({ urls: [], port: 0 });
  }
  getRemoteToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  getRemoteSecurityStatus(): Promise<{ readonly state: 'ready' | 'error'; readonly error: string | null }> {
    return Promise.resolve({ state: 'ready', error: null });
  }

  resolveTerminalFileLocation(request: TerminalFileLocationRequest): Promise<TerminalFileLocationResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'terminal-file-location', requestId, request },
        this.pendingTerminalFileLocations,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unreadable' });
    });
  }
  rotateRemoteToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  // The on/off toggle (v0.2.0 D2) is a DESKTOP-side setting (it starts/stops
  // that host's own bridge) — a mobile client is on the other end of the
  // connection it would be toggling, so this is an inert "always on" stub,
  // never surfaced in the mobile UI (see the v0.2.0 plan's D5: no remote
  // toggle in MobileSettingsView).
  getRemoteEnabled(): Promise<boolean> {
    return Promise.resolve(true);
  }
  getRemoteRuntimeStatus(): Promise<RemoteRuntimeStatus> {
    return Promise.resolve({ desiredEnabled: true, state: 'running', port: 0, errorCode: null, error: null });
  }
  setRemoteEnabled(_enabled: boolean): Promise<RemoteRuntimeStatus> {
    void _enabled;
    return this.getRemoteRuntimeStatus();
  }
  retryRemoteRuntime(): Promise<RemoteRuntimeStatus> {
    return this.getRemoteRuntimeStatus();
  }
  onRemoteRuntimeStatus(listener: (status: RemoteRuntimeStatus) => void): () => void {
    void this.getRemoteRuntimeStatus().then(listener);
    return () => undefined;
  }

  // ── File explorer (file-explorer plan, M4) ────────────────────────────────
  // `openFileInApp`/`revealFileInExplorer` stay rejecting stubs — desktop-only
  // (no mobile analog: there's no "OS default app" or file manager to hand
  // off to on the phone side of this connection). Every other member below
  // is a real request/reply round trip over the M3 wire protocol.
  //
  // NO client-initiated `file-read-cancel` (viewer/download abandoned mid-
  // stream): `readTextFile`/`downloadFile`'s signatures (the former fixed by
  // `EzTerminalApi`, the latter specified by the file-explorer plan) return a
  // bare Promise with no cancel handle, and reads are bounded (<=1MiB text,
  // <=50MiB raw) so a stray finish is cheap. The bridge's own M3 close-
  // teardown already closes any stream still open when THIS connection
  // drops, so nothing leaks server-side either way.

  listFiles(path: string): Promise<FileListResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'file-list', requestId, path },
        this.pendingFileList,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
  }

  listFileRoots(): Promise<string[]> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'file-roots', requestId },
        this.pendingFileRoots,
        requestId,
        resolve,
      )) resolve([]);
    });
  }

  /** Streams in `'text'` mode (1MiB cap + binary detection, both server-side
   * via `FileService`) then reshapes the raw byte result into `FileReadTextResult`. */
  readTextFile(path: string): Promise<FileReadTextResult> {
    return this.requestFileRead(path, 'text').then((result) => {
      if (!result.ok) return { ok: false, error: result.error };
      if (!result.isText) return { ok: true, isText: false, fileSize: result.fileSize };
      const content = new TextDecoder('utf-8', { fatal: false }).decode(result.bytes);
      return { ok: true, isText: true, content, truncated: result.truncated, fileSize: result.fileSize };
    });
  }

  /** Mobile-only richer lifecycle signal used by reconnect/auth overlays. */
  onConnectionStateChange(listener: (state: RemoteConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    listener(this.connectionState);
    return () => this.connectionStateListeners.delete(listener);
  }

  /** Structured, redacted connection status for mobile recovery UI. */
  onConnectionHealthChange(listener: (snapshot: ConnectionHealthSnapshot) => void): () => void {
    this.connectionHealthListeners.add(listener);
    listener(this.getConnectionHealthSnapshot());
    return () => this.connectionHealthListeners.delete(listener);
  }

  /** Whether the paired desktop advertised the optional read-only command
   * snapshot. The last known value survives a transient radio handoff so an
   * already-visible picker can render an explicit offline state. */
  get supportsRemoteQuickCommands(): boolean {
    return this.remoteCapabilities.has(REMOTE_CAPABILITY_QUICK_COMMANDS_READ);
  }

  listRemoteQuickCommands(): Promise<RemoteQuickCommandsResult> {
    if (!this.supportsRemoteQuickCommands) {
      return Promise.resolve({ ok: false, error: 'unsupported' });
    }
    if (!this.authed) return Promise.resolve({ ok: false, error: 'offline' });
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'quick-commands-list', requestId },
        this.pendingQuickCommands,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'offline' });
    });
  }

  /** Cancel the current wait/attempt and start exactly one fresh socket. */
  retryNow(): boolean {
    if (
      this.connectionState === 'connected'
      || this.connectionState === 'disconnected'
      || this.connectionState === 'protocol-incompatible'
    ) return false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.close();
    } catch {
      // A failed close cannot block the new generation; every old handler is
      // guarded by socket identity.
    }
    this.stopped = false;
    this.setAuthed(false);
    this.reconnectAttempts += 1;
    this.nextRetryAt = null;
    this.setConnectionState(this.everAuthed ? 'reconnecting' : 'connecting');
    this.recordConnectionDiagnostic('retry-now');
    this.emitConnectionHealth();
    this.connect();
    return true;
  }

  /** Copy-safe diagnostics: no URL, token, cwd, commands, or terminal data. */
  getConnectionDiagnostics(): string {
    const snapshot = this.getConnectionHealthSnapshot();
    return [
      'EZTerminal connection diagnostics',
      `state=${snapshot.state}`,
      `attempt=${snapshot.attempt}`,
      `endpointKind=${snapshot.endpointKind}`,
      `appVersion=${this.buildInfo.appVersion}`,
      `protocolVersion=${this.buildInfo.protocolVersion}`,
      `buildSha=${this.buildInfo.buildSha}`,
      `hostVersion=${this.hostVersion}`,
      `hostBuildSha=${this.hostBuildSha}`,
      `lastConnectedAt=${snapshot.lastConnectedAt === null ? 'never' : new Date(snapshot.lastConnectedAt).toISOString()}`,
      `nextRetryAt=${snapshot.nextRetryAt === null ? 'none' : new Date(snapshot.nextRetryAt).toISOString()}`,
      ...this.connectionDiagnostics.map((entry) => (
        `${entry.at} event=${entry.event} state=${entry.state} attempt=${entry.attempt}`
      )),
    ].join('\n');
  }

  /** Resume the visible session first so its terminal becomes interactive first. */
  setReattachPriority(sessionId: string | null): void {
    this.reattachPrioritySessionId = sessionId;
  }

  readFilePreview(path: string, terminalCapability?: string): Promise<FilePreviewResult> {
    return this.requestFileRead(path, 'preview', undefined, terminalCapability).then((result) => {
      if (!result.ok) return { ok: false, error: result.error };
      const preview = result.preview;
      if (!preview) return { ok: false, error: 'preview metadata missing from desktop response' };
      switch (preview.kind) {
        case 'text':
          return {
            ok: true,
            kind: 'text',
            name: preview.name,
            mime: preview.mime,
            content: new TextDecoder('utf-8', { fatal: false }).decode(result.bytes),
            truncated: result.truncated,
            fileSize: result.fileSize,
          };
        case 'image':
          return {
            ok: true,
            kind: 'image',
            name: preview.name,
            mime: preview.mime,
            bytes: result.bytes,
            width: preview.width,
            height: preview.height,
            fileSize: result.fileSize,
          };
        case 'pdf':
          return { ok: true, ...preview, fileSize: result.fileSize };
        case 'unsupported':
          return { ok: true, ...preview, fileSize: result.fileSize };
      }
    });
  }

  createFolder(dirPath: string, name: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'file-mkdir', requestId, dirPath, name },
        this.pendingFileOps,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
  }

  renameFile(path: string, newName: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'file-rename', requestId, path, newName },
        this.pendingFileOps,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
  }

  trashFile(path: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'file-trash', requestId, path },
        this.pendingFileOps,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
  }

  openFileInApp(): Promise<void> {
    return Promise.reject(new Error('files: desktop-only'));
  }
  revealFileInExplorer(): Promise<void> {
    return Promise.reject(new Error('files: desktop-only'));
  }

  /** Mobile-only (not part of `EzTerminalApi`, like `listSessions`): streams
   * in `'raw'` mode (50MiB cap, no text/binary detection — mirrors
   * `FileService.openReadStream('raw')`) for the "download to phone" action.
   * `name` is `path`'s final segment (handles both `/` and `\` separators —
   * the desktop side may send either). Rejects on any read failure; there is
   * no ok:false variant in this return shape (mobile-only, no `EzTerminalApi`
   * contract to match), so a caller wraps it in try/catch. */
  downloadFile(
    path: string,
    onProgress: (received: number, total: number) => void,
  ): Promise<{ name: string; bytes: Uint8Array }> {
    return this.requestFileRead(path, 'raw', onProgress).then((result) => {
      if (!result.ok) throw new Error(result.error);
      const name = path.split(/[/\\]/).pop() || path;
      return { name, bytes: result.bytes };
    });
  }

  /** Mobile-only (not part of `EzTerminalApi`, like `downloadFile`): uploads
   * `bytes` to `dirPath/name` on the desktop. Slices into `FILE_CHUNK_BYTES`
   * pieces, base64-encoding ONE chunk at a time (never the whole file —
   * see remote-protocol.ts's streaming contract) and awaiting each chunk's
   * ack before sending the next (one in flight, matching the M3 wire
   * contract both directions). Rejects on any `ok:false` reply at any stage;
   * there is no ok:false variant in this return shape (mobile-only, no
   * `EzTerminalApi` contract to match), so a caller wraps it in try/catch. */
  async uploadFile(
    dirPath: string,
    name: string,
    bytes: Uint8Array,
    onProgress: (sentBytes: number) => void,
  ): Promise<{ finalName: string }> {
    const requestId = this.newId();
    const begin = await new Promise<UploadBeginResult>((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'file-upload-begin', requestId, dirPath, name, size: bytes.length },
        this.pendingUploadBegins,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
    if (!begin.ok) throw new Error(begin.error);
    const { uploadId } = begin;

    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, bytes.length));
      const ack = await new Promise<UploadAckResult>((resolve) => {
        if (!this.tryStartMapRequest(
          { kind: 'file-upload-chunk', uploadId, offset, data: uint8ArrayToBase64(chunk) },
          this.pendingUploadAcks,
          uploadId,
          resolve,
        )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
      });
      if (!ack.ok) throw new Error(ack.error);
      offset += chunk.length;
      onProgress(offset);
    }

    const done = await new Promise<UploadDoneResult>((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'file-upload-commit', uploadId },
        this.pendingUploadDones,
        uploadId,
        resolve,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
    if (!done.ok) throw new Error(done.error);
    return { finalName: done.finalName };
  }

  /** Shared assembler for `readTextFile`/`downloadFile`: sends `file-read`,
   * preallocates the receive buffer once `file-read-meta` reports `sendBytes`,
   * copies each `file-read-chunk` at its offset, and acks (ack-gated — see
   * remote-protocol.ts's streaming contract) until `done`. */
  private requestFileRead(
    path: string,
    mode: 'text' | 'raw' | 'preview',
    onProgress?: (received: number, total: number) => void,
    terminalCapability?: string,
  ): Promise<FileReadResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      const pending: FileReadAssembly = {
        buffer: null,
        fileSize: 0,
        isText: true,
        truncated: false,
        preview: null,
        onProgress,
        resolve,
      };
      if (!this.tryStartMapRequest(
        {
          kind: 'file-read',
          requestId,
          path,
          mode,
          ...(terminalCapability === undefined ? {} : { terminalCapability }),
        },
        this.pendingFileReads,
        requestId,
        pending,
      )) resolve({ ok: false, error: 'Not connected to EZTerminal' });
    });
  }

  // ── connection lifecycle ─────────────────────────────────────────────────

  private connect(): void {
    this.nextRetryAt = null;
    this.recordConnectionDiagnostic('connect');
    this.emitConnectionHealth();
    const socket = this.createSocket(this.url);
    this.socket = socket;
    this.awaitingAgentSeed = true;
    // Bound this attempt: if it doesn't reach `auth-ok` in time (never opened,
    // or opened but the auth round-trip stalled — a half-open link never fires
    // 'close'), abandon it and let the backoff loop try a fresh socket.
    this.armWatchdog(socket);
    // Every handler is guarded by `this.socket === socket`, so a late event
    // from a socket we already superseded (watchdog fired, then its real
    // 'close' arrives) is a no-op instead of corrupting the newer attempt.
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({
        kind: 'auth',
        token: this.token,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        clientVersion: this.buildInfo.appVersion,
        buildSha: this.buildInfo.buildSha,
      } satisfies ClientToServerMessage));
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.handleServerMessage(event.data);
    });
    socket.addEventListener('close', () => {
      this.endConnection(socket);
    });
    // 'close' always follows 'error' for a browser WebSocket, so reconnect
    // scheduling lives only in the 'close'/watchdog paths — nothing to do here.
    socket.addEventListener('error', () => undefined);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private armWatchdog(socket: WsLike): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.socket !== socket) return; // already superseded
      try {
        socket.close(); // may or may not fire 'close' (half-open) — drive retry regardless
      } catch {
        /* ignore */
      }
      this.endConnection(socket);
    }, this.authTimeoutMs);
  }

  private setAuthed(value: boolean): void {
    if (this.authed === value) return;
    this.authed = value;
    for (const listener of this.authListeners) listener(value);
  }

  private setConnectionState(state: RemoteConnectionState): void {
    if (this.connectionState === state) {
      this.emitConnectionHealth();
      return;
    }
    this.connectionState = state;
    for (const listener of this.connectionStateListeners) listener(state);
    this.emitConnectionHealth();
  }

  private getConnectionHealthSnapshot(): ConnectionHealthSnapshot {
    return {
      state: this.connectionState,
      attempt: this.reconnectAttempts,
      nextRetryAt: this.nextRetryAt,
      lastConnectedAt: this.lastConnectedAt,
      endpointKind: classifyEndpoint(this.url),
    };
  }

  private emitConnectionHealth(): void {
    const snapshot = this.getConnectionHealthSnapshot();
    for (const listener of this.connectionHealthListeners) listener(snapshot);
  }

  private recordConnectionDiagnostic(
    event: 'connect' | 'connected' | 'retry-scheduled' | 'retry-now' | 'auth-rejected' | 'protocol-incompatible' | 'disconnected',
  ): void {
    this.connectionDiagnostics.push({
      at: new Date().toISOString(),
      event,
      state: this.connectionState,
      attempt: this.reconnectAttempts,
    });
    if (this.connectionDiagnostics.length > 100) {
      this.connectionDiagnostics.splice(0, this.connectionDiagnostics.length - 100);
    }
  }

  private failAndClearPorts(message: string): void {
    this.clearAllResumeRetries();
    for (const record of this.ports.values()) {
      record.port.deliver({ type: 'error', message });
      record.port.close();
    }
    this.ports.clear();
  }

  /** Settle every request/reply waiter that belonged to the ending socket.
   * Shared by transient close, auth rejection, and explicit disconnect so no
   * public Promise can remain orphaned when `disconnect()` nulls the socket
   * before its eventual close event reaches `endConnection`. */
  private resolvePendingRequestsUnavailable(): void {
    for (const resolve of this.pendingQuickCommands.values()) {
      resolve({ ok: false, error: 'offline' });
    }
    this.pendingQuickCommands.clear();
    for (const pending of this.pendingCreates.values()) {
      pending.reject(new Error('Connection to EZTerminal lost'));
    }
    this.pendingCreates.clear();
    for (const resolve of this.pendingGuardedDestroys.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingGuardedDestroys.clear();
    for (const resolve of this.pendingListSessions) resolve([]);
    this.pendingListSessions.length = 0;
    for (const resolve of this.pendingListRuns) resolve([]);
    this.pendingListRuns.length = 0;
    for (const resolve of this.pendingStatsHistory) resolve([]);
    this.pendingStatsHistory.length = 0;
    for (const pending of this.pendingWorktrees.values()) {
      pending.resolve({
        ok: false,
        action: pending.action,
        error: 'IO_ERROR',
        message: 'Connection to EZTerminal lost.',
      });
    }
    this.pendingWorktrees.clear();
    for (const resolve of this.pendingAgentSnapshots.values()) resolve(this.agentSnapshot);
    this.pendingAgentSnapshots.clear();
    for (const resolve of this.pendingAgentFollowups.values()) {
      resolve({ ok: false, error: 'delivery-failed' });
    }
    this.pendingAgentFollowups.clear();
    for (const resolve of this.pendingFileList.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileList.clear();
    for (const resolve of this.pendingFileRoots.values()) resolve([]);
    this.pendingFileRoots.clear();
    for (const resolve of this.pendingTerminalFileLocations.values()) {
      resolve({ ok: false, reason: 'unreadable' });
    }
    this.pendingTerminalFileLocations.clear();
    for (const resolve of this.pendingFileOps.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileOps.clear();
    for (const assembly of this.pendingFileReads.values()) {
      assembly.resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileReads.clear();
    for (const resolve of this.pendingUploadBegins.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingUploadBegins.clear();
    for (const resolve of this.pendingUploadAcks.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingUploadAcks.clear();
    for (const resolve of this.pendingUploadDones.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingUploadDones.clear();
    for (const resolve of this.pendingOpenClawLifecycle.values()) {
      resolve({ ok: false, stderr: 'Connection to EZTerminal lost' });
    }
    this.pendingOpenClawLifecycle.clear();
    for (const resolve of this.pendingOpenClawSessions.values()) resolve([]);
    this.pendingOpenClawSessions.clear();
    for (const resolve of this.pendingOpenClawConfigGet.values()) {
      resolve(Object.fromEntries(OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET])) as OpenClawCoreConfig);
    }
    this.pendingOpenClawConfigGet.clear();
    for (const resolve of this.pendingOpenClawConfigSet.values()) {
      resolve({ ok: false, restartRequired: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingOpenClawConfigSet.clear();
    for (const resolve of this.pendingOpenClawChatTicket.values()) {
      resolve({ ok: false, reason: 'gateway-unreachable' });
    }
    this.pendingOpenClawChatTicket.clear();
  }

  /**
   * A connection attempt ended (real 'close' or watchdog abandon). Idempotent
   * per attempt: only the CURRENT socket ends once — a second call for the same
   * socket (watchdog closed it, then its real 'close' fires) is a no-op, so the
   * backoff/reconnect is never scheduled twice.
   */
  private endConnection(socket: WsLike): void {
    if (this.socket !== socket) return;
    this.clearAllResumeRetries();
    this.clearWatchdog();
    this.setAuthed(false);
    this.socket = null;
    // No frames can arrive for these runs anymore — tell every open block so it
    // doesn't sit showing "running" forever, then drop them (mirrors a real
    // MessagePort going away: no further send/receive).
    // Stable local ports survive transient sockets; the next authenticated
    // generation resumes them against the bridge's bounded run lease.
    this.resolvePendingRequestsUnavailable();
    // OpenClaw availability (M3): a dropped connection can't know the
    // desktop's current mode anymore — reset to "unknown" so a stale `true`
    // doesn't keep an entry point visible while disconnected (mirrors
    // `setAuthed(false)` above, which every effective-visibility consumer
    // already reacts to alongside this).
    if (this.openclawAvailable !== false) {
      this.openclawAvailable = false;
      for (const listener of this.openclawAvailabilityListeners) listener(false);
    }
    if (
      this.stopped
      || this.connectionState === 'auth-rejected'
      || this.connectionState === 'protocol-incompatible'
    ) return;
    this.reconnectAttempts += 1;
    const retryDelay = this.backoffMs;
    this.nextRetryAt = Date.now() + retryDelay;
    this.setConnectionState('reconnecting');
    this.recordConnectionDiagnostic('retry-scheduled');
    this.emitConnectionHealth();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, retryDelay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  /** Request/reply envelopes never enter a pending collection unless they can
   * be written to the current authenticated OPEN socket. A synchronous send
   * failure rolls the registration back before the caller is failed locally,
   * so a later socket generation cannot have a stale waiter steal its reply. */
  private tryStartRequest(
    msg: ClientToServerMessage,
    register: () => void,
    rollback: () => void,
  ): boolean {
    const socket = this.socket;
    if (
      this.stopped
      || !this.authed
      || !socket
      || (socket.readyState !== undefined && socket.readyState !== WS_OPEN)
    ) return false;
    register();
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      rollback();
      return false;
    }
  }

  private tryStartMapRequest<K, V>(
    msg: ClientToServerMessage,
    pending: Map<K, V>,
    key: K,
    value: V,
  ): boolean {
    if (pending.has(key)) return false;
    return this.tryStartRequest(
      msg,
      () => pending.set(key, value),
      () => {
        if (pending.get(key) === value) pending.delete(key);
      },
    );
  }

  private tryStartTimedMapRequest<K, R>(
    msg: ClientToServerMessage,
    pending: Map<K, (result: R) => void>,
    key: K,
    resolve: (result: R) => void,
    timeoutMs: number,
    timeoutResult: R,
  ): boolean {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: R): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve(result);
    };
    const started = this.tryStartMapRequest(msg, pending, key, settle);
    if (!started) return false;
    timer = setTimeout(() => {
      if (pending.get(key) !== settle) return;
      pending.delete(key);
      settle(timeoutResult);
    }, Math.max(0, timeoutMs));
    return true;
  }

  private tryStartFifoRequest<T>(
    msg: ClientToServerMessage,
    pending: T[],
    value: T,
  ): boolean {
    return this.tryStartRequest(
      msg,
      () => pending.push(value),
      () => {
        const index = pending.indexOf(value);
        if (index >= 0) pending.splice(index, 1);
      },
    );
  }

  /** Raw one-way/control path. Auth handshake uses its captured socket
   * directly; release-runs and control semantics intentionally stay unchanged. */
  private send(msg: ClientToServerMessage): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      // A close can race one-way traffic. Request/reply calls use the
      // rollback-aware helpers above; one-way traffic is best-effort and must
      // never prevent disconnect cleanup or escape into the mobile UI.
    }
  }

  private clearResumeRetry(runId: string): void {
    const retry = this.resumeRetries.get(runId);
    if (retry?.timer !== null && retry?.timer !== undefined) clearTimeout(retry.timer);
    this.resumeRetries.delete(runId);
  }

  private clearAllResumeRetries(): void {
    for (const retry of this.resumeRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
    }
    this.resumeRetries.clear();
  }

  private scheduleResumeRetry(record: RunPortRecord, generation: number): void {
    if (!this.authed || generation !== this.generation || this.ports.get(record.runId) !== record) return;

    const previous = this.resumeRetries.get(record.runId);
    if (previous?.generation === generation && previous.timer !== null) return;
    const retry = previous?.generation === generation
      ? previous
      : { generation, attempts: 0, timer: null };

    if (retry.attempts >= RESUME_RETRY_MAX_ATTEMPTS) {
      if (retry.attempts === RESUME_RETRY_MAX_ATTEMPTS) {
        retry.attempts += 1; // exhausted sentinel: do not re-report on duplicate busy replies
        this.resumeRetries.set(record.runId, retry);
        record.port.deliver({ type: 'error', message: 'This run stayed busy and could not be resumed' });
      }
      return;
    }

    const delay = Math.min(RESUME_RETRY_INITIAL_MS * (2 ** retry.attempts), RESUME_RETRY_MAX_MS);
    retry.attempts += 1;
    retry.timer = setTimeout(() => {
      retry.timer = null;
      if (!this.authed || generation !== this.generation || this.ports.get(record.runId) !== record) {
        this.clearResumeRetry(record.runId);
        return;
      }
      this.send({
        kind: 'resume-run',
        sessionId: record.sessionId,
        runId: record.runId,
        generation,
      });
      e2eLog('transport:resume', `generation=${generation}`, `runId=${record.runId}`);
    }, delay);
    this.resumeRetries.set(record.runId, retry);
  }

  /** A protocol mismatch is terminal until the user updates one of the apps. */
  private rejectIncompatibleProtocol(hostVersion?: unknown): void {
    if (typeof hostVersion === 'string' && hostVersion.trim()) this.hostVersion = hostVersion;
    this.remoteCapabilities.clear();
    this.setAuthed(false);
    this.stopped = true;
    this.nextRetryAt = null;
    this.setConnectionState('protocol-incompatible');
    this.recordConnectionDiagnostic('protocol-incompatible');
    this.emitConnectionHealth();
    this.resolvePendingRequestsUnavailable();
    this.closeTerminalSocket();
  }

  /** Close and synchronously invalidate a terminal auth/protocol socket.
   * Browser close events are asynchronous, so waiting for `close` would let
   * already-queued messages mutate state after a fail-closed decision. */
  private closeTerminalSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // endConnection below still invalidates a socket whose close throws.
    }
    this.endConnection(socket);
  }

  private handleServerMessage(data: string): void {
    let msg: ServerToClientMessage;
    try {
      msg = JSON.parse(data) as ServerToClientMessage;
    } catch {
      return;
    }
    if (this.stopped) return;
    if (!this.authed && msg.kind !== 'auth-ok' && msg.kind !== 'auth-fail') return;
    switch (msg.kind) {
      case 'auth-ok':
        if (
          msg.protocolVersion !== REMOTE_PROTOCOL_VERSION
          || typeof msg.hostVersion !== 'string'
          || msg.hostVersion.trim().length === 0
        ) {
          this.rejectIncompatibleProtocol(msg.hostVersion);
          break;
        }
        if (this.authed) break;
        this.hostVersion = msg.hostVersion;
        this.hostBuildSha = typeof msg.hostBuildSha === 'string' && msg.hostBuildSha.trim()
          ? msg.hostBuildSha
          : 'unknown';
        this.remoteCapabilities = new Set(
          Array.isArray(msg.capabilities)
            ? msg.capabilities.filter(
                (capability): capability is RemoteCapability => (
                  capability === REMOTE_CAPABILITY_QUICK_COMMANDS_READ
                ),
              )
            : [],
        );
        this.clearAllResumeRetries();
        this.clearWatchdog(); // connected — this attempt is no longer "stuck"
        {
          const isReconnect = this.everAuthed;
          this.everAuthed = true;
          this.generation += 1;
          this.reconnectAttempts = 0;
          this.nextRetryAt = null;
          this.lastConnectedAt = Date.now();
          this.setAuthed(true);
          this.setConnectionState('connected');
          this.recordConnectionDiagnostic('connected');
          this.emitConnectionHealth();
          e2eLog(
            isReconnect ? 'transport:reconnect' : 'transport:connected',
            `generation=${this.generation}`,
            `appVersion=${this.buildInfo.appVersion}`,
            `buildSha=${this.buildInfo.buildSha}`,
          );
          if (isReconnect) {
            const records = [...this.ports.values()].sort((a, b) => {
              const aPriority = a.sessionId === this.reattachPrioritySessionId ? 0 : 1;
              const bPriority = b.sessionId === this.reattachPrioritySessionId ? 0 : 1;
              return aPriority - bPriority;
            });
            for (const record of records) {
              this.send({
                kind: 'resume-run',
                sessionId: record.sessionId,
                runId: record.runId,
                generation: this.generation,
              });
              e2eLog(
                'transport:resume',
                `generation=${this.generation}`,
                `runId=${record.runId}`,
              );
            }
          }
        }
        // A fully successful (re)connect resets the backoff — a flappy link
        // that keeps briefly reconnecting shouldn't creep toward the cap.
        this.backoffMs = this.initialBackoffMs;
        // Replay the stats subscription across reconnects — the bridge's own
        // `statsVisible` is per-connection state that does NOT survive a new
        // socket (see `setStatsPanelVisible`'s doc comment).
        if (this.statsVisible) this.send({ kind: 'stats-visible', visible: true });
        // Same replay for packets — NO second `_ezPacketPort` handoff: the
        // existing `packetPort` (if any) is reused, and the server's
        // `PacketMirror` replays the current status on its own.
        if (this.packetsSubscribed) this.send({ kind: 'packets-subscribe' });
        // OpenClaw management (M4): same replay shape for status/logs.
        if (this.openclawStatusRefcount > 0) this.send({ kind: 'openclaw-status-subscribe' });
        if (this.openclawLogsSubscribed) this.send({ kind: 'openclaw-logs-subscribe' });
        break;
      case 'auth-fail':
        if (msg.reason === 'incompatible-protocol') {
          this.rejectIncompatibleProtocol(msg.hostVersion);
          break;
        }
        this.remoteCapabilities.clear();
        this.setAuthed(false);
        this.stopped = true;
        this.nextRetryAt = null;
        this.setConnectionState('auth-rejected');
        this.recordConnectionDiagnostic('auth-rejected');
        this.emitConnectionHealth();
        this.resolvePendingRequestsUnavailable();
        this.closeTerminalSocket();
        break;
      case 'session-created': {
        const pending = this.pendingCreates.get(msg.requestId);
        if (pending) {
          this.pendingCreates.delete(msg.requestId);
          pending.resolve(msg.session);
        }
        break;
      }
      case 'quick-commands-list-reply': {
        const resolve = this.pendingQuickCommands.get(msg.requestId);
        this.pendingQuickCommands.delete(msg.requestId);
        if (!resolve) break;
        if (!msg.ok) {
          resolve({ ok: false, error: 'unavailable' });
          break;
        }
        const commands = msg.commands
          .slice(0, MAX_QUICK_COMMANDS)
          .flatMap((command) => {
            const parsed = QuickCommandSchema.safeParse(command);
            return parsed.success ? [parsed.data] : [];
          });
        resolve({ ok: true, commands });
        break;
      }
      case 'session-destroy-result':
        this.pendingGuardedDestroys.get(msg.requestId)?.(msg.result);
        this.pendingGuardedDestroys.delete(msg.requestId);
        break;
      case 'session-list':
        this.pendingListSessions.shift()?.(msg.sessions);
        break;
      case 'run-list':
        this.pendingListRuns.shift()?.(msg.runs);
        break;
      case 'frame': {
        const record = this.ports.get(msg.runId);
        if (!record) break;
        const frame = decodeFrame(msg.frame);
        if (frame.type === 'worktree-open') {
          if (record.initiatedHere && this.acceptWorktreeOpenIntent(frame.intentId)) {
            this.emitWorktreeOpen(frame.worktree);
          }
          break;
        }
        record.port.deliver(frame);
        break;
      }
      case 'resume-run-ready': {
        if (msg.generation !== this.generation) break;
        const record = this.ports.get(msg.runId);
        if (!record || record.sessionId !== msg.sessionId) break;
        this.clearResumeRetry(msg.runId);
        record.port.deliver({ type: 'pty-replay-reset' });
        break;
      }
      case 'resume-run-busy': {
        if (msg.generation !== this.generation) break;
        const record = this.ports.get(msg.runId);
        if (!record || record.sessionId !== msg.sessionId) break;
        if (msg.retryable) {
          this.scheduleResumeRetry(record, msg.generation);
          break;
        }
        this.clearResumeRetry(msg.runId);
        this.ports.delete(msg.runId);
        record.port.deliver({
          type: 'error',
          message: msg.reason === 'unsupported'
            ? 'Active SSH runs cannot be resumed on this device'
            : 'This run could not be resumed',
        });
        record.port.close();
        break;
      }
      case 'resume-run-missing': {
        if (msg.generation !== this.generation) break;
        const record = this.ports.get(msg.runId);
        if (!record || record.sessionId !== msg.sessionId) break;
        this.clearResumeRetry(msg.runId);
        this.ports.delete(msg.runId);
        record.port.deliver({ type: 'error', message: 'This run expired before it could be resumed' });
        record.port.close();
        break;
      }
      case 'session-dead':
        for (const listener of this.sessionDeadListeners) listener({ logPath: msg.logPath });
        break;
      case 'session-added':
        for (const listener of this.sessionAddedListeners) listener(msg.session);
        break;
      case 'session-removed':
        for (const listener of this.sessionRemovedListeners) listener(msg.sessionId);
        break;
      case 'run-started':
        for (const listener of this.runStartedListeners) {
          listener({
            sessionId: msg.sessionId,
            runId: msg.runId,
            commandText: msg.commandText,
            executionKind: msg.executionKind,
          });
        }
        break;
      case 'agent-snapshot': {
        const accept = this.awaitingAgentSeed || msg.snapshot.revision > this.agentSnapshot.revision;
        this.awaitingAgentSeed = false;
        if (accept) {
          this.agentSnapshot = msg.snapshot;
          for (const listener of this.agentSnapshotListeners) listener(msg.snapshot);
        }
        if (msg.requestId) {
          this.pendingAgentSnapshots.get(msg.requestId)?.(this.agentSnapshot);
          this.pendingAgentSnapshots.delete(msg.requestId);
        }
        break;
      }
      case 'agent-followup-reply':
        this.pendingAgentFollowups.get(msg.requestId)?.(msg.result);
        this.pendingAgentFollowups.delete(msg.requestId);
        break;
      case 'stats-update':
        for (const listener of this.statsListeners) listener(msg.snapshot);
        break;
      case 'stats-history':
        this.pendingStatsHistory.shift()?.(msg.snapshots);
        break;
      case 'worktree-reply': {
        const pending = this.pendingWorktrees.get(msg.requestId);
        if (pending?.action === 'open' && msg.result.ok && msg.result.action === 'open' && msg.result.opened) {
          this.emitWorktreeOpen(msg.result.opened);
        }
        pending?.resolve(msg.result);
        this.pendingWorktrees.delete(msg.requestId);
        break;
      }
      case 'packet-frame':
        this.packetPort?.deliver(msg.frame);
        break;

      case 'file-list-reply':
        this.pendingFileList.get(msg.requestId)?.(msg.result);
        this.pendingFileList.delete(msg.requestId);
        break;

      case 'file-roots-reply':
        this.pendingFileRoots.get(msg.requestId)?.([...msg.roots]);
        this.pendingFileRoots.delete(msg.requestId);
        break;

      case 'terminal-file-location-reply':
        this.pendingTerminalFileLocations.get(msg.requestId)?.(msg.result);
        this.pendingTerminalFileLocations.delete(msg.requestId);
        break;

      case 'file-op-reply':
        this.pendingFileOps.get(msg.requestId)?.(msg.result);
        this.pendingFileOps.delete(msg.requestId);
        break;

      case 'file-read-meta': {
        const assembly = this.pendingFileReads.get(msg.requestId);
        if (!assembly) break;
        if (!msg.ok) {
          this.pendingFileReads.delete(msg.requestId);
          assembly.resolve({ ok: false, error: msg.error });
          break;
        }
        if (msg.sendBytes <= 0) {
          // Binary file in 'text' mode (or a genuinely empty file) — no
          // chunk ever follows (remote-protocol.ts's streaming contract).
          this.pendingFileReads.delete(msg.requestId);
          assembly.resolve({
            ok: true,
            fileSize: msg.fileSize,
            isText: msg.isText,
            truncated: msg.truncated,
            bytes: new Uint8Array(0),
            ...(msg.preview ? { preview: msg.preview } : {}),
          });
          break;
        }
        assembly.buffer = new Uint8Array(msg.sendBytes);
        assembly.fileSize = msg.fileSize;
        assembly.isText = msg.isText;
        assembly.truncated = msg.truncated;
        assembly.preview = msg.preview ?? null;
        break;
      }

      case 'file-read-chunk': {
        const assembly = this.pendingFileReads.get(msg.requestId);
        if (!assembly || !assembly.buffer) break;
        const data = base64ToUint8Array(msg.data);
        assembly.buffer.set(data, msg.offset);
        const received = msg.offset + data.length;
        assembly.onProgress?.(received, assembly.buffer.length);
        if (msg.done) {
          this.pendingFileReads.delete(msg.requestId);
          assembly.resolve({
            ok: true,
            fileSize: assembly.fileSize,
            isText: assembly.isText,
            truncated: assembly.truncated,
            bytes: assembly.buffer,
            ...(assembly.preview ? { preview: assembly.preview } : {}),
          });
        } else {
          this.send({ kind: 'file-read-ack', requestId: msg.requestId, offset: received });
        }
        break;
      }

      case 'file-upload-begin-reply': {
        const resolve = this.pendingUploadBegins.get(msg.requestId);
        this.pendingUploadBegins.delete(msg.requestId);
        resolve?.(msg.ok ? { ok: true, uploadId: msg.uploadId, finalName: msg.finalName } : { ok: false, error: msg.error });
        break;
      }

      case 'file-upload-ack': {
        const resolve = this.pendingUploadAcks.get(msg.uploadId);
        this.pendingUploadAcks.delete(msg.uploadId);
        resolve?.(msg.ok ? { ok: true, receivedBytes: msg.receivedBytes } : { ok: false, error: msg.error });
        break;
      }

      case 'file-upload-done': {
        const resolve = this.pendingUploadDones.get(msg.uploadId);
        this.pendingUploadDones.delete(msg.uploadId);
        resolve?.(msg.ok ? { ok: true, finalName: msg.finalName } : { ok: false, error: msg.error });
        break;
      }

      case 'openclaw-status':
        for (const listener of this.openclawStatusListeners) listener(msg.status);
        break;

      case 'openclaw-availability':
        this.openclawAvailable = msg.visible;
        for (const listener of this.openclawAvailabilityListeners) listener(msg.visible);
        break;

      case 'openclaw-lifecycle-result': {
        const resolve = this.pendingOpenClawLifecycle.get(msg.requestId);
        this.pendingOpenClawLifecycle.delete(msg.requestId);
        resolve?.(msg.result);
        break;
      }

      case 'openclaw-log-lines':
        for (const listener of this.openclawLogListeners) listener(msg.lines);
        break;

      case 'openclaw-sessions-reply': {
        const resolve = this.pendingOpenClawSessions.get(msg.requestId);
        this.pendingOpenClawSessions.delete(msg.requestId);
        resolve?.(msg.sessions);
        break;
      }

      case 'openclaw-config-reply': {
        const resolve = this.pendingOpenClawConfigGet.get(msg.requestId);
        this.pendingOpenClawConfigGet.delete(msg.requestId);
        resolve?.(msg.config);
        break;
      }

      case 'openclaw-config-set-reply': {
        const resolve = this.pendingOpenClawConfigSet.get(msg.requestId);
        this.pendingOpenClawConfigSet.delete(msg.requestId);
        resolve?.(msg.result);
        break;
      }

      case 'openclaw-chat-ticket-reply': {
        const resolve = this.pendingOpenClawChatTicket.get(msg.requestId);
        this.pendingOpenClawChatTicket.delete(msg.requestId);
        const reply = msg as typeof msg & { readonly reason?: unknown };
        if (msg.ticket && msg.token && msg.proxyPort > 0) {
          resolve?.({ ok: true, ticket: msg.ticket, proxyPort: msg.proxyPort, token: msg.token });
        } else {
          resolve?.({
            ok: false,
            reason: isOpenClawChatFailureReason(reply.reason) ? reply.reason : 'proxy-unavailable',
          });
        }
        break;
      }
    }
  }

  /** Test/debug seam: is the current socket authenticated? */
  get isAuthed(): boolean {
    return this.authed;
  }

  get currentConnectionState(): RemoteConnectionState {
    return this.connectionState;
  }

  /** The hostname this transport is dialing (no scheme/port) — the chat tab
   * (M5) derives the OpenClaw proxy's origin from it: same host, a different
   * port (see `getOpenClawChatTicket()`'s doc). Empty string if `url` doesn't
   * parse as `ws(s)://host[:port]`. */
  get connectedHost(): string {
    try {
      const parsed = new URL(this.url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return '';
      return parsed.hostname;
    } catch {
      return '';
    }
  }
}
