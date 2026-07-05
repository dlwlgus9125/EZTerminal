/**
 * Shared IPC contract: main ↔ preload ↔ renderer ↔ interpreter (utilityProcess).
 *
 * T1 vertical slice: Renderer → main broker → utilityProcess interpreter →
 * framed streaming back via dedicated MessagePort → renderer. (architecture §3)
 */
import type { LayoutEnvelope, StartupPref, ThemeName } from './layout-schema';
import type { FileListResult, FileOpResult, FileReadTextResult } from './files';

/** The single key under which the preload bridge is exposed on `window`. */
export const BRIDGE_KEY = 'ezterminal' as const;

/** Runtime version strings, surfaced by the preload (no IPC round-trip). */
export interface RuntimeVersions {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

// ── Interpreter → Renderer frames ────────────────────────────────────────────
// Each command gets its own dedicated MessagePort. Interpreter sends these
// frames over it. Chunks are BATCHED arrays of rows — never one-message-per-row,
// and only the rows the renderer asked for (credit/backpressure, architecture §3).

/** A JSON-serializable value carried in result rows. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One result row: a flat map of column name -> JSON value. */
export type ResultRow = { [key: string]: JsonValue };

/** Column metadata: the column name + its value-kind tag. */
export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
}

export interface StartFrame {
  readonly type: 'start';
  /** Echoes back the raw command text for correlation. */
  readonly commandText: string;
  /**
   * Session cwd when the command STARTED — the terminal-style prompt path for this
   * block. Optional/additive: older frames without it fall back to a bare prompt.
   */
  readonly cwd?: string;
}

/** How a block's output should be rendered. */
export type ResultShape = 'table' | 'text' | 'pty';

/** Sent once, before any chunk, describing the result columns + render shape. */
export interface SchemaFrame {
  readonly type: 'schema';
  readonly columns: readonly ColumnInfo[];
  /**
   * `table` → virtualized grid; `text` → simple text block (scalars / external
   * text); `pty` → live xterm.js terminal (Phase 2 TUI). For `pty`, `columns` is
   * empty and rows/chunks are never used — output arrives as `pty-data` frames.
   */
  readonly shape: ResultShape;
}

/**
 * A window of rows answered for a `requestRows`/`setViewport` control. `start` is
 * the absolute index of `rows[0]` within the full result, so the renderer can
 * place the window correctly without holding the whole result.
 */
export interface ChunkFrame {
  readonly type: 'chunk';
  /** Absolute index of the first row in `rows`. */
  readonly start: number;
  /** Batched result rows for this window. Never send one message per row. */
  readonly rows: readonly ResultRow[];
}

/**
 * Running row total + completion. Sent as the ResultStore fills so the renderer
 * knows how tall the (virtualized) table is without receiving the rows. `done`
 * flips true once the source is exhausted.
 */
export interface ProgressFrame {
  readonly type: 'progress';
  readonly count: number;
  readonly done: boolean;
}

export interface EndFrame {
  readonly type: 'end';
  /**
   * Session cwd AFTER the command ran — reflects a `cd` so the renderer's live
   * prompt updates. Optional/additive (older frames simply omit it).
   */
  readonly cwd?: string;
}

export interface ErrorFrame {
  readonly type: 'error';
  readonly message: string;
}

export interface CancelledFrame {
  readonly type: 'cancelled';
}

/**
 * Raw PTY output bytes for a `pty`-shape block (Phase 2 TUI). Streamed straight
 * to the renderer's xterm instance via `term.write()` — it BYPASSES the
 * ResultStore/credit-window/chunk machinery entirely (xterm owns its scrollback).
 * Carries node-pty's natural flush-sized chunks (not per-byte). `data` is
 * structured-cloned over the MessagePort (not a zero-copy transfer).
 */
export interface PtyDataFrame {
  readonly type: 'pty-data';
  readonly data: Uint8Array;
}

