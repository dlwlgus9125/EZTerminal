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
  RuntimeVersions,
  SessionInfo,
  SystemStatsSnapshot,
} from '../../../src/shared/ipc';
import type { FileListResult, FileOpResult, FileReadTextResult } from '../../../src/shared/files';
import type { StartupPref, ThemeName } from '../../../src/shared/layout-schema';
import {
  decodeFrame,
  type ClientToServerMessage,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../../../src/shared/remote-protocol';

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
  private readonly sessionDeadListeners = new Set<(info?: { logPath?: string | null }) => void>();
  /** Mobile-only (M2 ConnectScreen): fires on every authed transition, including
   * an immediate replay of the CURRENT state to a listener that just subscribed. */
  private readonly authListeners = new Set<(authed: boolean) => void>();

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

  // ── File explorer (file-explorer plan) — stubs for M1, real impls in M4 ───
  // `EzTerminalApi` grew these members in M1 to unblock the desktop drawer;
  // the mobile browser/viewer over the WS bridge's `file-*` messages doesn't
  // land until M4, so these reject rather than silently no-op.
  listFiles(): Promise<FileListResult> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  listFileRoots(): Promise<string[]> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  readTextFile(): Promise<FileReadTextResult> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  createFolder(): Promise<FileOpResult> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  renameFile(): Promise<FileOpResult> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  trashFile(): Promise<FileOpResult> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  openFileInApp(): Promise<void> {
    return Promise.reject(new Error('files: not supported yet'));
  }
  revealFileInExplorer(): Promise<void> {
    return Promise.reject(new Error('files: not supported yet'));
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
      case 'frame': {
        const port = this.ports.get(msg.runId);
        port?.deliver(decodeFrame(msg.frame));
        break;
      }
      case 'session-dead':
        for (const listener of this.sessionDeadListeners) listener({ logPath: msg.logPath });
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
    }
  }

  /** Test/debug seam: is the current socket authenticated? */
  get isAuthed(): boolean {
    return this.authed;
  }
}
