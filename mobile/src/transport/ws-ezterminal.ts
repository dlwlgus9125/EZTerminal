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
import type {
  EzTerminalApi,
  InterpreterFrame,
  RemoteConnectionInfo,
  RendererControl,
  RunStartedInfo,
  RuntimeVersions,
  SessionInfo,
  SystemStatsSnapshot,
} from '../../../src/shared/ipc';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult, type FileReadTextResult } from '../../../src/shared/files';
import type { StartupPref, ThemeName } from '../../../src/shared/layout-schema';
import {
  base64ToUint8Array,
  decodeFrame,
  uint8ArrayToBase64,
  type ClientToServerMessage,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../../../src/shared/remote-protocol';
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

/** Generic result of one `file-read` round trip (M4) — `readTextFile`/
 * `downloadFile` each reshape this into their own public return type. */
type FileReadResult =
  | { readonly ok: true; readonly fileSize: number; readonly isText: boolean; readonly truncated: boolean; readonly bytes: Uint8Array }
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
export interface OpenClawChatTicket {
  readonly ticket: string | null;
  readonly proxyPort: number;
  readonly token: string | null;
}

// ── DI seam over the browser `WebSocket` (real instances satisfy this
//    structurally; tests inject a fake) ──────────────────────────────────────

export interface WsLike {
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
  /** Test seam: defaults to the real browser `WebSocket`. */
  readonly createSocket?: CreateSocket;
  /** Test seam: defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Test seam: how long an attempt may stay un-authed before retry. */
  readonly authTimeoutMs?: number;
}

export class WsEzTerminalTransport implements EzTerminalApi {
  /** Not meaningful for a remote WS client — no local Electron/Chrome/Node process. */
  readonly versions: RuntimeVersions = { electron: 'n/a', chrome: 'n/a', node: 'n/a' };

  private readonly url: string;
  private readonly token: string;
  private readonly createSocket: CreateSocket;
  private readonly newId: () => string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly authTimeoutMs: number;

  private socket: WsLike | null = null;
  private authed = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-attempt auth watchdog — self-heals a stuck/half-open connection. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly ports = new Map<string, FakeMessagePort>();
  private readonly pendingCreates = new Map<
    string,
    { resolve: (session: SessionInfo) => void; reject: (err: Error) => void }
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

  // Session mirroring (M2): full mirroring across desktop tabs + mobile. These
  // three broadcasts are origin-agnostic (fire for sessions/runs THIS
  // connection itself started too, same as desktop's ipc.ts) — the caller
  // self-filters, it already has the id from its own local call.
  private readonly sessionAddedListeners = new Set<(session: SessionInfo) => void>();
  private readonly sessionRemovedListeners = new Set<(sessionId: string) => void>();
  private readonly runStartedListeners = new Set<(info: RunStartedInfo) => void>();

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
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.backoffMs = this.initialBackoffMs;
    this.connect();
  }

  /** Stop reconnecting and close the live socket (app backgrounding/teardown). */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    this.socket?.close();
    this.socket = null;
  }

  /** Mobile-only (not part of `EzTerminalApi`): drives the SessionSwitcher drawer (M2). */
  listSessions(): Promise<readonly SessionInfo[]> {
    return new Promise((resolve) => {
      this.pendingListSessions.push(resolve);
      this.send({ kind: 'list-sessions' });
    });
  }

  // ── EzTerminalApi ─────────────────────────────────────────────────────────

  createSession(cwd?: string): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const requestId = this.newId();
      this.pendingCreates.set(requestId, { resolve, reject });
      this.send({ kind: 'create-session', requestId, cwd });
    });
  }

  destroySession(sessionId: string): void {
    this.send({ kind: 'destroy-session', sessionId });
  }

  runCommand(commandText: string, runId: string, sessionId: string): Promise<void> {
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId, control });
    });
    this.ports.set(runId, port);
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
      this.pendingListRuns.push(resolve);
      this.send({ kind: 'list-runs' });
    });
  }

  /** Mirrors `runCommand`'s `_ezAttachPort` handoff (see its doc + module doc)
   * — same `FakeMessagePort`/`ports` map, keyed by `runId` regardless of
   * whether this connection is the run's initiator or an attacher, since
   * `frame` messages carry only `runId` either way. */
  attachRun(sessionId: string, runId: string): Promise<void> {
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId, control });
    });
    this.ports.set(runId, port);
    this.send({ kind: 'attach-run', sessionId, runId });
    const event = new MessageEvent('message', { data: { _ezAttachPort: runId }, source: window });
    Object.defineProperty(event, 'ports', { value: [port], enumerable: true, configurable: true });
    window.dispatchEvent(event);
    return Promise.resolve();
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
      this.pendingStatsHistory.push((snapshots) => resolve([...snapshots]));
      this.send({ kind: 'stats-history' });
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
      this.pendingOpenClawLifecycle.set(requestId, resolve);
      this.send({ kind: 'openclaw-lifecycle', requestId, action });
    });
  }

  getOpenClawSessions(): Promise<readonly OpenClawAgentSession[]> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingOpenClawSessions.set(requestId, resolve);
      this.send({ kind: 'openclaw-sessions-get', requestId });
    });
  }

  getOpenClawConfig(): Promise<OpenClawCoreConfig> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingOpenClawConfigGet.set(requestId, resolve);
      this.send({ kind: 'openclaw-config-get', requestId });
    });
  }

  setOpenClawConfig(key: string, value: string): Promise<OpenClawSetConfigResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingOpenClawConfigSet.set(requestId, resolve);
      this.send({ kind: 'openclaw-config-set', requestId, key, value });
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
      this.pendingOpenClawChatTicket.set(requestId, resolve);
      this.send({ kind: 'openclaw-chat-ticket', requestId });
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
  setRemoteEnabled(): Promise<boolean> {
    return Promise.resolve(true);
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
      this.pendingFileList.set(requestId, resolve);
      this.send({ kind: 'file-list', requestId, path });
    });
  }

  listFileRoots(): Promise<string[]> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingFileRoots.set(requestId, resolve);
      this.send({ kind: 'file-roots', requestId });
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

  createFolder(dirPath: string, name: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingFileOps.set(requestId, resolve);
      this.send({ kind: 'file-mkdir', requestId, dirPath, name });
    });
  }

  renameFile(path: string, newName: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingFileOps.set(requestId, resolve);
      this.send({ kind: 'file-rename', requestId, path, newName });
    });
  }

  trashFile(path: string): Promise<FileOpResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingFileOps.set(requestId, resolve);
      this.send({ kind: 'file-trash', requestId, path });
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
      this.pendingUploadBegins.set(requestId, resolve);
      this.send({ kind: 'file-upload-begin', requestId, dirPath, name, size: bytes.length });
    });
    if (!begin.ok) throw new Error(begin.error);
    const { uploadId } = begin;

    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, bytes.length));
      const ack = await new Promise<UploadAckResult>((resolve) => {
        this.pendingUploadAcks.set(uploadId, resolve);
        this.send({ kind: 'file-upload-chunk', uploadId, offset, data: uint8ArrayToBase64(chunk) });
      });
      if (!ack.ok) throw new Error(ack.error);
      offset += chunk.length;
      onProgress(offset);
    }

    const done = await new Promise<UploadDoneResult>((resolve) => {
      this.pendingUploadDones.set(uploadId, resolve);
      this.send({ kind: 'file-upload-commit', uploadId });
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
    mode: 'text' | 'raw',
    onProgress?: (received: number, total: number) => void,
  ): Promise<FileReadResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      this.pendingFileReads.set(requestId, {
        buffer: null,
        fileSize: 0,
        isText: true,
        truncated: false,
        onProgress,
        resolve,
      });
      this.send({ kind: 'file-read', requestId, path, mode });
    });
  }

  // ── connection lifecycle ─────────────────────────────────────────────────

  private connect(): void {
    const socket = this.createSocket(this.url);
    this.socket = socket;
    // Bound this attempt: if it doesn't reach `auth-ok` in time (never opened,
    // or opened but the auth round-trip stalled — a half-open link never fires
    // 'close'), abandon it and let the backoff loop try a fresh socket.
    this.armWatchdog(socket);
    // Every handler is guarded by `this.socket === socket`, so a late event
    // from a socket we already superseded (watchdog fired, then its real
    // 'close' arrives) is a no-op instead of corrupting the newer attempt.
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ kind: 'auth', token: this.token } satisfies ClientToServerMessage));
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

  /**
   * A connection attempt ended (real 'close' or watchdog abandon). Idempotent
   * per attempt: only the CURRENT socket ends once — a second call for the same
   * socket (watchdog closed it, then its real 'close' fires) is a no-op, so the
   * backoff/reconnect is never scheduled twice.
   */
  private endConnection(socket: WsLike): void {
    if (this.socket !== socket) return;
    this.clearWatchdog();
    this.setAuthed(false);
    this.socket = null;
    // No frames can arrive for these runs anymore — tell every open block so it
    // doesn't sit showing "running" forever, then drop them (mirrors a real
    // MessagePort going away: no further send/receive).
    for (const port of this.ports.values()) {
      port.deliver({ type: 'error', message: 'Connection to EZTerminal lost' });
    }
    this.ports.clear();
    // M1 mirror-active-runs: no reply is ever coming for these now — resolve
    // every in-flight `listRuns()` call with `[]` rather than leaving it
    // pending forever (mirrors the file-explorer pending drains below; the
    // pre-existing `pendingListSessions` hang-on-close is untouched — a
    // separate, already-known issue, see remote-protocol.ts's module doc).
    for (const resolve of this.pendingListRuns) resolve([]);
    this.pendingListRuns.length = 0;
    // File explorer (M4): no reply is ever coming for these now — resolve
    // every in-flight request rather than leaving its promise pending forever.
    for (const resolve of this.pendingFileList.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileList.clear();
    for (const resolve of this.pendingFileRoots.values()) resolve([]);
    this.pendingFileRoots.clear();
    for (const resolve of this.pendingFileOps.values()) {
      resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileOps.clear();
    for (const assembly of this.pendingFileReads.values()) {
      assembly.resolve({ ok: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingFileReads.clear();
    // Upload (M5): same "resolve with a connection-lost result" treatment —
    // `uploadFile` throws on `ok:false`, which is what rejects its promise.
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
    // OpenClaw management (M4): same "resolve with a connection-lost result"
    // treatment as the file/upload maps above — never left pending forever.
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
    for (const resolve of this.pendingOpenClawChatTicket.values()) resolve({ ticket: null, proxyPort: 0, token: null });
    this.pendingOpenClawChatTicket.clear();
    // OpenClaw availability (M3): a dropped connection can't know the
    // desktop's current mode anymore — reset to "unknown" so a stale `true`
    // doesn't keep an entry point visible while disconnected (mirrors
    // `setAuthed(false)` above, which every effective-visibility consumer
    // already reacts to alongside this).
    if (this.openclawAvailable !== false) {
      this.openclawAvailable = false;
      for (const listener of this.openclawAvailabilityListeners) listener(false);
    }
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private send(msg: ClientToServerMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private handleServerMessage(data: string): void {
    let msg: ServerToClientMessage;
    try {
      msg = JSON.parse(data) as ServerToClientMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'auth-ok':
        this.clearWatchdog(); // connected — this attempt is no longer "stuck"
        this.setAuthed(true);
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
        this.setAuthed(false);
        break;
      case 'session-created': {
        const pending = this.pendingCreates.get(msg.requestId);
        if (pending) {
          this.pendingCreates.delete(msg.requestId);
          pending.resolve(msg.session);
        }
        break;
      }
      case 'session-list':
        this.pendingListSessions.shift()?.(msg.sessions);
        break;
      case 'run-list':
        this.pendingListRuns.shift()?.(msg.runs);
        break;
      case 'frame': {
        const port = this.ports.get(msg.runId);
        port?.deliver(decodeFrame(msg.frame));
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
          listener({ sessionId: msg.sessionId, runId: msg.runId, commandText: msg.commandText });
        }
        break;
      case 'stats-update':
        for (const listener of this.statsListeners) listener(msg.snapshot);
        break;
      case 'stats-history':
        this.pendingStatsHistory.shift()?.(msg.snapshots);
        break;
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
          });
          break;
        }
        assembly.buffer = new Uint8Array(msg.sendBytes);
        assembly.fileSize = msg.fileSize;
        assembly.isText = msg.isText;
        assembly.truncated = msg.truncated;
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
        resolve?.({ ticket: msg.ticket, proxyPort: msg.proxyPort, token: msg.token });
        break;
      }
    }
  }

  /** Test/debug seam: is the current socket authenticated? */
  get isAuthed(): boolean {
    return this.authed;
  }

  /** The hostname this transport is dialing (no scheme/port) — the chat tab
   * (M5) derives the OpenClaw proxy's origin from it: same host, a different
   * port (see `getOpenClawChatTicket()`'s doc). Empty string if `url` doesn't
   * parse as `ws(s)://host[:port]`. */
  get connectedHost(): string {
    return this.url.match(/^wss?:\/\/([^/:?#]+)/i)?.[1] ?? '';
  }
}