/**
 * A pre-channel `ssh-connect` (E5) prompt: the renderer must collect a secret
 * or a host-key decision before the runner can proceed. Sent BEFORE `schema`
 * (the block has no shape yet) — Block.tsx renders this as an inline prompt
 * card. Routed straight over the per-command port (never through main), so a
 * password/passphrase is never logged or persisted. `fingerprint`/`host` are
 * present for `kind:'hostkey'` only.
 */
export interface SshPromptFrame {
  readonly type: 'ssh-prompt';
  readonly promptId: string;
  readonly kind: 'password' | 'passphrase' | 'hostkey';
  readonly message: string;
  readonly fingerprint?: string;
  readonly host?: string;
}

/**
 * Adaptive-render upgrade signal (Phase 3): sent AT MOST ONCE per `pty`-shape
 * block, either immediately after `schema` (forced full xterm via `!cmd`) or
 * mid-stream once the interpreter's TuiSignalDetector recognizes a high-
 * confidence TUI signal (alt-screen, bracketed paste, mouse/focus tracking, or
 * app-cursor-keys — see pty-session.ts). The renderer mounts xterm.js and
 * replays everything buffered so far; the upgrade is irreversible — a block
 * never downgrades back to plain render once this frame arrives.
 */
export interface PtyRenderUpgradeFrame {
  readonly type: 'pty-render-upgrade';
}

/** Discriminated union of all frames sent from interpreter to renderer. */
export type InterpreterFrame =
  | StartFrame
  | SchemaFrame
  | ChunkFrame
  | ProgressFrame
  | EndFrame
  | ErrorFrame
  | CancelledFrame
  | PtyDataFrame
  | SshPromptFrame
  | PtyRenderUpgradeFrame;

// ── Renderer → Interpreter control ───────────────────────────────────────────

export interface CancelControl {
  readonly type: 'cancel';
}

/** Fetch exactly the [start, start+count) window — answered with a `chunk`. */
export interface RequestRowsControl {
  readonly type: 'requestRows';
  readonly start: number;
  readonly count: number;
}

/**
 * The renderer's current viewport. Answered with a `chunk` for that window and
 * warms the store a little past it (read-ahead) so scrolling stays smooth.
 */
export interface SetViewportControl {
  readonly type: 'setViewport';
  readonly start: number;
  readonly count: number;
}

/** Dispose the block: stop filling, release the source, close the port. */
export interface CloseControl {
  readonly type: 'close';
}

/**
 * Keystrokes (or pasted text) from a focused `pty` block's xterm, forwarded to
 * the PTY child's stdin (Phase 2 TUI). `data` is xterm's `onData` payload.
 */
export interface PtyInputControl {
  readonly type: 'pty-input';
  readonly data: string;
}

/**
 * The `pty` block's terminal dimensions (from xterm's FitAddon), forwarded to
 * `pty.resize()` (the ConPTY equivalent of SIGWINCH). The interpreter clamps to
 * a sane range before applying.
 */
export interface PtyResizeControl {
  readonly type: 'pty-resize';
  readonly cols: number;
  readonly rows: number;
}

/**
 * PTY backpressure ack (Stage C): CUMULATIVE count of pty-data bytes the
 * renderer's xterm has actually flushed (term.write callback), sent every
 * ~64KiB. The interpreter pauses the PTY when sent-minus-acked exceeds its
 * high-water mark and resumes below the low-water mark — the byte analogue of
 * the row credit window (design: docs/design/pty-backpressure-design.md §2).
 * Cumulative (not delta) so a lost/duplicated message can never corrupt state.
 */
export interface PtyAckControl {
  readonly type: 'pty-ack';
  readonly bytes: number;
}

/**
 * The renderer's answer to an `ssh-prompt` (E5). `value` carries the typed
 * secret for `password`/`passphrase`; `accept` carries the user's decision for
 * `hostkey`. Cancelling the block (or the block closing) while a prompt is
 * outstanding is handled by the existing `cancel`/`close` controls — this
 * control ONLY ever answers the specific `promptId` it names (a stale/unknown
 * id, e.g. a duplicate or late answer to an already-resolved prompt, is a
 * silent no-op — see ssh-session.ts).
 */
export interface SshPromptResponseControl {
  readonly type: 'ssh-prompt-response';
  readonly promptId: string;
  readonly value?: string;
  readonly accept?: boolean;
}

/** Discriminated union of all control messages sent from renderer to interpreter. */
export type RendererControl =
  | CancelControl
  | RequestRowsControl
  | SetViewportControl
  | CloseControl
  | PtyInputControl
  | PtyResizeControl
  | PtyAckControl
  | SshPromptResponseControl;

// ── Main ↔ Interpreter (utilityProcess) messages ─────────────────────────────
// The interpreter owns the Map<sessionId, SessionRecord>. Sessions are created
// ONLY via `create-session` (never lazily on `run`), so a `run` for an unknown or
// destroyed session is rejected — not silently resurrected (Codex B1).

/** Run a command in an EXISTING session. Carries the dedicated port as transfer. */
export interface RunMessage {
  readonly type: 'run';
  readonly commandText: string;
  /** The session this run executes in. Must already exist (create-session first). */
  readonly sessionId: string;
  /** Caller-minted id naming this run (M2 mirroring) — lets a LATER `attach-run`
   * find this same execution, and lets the interpreter announce `run-started`
   * back to main correlated to it. */
  readonly runId: string;
}

/** Create a new shell session. Interpreter mints the id + resolves the cwd (Codex B5). */
export interface CreateSessionMessage {
  readonly type: 'create-session';
  /** Correlates the async `session-created` reply back to the main-side awaiter. */
  readonly requestId: string;
  /** Optional starting cwd; interpreter defaults to its process cwd when omitted. */
  readonly cwd?: string;
}

/** Destroy a session: abort its in-flight runs, release resources, drop the record. */
export interface DestroySessionMessage {
  readonly type: 'destroy-session';
  readonly sessionId: string;
}

/**
 * Attach a NON-INITIATING observer port to an existing run (M2 mirroring —
 * see `EzTerminalApi.attachRun`). Carries the dedicated port as transfer,
 * same as `RunMessage`. An unknown/already-ended `runId` gets a terminal
 * `error` frame and the port closed (see `ExecutionSession.attach`) rather
 * than resurrecting anything — mirrors `RunMessage`'s "never lazily create"
 * discipline (Codex B1) for runs instead of sessions.
 */
export interface AttachRunMessage {
  readonly type: 'attach-run';
  readonly runId: string;
}

// ── Script host broker (E4 §6.1) ─────────────────────────────────────────────
// `run-script` spawns a script-host utilityProcess for the DURATION OF ONE
// SCRIPT (main is the only process that can fork one, C1/C2). The interpreter
// requests spawn/kill by `hostId`; main replies with ready (+ the interpreter's
// end of a dedicated MessageChannelMain, transferred) / error / exit. Once
// ready, the interpreter and host talk RPC directly over that port — main
// never sees `ez-run`/`script-print`/etc. traffic (same "bulk stays off main"
// principle as the renderer's cmd-port).

/** interpreter -> main: fork a script-host for one `run-script` invocation. */
export interface SpawnScriptHostMessage {
  readonly type: 'spawn-script-host';
  readonly hostId: string;
  readonly scriptPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** interpreter -> main: kill a host (cancel/done/error teardown, §6.1). Idempotent. */
export interface KillScriptHostMessage {
  readonly type: 'kill-script-host';
  readonly hostId: string;
}

// ── known_hosts (E5 §3) ───────────────────────────────────────────────────────
// TOFU host-key trust is main-owned filesystem state (userData/known_hosts.json,
// KnownHostsStore — same versioned-envelope/atomic-write/quarantine pattern as
// LayoutStore), so `ssh-connect`'s runner asks main to check/persist a host key,
// correlated by requestId (mirrors the create-session round-trip).

/** interpreter -> main: verify a host key fingerprint against known_hosts.json. */
export interface KnownHostCheckMessage {
  readonly type: 'known-host-check';
  readonly requestId: string;
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  readonly fingerprint: string;
}

/** main -> interpreter: reply to `known-host-check`. `mismatch` carries the
 * PREVIOUSLY trusted fingerprint so the runner's hard-fail error can show
 * old/new side by side; `knownHostsPath` is always included so that error can
 * also name the file to edit for recovery (key-rotation recovery, gate fold). */
export interface KnownHostVerdictMessage {
  readonly type: 'known-host-verdict';
  readonly requestId: string;
  readonly verdict: 'match' | 'mismatch' | 'unknown';
  readonly existingFingerprint?: string;
  readonly knownHostsPath: string;
}

/** interpreter -> main: persist a newly-trusted host key (TOFU accept). Fire-and-forget. */
export interface KnownHostAddMessage {
  readonly type: 'known-host-add';
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  readonly fingerprint: string;
}

export type MainToInterpreter =
  | RunMessage
  | CreateSessionMessage
  | DestroySessionMessage
  | AttachRunMessage
  | ScriptHostReadyMessage
  | ScriptHostErrorMessage
  | ScriptHostExitMessage
  | KnownHostVerdictMessage;

/** Interpreter's reply to `create-session` — the authoritative session id + cwd. */
export interface SessionCreatedMessage {
  readonly type: 'session-created';
  readonly requestId: string;
  readonly sessionId: string;
  readonly cwd: string;
}

/**
 * interpreter -> main: a run just began (M2 mirroring) — main fans this out
 * as the `run-started` IPC push (desktop windows) and WS broadcast (mobile),
 * same fields as `RunStartedInfo` (the renderer-facing shape) but named
 * distinctly here since this crosses the main<->interpreter boundary, not
 * the preload bridge.
 */
export interface InterpreterRunStartedMessage extends RunStartedInfo {
  readonly type: 'run-started';
}

/** main -> interpreter: the host forked; its RPC port arrives via event.ports[0]. */
export interface ScriptHostReadyMessage {
  readonly type: 'script-host-ready';
  readonly hostId: string;
}

/** main -> interpreter: `utilityProcess.fork` threw synchronously (bad path, etc). */
export interface ScriptHostErrorMessage {
  readonly type: 'script-host-error';
  readonly hostId: string;
  readonly message: string;
}

/** main -> interpreter: the host process exited (normally, killed, or crashed). */
export interface ScriptHostExitMessage {
  readonly type: 'script-host-exit';
  readonly hostId: string;
  readonly code: number | null;
}

export type InterpreterToMain =
  | SessionCreatedMessage
  | InterpreterRunStartedMessage
  | SpawnScriptHostMessage
  | KillScriptHostMessage
  | KnownHostCheckMessage
  | KnownHostAddMessage;

/** The authoritative session identity returned by `createSession`. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
}

// ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ─────
// A session/run may originate from ANY connected surface (another desktop
// tab, another desktop window, or a remote mobile client). `listSessions` +
// `onSessionAdded`/`onSessionRemoved` let a renderer observe the full set
// live (seed via `listSessions`, then stay current via the two pushes —
// same seed-then-subscribe shape as `getStatsHistory`/`onStatsUpdate`).
// `onRunStarted` announces a run the moment it begins, in any session; a
// mirroring observer answers it with `attachRun` to receive that run's
// frame stream. Both pushes are unconditional broadcasts (including runs/
// sessions THIS window itself just started) — the caller distinguishes its
// own echo, since it already has the id from its own local call.

/** Announces a run the instant it starts, before any port is brokered — a
 * mirroring observer uses `sessionId`/`runId` to call `attachRun`. */
export interface RunStartedInfo {
  readonly sessionId: string;
  readonly runId: string;
  readonly commandText: string;
}

// ── System stats overlay panel (status-overlay-panel, rev6/Option A″) ───────
// SystemStatsService (main) runs a persistent 1s pure-JS loop for cpu/mem
// (si.currentLoad() + Node os.totalmem()/freemem() — no PowerShell, no
// persistent session: see .omc/artifacts/stats-spike/results.md for why a
// persistent powerShellStart() session was rejected). net/disks/procs are
// collected by independent, panel-open-only spawned-PowerShell loops and are
// null while the panel is closed or during warmup.
// Channels: 'stats:update' (main -> renderer push, panelVisible only, 1Hz),
// 'stats:history' (renderer -> main invoke, up to the last 60 snapshots),
// 'stats:panel-visible' (renderer -> main send, boolean).

/** One second-granularity sample of system stats for the status overlay panel. */
export interface SystemStatsSnapshot {
  readonly at: number;
  /** `cores` is always present (empty array only on the very first tick before currentLoad() resolves). */
  readonly cpu: { readonly loadPct: number; readonly cores: readonly number[] };
  readonly mem: { readonly usedBytes: number; readonly totalBytes: number };
  /** null while the panel is closed (or before the first successful poll). Page-file = swap. */
  readonly memDetail: {
    readonly availableBytes: number;
    readonly cachedBytes: number;
    readonly swapUsedBytes: number;
    readonly swapTotalBytes: number;
  } | null;
  /** null while the panel is closed, or during the first-sample rate warmup. */
  readonly net: { readonly iface: string; readonly rxSec: number; readonly txSec: number } | null;
  /** null while the panel is closed (or before the first successful poll). */
  readonly disks: ReadonlyArray<{
    readonly mount: string;
    readonly usedBytes: number;
    readonly sizeBytes: number;
  }> | null;
  /** null while the panel is closed (or before the first successful poll). CPU-descending, top 10. */
  readonly procs: ReadonlyArray<{
    readonly pid: number;
    readonly name: string;
    readonly cpuPct: number;
    readonly memBytes: number;
  }> | null;
  /** null while the panel is closed (or before the first successful poll). */
  readonly conns: ReadonlyArray<{
    readonly proto: string;
    readonly local: string;
    readonly peer: string;
    readonly state: string;
    readonly process: string;
  }> | null;
}

// ── Packet capture (status-panel-v2 Phase 2B, off-by-default) ───────────────
// The renderer's packet preview sub-view subscribes only while it's open.
// Control is two plain sends (`packets:subscribe`/`packets:unsubscribe`,
// renderer -> main). The packet batches themselves never touch an IPC channel:
// main forks a dedicated packet-capture-host utilityProcess and brokers a
// fresh MessageChannelMain's port1 to the renderer over a `packet-port` event
// — the SAME window-message relay preload already does for `cmd-port` (see
// preload.ts), just with a boolean `_ezPacketPort` marker instead of a per-run
// id (only one capture subscription is ever live at a time). Main never reads
// this port's traffic. Status (npcap-missing / access-denied / error) is
// determined INSIDE the host (only it loads `cap` and opens the device), so it
// travels over that same port as a `PacketCaptureFrame`, not through main.

/** One captured packet, header-only (no payload — SEC: never capture body bytes). */
export interface PacketRow {
  readonly at: number;
  readonly src: string;
  readonly dst: string;
  readonly proto: string;
  readonly len: number;
}

/** Capture host lifecycle/error state, reported over the packet port. */
export type PacketCaptureStatus = 'capturing' | 'npcap-missing' | 'access-denied' | 'error';

/** A throttled batch of captured rows (host -> renderer, over the packet port). */
export interface PacketBatchFrame {
  readonly type: 'packets';
  readonly rows: readonly PacketRow[];
}

/** A capture status change (host -> renderer, over the packet port). */
export interface PacketStatusFrame {
  readonly type: 'status';
  readonly status: PacketCaptureStatus;
}

/** Discriminated union of all frames sent from the capture host to the renderer. */
export type PacketCaptureFrame = PacketBatchFrame | PacketStatusFrame;

// ── Mobile remote-control pairing (M4) ───────────────────────────────────────
// The desktop pairing panel needs LAN URLs a phone can dial + the bridge port.
// Computed main-side from `os.networkInterfaces()` (see remote-connection-info.ts)
// but the shape is defined here since, like everything else above, it crosses
// the preload/IPC boundary.

/** LAN connect URLs (`ws://<ip>:<port>`, one per non-internal IPv4 interface) + the bridge port. */
export interface RemoteConnectionInfo {
  readonly urls: readonly string[];
  readonly port: number;
}

// ── Preload bridge API ────────────────────────────────────────────────────────

export interface EzTerminalApi {
  readonly versions: RuntimeVersions;
  /**
   * Create a new independent shell session (its own cwd/env/variables/history) and
   * resolve once the interpreter has created it — returning the authoritative
   * `sessionId` + starting `cwd` (Codex B5). A pane MUST await this before running
   * commands; every `runCommand` is scoped to a session created this way.
   */
  createSession: (cwd?: string) => Promise<SessionInfo>;
  /**
   * Destroy a session when its pane/tab closes: the interpreter aborts the session's
   * in-flight runs, releases their stores/ports, and drops the session (Codex B2/B6).
   * Idempotent and fire-and-forget.
   */
  destroySession: (sessionId: string) => void;
  /**
   * Start executing `commandText` in `sessionId`. `runId` is a caller-supplied unique
   * token used to correlate the brokered port back to *this* run. Main echoes `runId`
   * on the `cmd-port` reply so concurrent runs (across panes) never mis-correlate
   * their ports (Codex B3). Returns a Promise that resolves once the command port has
   * been brokered and transferred to the renderer world.
   *
   * The dedicated MessagePort for this command's frame stream is NOT returned
   * directly — contextBridge cannot transfer a MessagePort through a Promise
   * resolution value (it clones, not transfers). Instead the preload transfers
   * the port via `window.postMessage({ _ezPort: runId }, '/', [port])`.
   * The renderer should listen with `window.addEventListener('message', ...)`
   * to receive the port in event.ports[0].
   */
  runCommand: (commandText: string, runId: string, sessionId: string) => Promise<void>;
  /**
   * Subscribe to the interpreter dying (crash/exit). Phase 1 has ONE utilityProcess
   * shared by all sessions, so its death kills every session — the renderer marks all
   * panes dead and stops accepting runs (Codex B8). The optional info payload
   * (additive, B-M5) carries the local error-log path for the crash banner.
   * Returns an unsubscribe.
   */
  onSessionDead: (listener: (info?: { logPath?: string | null }) => void) => () => void;

  // ── Layout persistence (Track A ③) ─────────────────────────────────────────
  // Main owns the filesystem; every payload is validated main-side against
  // src/shared/layout-schema.ts. The renderer passes raw api.toJSON() output.
  /** Load the persisted layout envelope (null = absent or quarantined-corrupt). */
  loadLayout: () => Promise<LayoutEnvelope | null>;
  /** Queue a layout save (main sanitizes + validates + wraps; latest-wins). */
  saveLayout: (rawLayout: unknown) => Promise<void>;
  /** Await all queued layout writes (renderer flush seam / quit path). */
  flushLayout: () => Promise<void>;
  /** Quarantine the persisted layout file — AWAITABLE (Codex gate B3): the
   * renderer suppresses saves until this resolves, then builds the fallback. */
  quarantineLayout: () => Promise<void>;
  listPresets: () => Promise<string[]>;
  getPreset: (name: string) => Promise<LayoutEnvelope | null>;
  /** False = rejected (bad name or invalid layout). */
  savePreset: (name: string, rawLayout: unknown) => Promise<boolean>;
  deletePreset: (name: string) => Promise<void>;
  getStartup: () => Promise<StartupPref>;
  setStartup: (pref: StartupPref) => Promise<void>;

  // ── Theme (E1) ───────────────────────────────────────────────────────────
  /** The persisted theme choice (defaults to 'dark' when never set). */
  getTheme: () => Promise<ThemeName>;
  /** Persist a theme choice — main validates before writing. */
  setTheme: (theme: ThemeName) => Promise<void>;

  // ── Status overlay panel stats (status-overlay-panel) ─────────────────────
  /** Subscribe to the 1Hz stats push (flows only while the panel is open). Returns an unsubscribe. */
  onStatsUpdate: (listener: (snapshot: SystemStatsSnapshot) => void) => () => void;
  /** Seed the panel with the most recent history (up to 60 snapshots) on open. */
  getStatsHistory: () => Promise<SystemStatsSnapshot[]>;
  /** Tell main whether the panel is visible — gates the 1Hz push + panel-open-only collectors. */
  setStatsPanelVisible: (visible: boolean) => void;

  // ── Packet capture (status-panel-v2 Phase 2B, off-by-default) ────────────
  /** Ask main to fork the capture host and broker its port. Re-subscribing kills any live host first. */
  subscribePackets: () => void;
  /** Ask main to kill the live capture host, if any. Idempotent. */
  unsubscribePackets: () => void;

  // ── Mobile remote-control pairing (M4) ────────────────────────────────────
  /** LAN connect URLs for the mobile pairing panel + the bridge port. */
  getRemoteConnectionInfo: () => Promise<RemoteConnectionInfo>;
  /** The remote bridge's current persisted auth token. */
  getRemoteToken: () => Promise<string>;
  /** Mint + persist a new token — existing connections keep working (the bridge
   * only re-checks the token on new connections); new connections need it. */
  rotateRemoteToken: () => Promise<string>;

  // ── File explorer (file-explorer plan, M1) ────────────────────────────────
  // Desktop drawer thin passthroughs to main's `FileService`. `''` for a path
  // means "resolve to the home dir" (see `FileService.listDirectory`).
  /** List a directory's entries (folders-first, name-sorted, dotfiles included). */
  listFiles: (path: string) => Promise<FileListResult>;
  /** Windows drive letters (`A:\`..`Z:\`) to browse from when there's no parent. */
  listFileRoots: () => Promise<string[]>;
  /** Read a file for the read-only viewer — binary files come back `isText:false`. */
  readTextFile: (path: string) => Promise<FileReadTextResult>;
  createFolder: (dirPath: string, name: string) => Promise<FileOpResult>;
  renameFile: (path: string, newName: string) => Promise<FileOpResult>;
  /** Moves to the OS trash only — never a permanent delete. */
  trashFile: (path: string) => Promise<FileOpResult>;
  /** Open a file with its OS-registered default app. Desktop-only (no mobile analog). */
  openFileInApp: (path: string) => Promise<void>;
  /** Reveal a file in the OS file manager. Desktop-only (no mobile analog). */
  revealFileInExplorer: (path: string) => Promise<void>;

  // ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ──
  /** Every currently-live session, oldest-created first (mirrors `SessionDirectory.list()`). */
  listSessions: () => Promise<readonly SessionInfo[]>;
  /** A session now exists, any origin (including this window's own — see the
   * echo note above). Returns an unsubscribe. */
  onSessionAdded: (listener: (session: SessionInfo) => void) => () => void;
  /** A session is gone, any origin. Returns an unsubscribe. */
  onSessionRemoved: (listener: (sessionId: string) => void) => () => void;
  /** A run started in some session, any origin — call `attachRun` to mirror it. Returns an unsubscribe. */
  onRunStarted: (listener: (info: RunStartedInfo) => void) => () => void;
  /**
   * Attach as a NON-INITIATING observer to a run: receives the same
   * `InterpreterFrame` stream `runCommand` does and may send `pty-input`/
   * `pty-resize` controls, but this side alone closing never tears the run
   * down for the initiator (last-port-close semantics owned by main, T2.2c).
   * Mirrors `runCommand`'s port-transfer shape exactly (see its doc above):
   * resolves once the request is sent; the dedicated port for this `runId`
   * arrives asynchronously via a persistent `attach-port` window message.
   */
  attachRun: (sessionId: string, runId: string) => Promise<void>;
}
