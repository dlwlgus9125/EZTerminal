/**
 * Shared IPC contract: main ↔ preload ↔ renderer ↔ interpreter (utilityProcess).
 *
 * T1 vertical slice: Renderer → main broker → utilityProcess interpreter →
 * framed streaming back via dedicated MessagePort → renderer. (architecture §3)
 */
import type {
  EffectParamsSettings,
  LayoutEnvelope,
  OpenClawMode,
  RollbarSettings,
  StartupPref,
  TerminalRendererPreference,
  ThemeName,
} from './layout-schema';
import type { FileListResult, FileOpResult, FileReadTextResult } from './files';
import type { FilePreviewResult } from './file-preview';
import type { QuickCommand, QuickCommandInput, QuickCommandMutationResult } from './quick-command';
import type { WorkspaceFileSearchRequest, WorkspaceFileSearchResult } from './workspace-search';
import type { TerminalFileLocationRequest, TerminalFileLocationResult } from './terminal-file-location';
import type { SSH_FORWARD_BIND_HOST, SshForwardAction, SshForwardInfo, SshForwardResult } from './ssh-forward';
import type {
  WorktreeInfo,
  WorktreeRequest,
  WorktreeRequestOrigin,
  WorktreeResult,
} from './worktree';
import type { ThemeMod } from './theme-schema';
import type {
  AgentActivitySnapshot,
  AgentFollowupResult,
  AgentIntegrationMutationResult,
  AgentIntegrationProvider,
  AgentIntegrationStatus,
  AgentSettings,
} from './agent';
import type {
  OpenClawAgentSession,
  OpenClawAutostartAction,
  OpenClawAutostartResult,
  OpenClawChatBounds,
  OpenClawChatViewState,
  OpenClawCoreConfig,
  OpenClawLifecycleAction,
  OpenClawLifecycleResult,
  OpenClawLogLine,
  OpenClawSetConfigResult,
  OpenClawStatus,
  OpenClawVisibility,
} from './openclaw';
import type { UiPreferences, UiPreferencesPatch } from './ui-preferences';
import type {
  TerminalClipboardSnapshot,
  TerminalPastePreferences,
} from './terminal-clipboard';

/** The single key under which the preload bridge is exposed on `window`. */
export const BRIDGE_KEY = 'ezterminal' as const;

/** Desktop-only bridge key (theme-effects-font M3) — see `EzTerminalDesktopApi`. */
export const DESKTOP_BRIDGE_KEY = 'ezterminalDesktop' as const;

/** Runtime version strings, surfaced by the preload (no IPC round-trip). */
export interface RuntimeVersions {
  readonly app: string;
  readonly protocol: number;
  readonly buildSha: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

/**
 * Desktop-native Ctrl+Tab events. Chromium consumes Ctrl+Tab before a renderer
 * keydown is dispatched, so main captures only this chord and forwards this
 * narrow, data-free union through the isolated preload bridge.
 */
export type RecentPanelInputEvent =
  | { readonly type: 'cycle'; readonly reverse: boolean }
  | { readonly type: 'commit' }
  | { readonly type: 'cancel'; readonly restoreFocus: boolean };

export function isRecentPanelInputEvent(value: unknown): value is RecentPanelInputEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<RecentPanelInputEvent>;
  const keys = Object.keys(event).sort();
  if (event.type === 'cycle') {
    return typeof event.reverse === 'boolean' && keys.join(',') === 'reverse,type';
  }
  if (event.type === 'commit') return keys.join(',') === 'type';
  if (event.type === 'cancel') {
    return typeof event.restoreFocus === 'boolean' && keys.join(',') === 'restoreFocus,type';
  }
  return false;
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

/** Execution transport selected for a run. Optional on wire frames for compatibility. */
export type ExecutionKind = 'local' | 'ssh';

export interface StartFrame {
  readonly type: 'start';
  /** Echoes back the raw command text for correlation. */
  readonly commandText: string;
  /** Additive: absent when replaying frames from an older interpreter. */
  readonly executionKind?: ExecutionKind;
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
  /** Process exit code when the underlying runner exposes one. Older and
   * non-process runners may omit it. */
  readonly exitCode?: number;
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
  /** Historical terminal output being rendered for state reconstruction.
   * Consumers must render it but must not repeat terminal-originated effects
   * such as OSC 52 clipboard writes. Absent means ordinary live output. */
  readonly suppressSideEffects?: true;
}

/**
 * Local mobile reconnect marker. It is emitted immediately before an attach
 * port replays the authoritative PTY buffer, so the existing xterm/plain view
 * can clear stale scrollback without being remounted.
 */
export interface PtyReplayResetFrame {
  readonly type: 'pty-replay-reset';
}

/** Stable, content-free reason why a late PTY attach used a degraded restore
 * path. Snapshot/tail bytes continue to use `pty-data`, keeping the remote
 * base64 codec unchanged. */
export type PtyRestoreWarningReason =
  | 'semantic-gap'
  | 'serializer-failed'
  | 'snapshot-too-large'
  | 'resize-pending'
  | 'replay-queue-overflow'
  | 'ssh-late-attach-unsupported';

export interface PtyRestoreWarningFrame {
  readonly type: 'pty-restore-warning';
  readonly reason: PtyRestoreWarningReason;
  readonly fallback: 'raw-ring' | 'none';
  readonly snapshotEpoch?: number;
  readonly streamEpoch?: number;
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

/** Stable id of the authenticated SSH transport backing this terminal. */
export interface SshConnectionFrame {
  readonly type: 'ssh-connection';
  readonly connectionId: string;
  readonly state: 'ready' | 'closed';
}

/** A mobile-origin `worktree open` completed main-side validation. Only the
 * originating run port acts on it; mirrors keep rendering the structured row. */
export interface WorktreeOpenFrame {
  readonly type: 'worktree-open';
  /** Stable across attach replay so the initiating mobile transport can
   * deduplicate a frame it already acted on before reconnecting. */
  readonly intentId: string;
  readonly worktree: WorktreeInfo;
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

/**
 * The PTY grid's current dimensions (mobile mirroring fix, D3). A mirror
 * (`attach-run`) port has its `pty-resize` controls gated out (interpreter-
 * process.ts's `pty-resize` handler only honors the port currently holding
 * resize authority — the CONTROL port, which starts as the primary but can
 * move via `pty-claim-control`, control handoff M8a) so a phone's smaller
 * xterm can never resize the shared PTY out from under the current authority
 * — but ignoring resize entirely would leave a non-authority mirror's grid
 * stuck at the PTY's spawn size while cursor-addressing bytes are drawn for
 * the authority's actual (larger) grid, unreadable. Sent on every attach
 * (replaying the current dims) and on every resize by the control port
 * (fan-out to every OTHER port, including a demoted former authority), so a
 * mirror instead renders at the authority's dimensions via `term.resize()`
 * and scrolls (see `.pty-block--mirror` in index.css) rather than reflowing.
 */
export interface PtyDimsFrame {
  readonly type: 'pty-dims';
  readonly cols: number;
  readonly rows: number;
}

/**
 * Per-port notification of PTY resize-authority state (control handoff, M8a).
 * `hasControl:true` tells a port it is now the resize authority — its own
 * `pty-resize` will be honored (see `PtyClaimControlControl`); `hasControl:
 * false` tells a port it is a display-only mirror. Sent to the claimer and
 * every other open port on a `pty-claim-control`, to a fresh attacher (always
 * `false` — it is never the authority at attach time), and to whichever port
 * inherits control when the previous authority's port closes/detaches.
 */
export interface PtyControlFrame {
  readonly type: 'pty-control';
  readonly hasControl: boolean;
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
  | PtyReplayResetFrame
  | PtyRestoreWarningFrame
  | SshPromptFrame
  | SshConnectionFrame
  | WorktreeOpenFrame
  | PtyRenderUpgradeFrame
  | PtyDimsFrame
  | PtyControlFrame;

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
 * Claim PTY resize authority (control handoff, M8a): the claiming port
 * becomes the interpreter's resize authority for this run — its `pty-resize`
 * now applies to the shared PTY, and whichever port held control before (the
 * primary, by default) demotes to a display-only mirror. See `PtyControlFrame`
 * for the notification this triggers on every affected port.
 */
export interface PtyClaimControlControl {
  readonly type: 'pty-claim-control';
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
  | PtyClaimControlControl
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
  /** Absent means desktop for backward compatibility. RemoteBridge sets
   * `mobile`, which keeps mutating worktree actions denied end-to-end. */
  readonly requestOrigin?: WorktreeRequestOrigin;
}

/** Create a new shell session. Interpreter mints the id + resolves the cwd (Codex B5). */
export interface CreateSessionMessage {
  readonly type: 'create-session';
  /** Correlates the async `session-created` reply back to the main-side awaiter. */
  readonly requestId: string;
  /** Optional starting cwd; interpreter defaults to its process cwd when omitted. */
  readonly cwd?: string;
}

/** Rehydrate the broker's durable session identities after the interpreter
 * utility process is replaced. Active runs and shell variables are deliberately
 * not replayed; each restored session resumes at its last authoritative cwd. */
export interface RestoreSessionsMessage {
  readonly type: 'restore-sessions';
  readonly sessions: readonly SessionInfo[];
}

/** Main-owned internal environment injected immediately after creation and
 * before createSession resolves. It never crosses the renderer or remote API. */
export interface SetSessionEnvironmentMessage {
  readonly type: 'set-session-environment';
  readonly sessionId: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Destroy a session: abort its in-flight runs, release resources, drop the record. */
export interface DestroySessionMessage {
  readonly type: 'destroy-session';
  readonly sessionId: string;
  /** Present only for a renderer/mobile guarded close. The interpreter compares
   * this snapshot atomically with its live foreground runs before destroying. */
  readonly expectedActiveRunIds?: readonly string[];
  /** Correlates the guarded result. Omitted for trusted, unconditional teardown. */
  readonly requestId?: string;
  /** Main-side ACK deadline. An interpreter that receives the guarded request
   * after this time must reject it instead of performing an unobservable late
   * teardown. Omitted only for legacy/tests and unconditional teardown. */
  readonly deadlineAt?: number;
}

export interface GuardedSessionDestroyRequest {
  readonly sessionId: string;
  readonly expectedActiveRunIds: readonly string[];
}

/** Atomic multi-session close used when replacing a desktop layout. The
 * interpreter validates every snapshot before destroying any session. */
export interface DestroySessionsGuardedMessage {
  readonly type: 'destroy-sessions-guarded';
  readonly requestId: string;
  readonly sessions: readonly GuardedSessionDestroyRequest[];
  readonly deadlineAt: number;
}

export type DestroySessionGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'state-changed' | 'unavailable' };

export const MAX_GUARDED_DESTROY_RUN_IDS = 8;
export const MAX_GUARDED_DESTROY_SESSIONS = 16;

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
  /** Present when main must know that the observer was accepted before it
   * releases another liveness-holding port (mobile reconnect takeover). */
  readonly requestId?: string;
  /** Session ownership is checked even though run ids are globally unique. */
  readonly sessionId: string;
  readonly runId: string;
}

export type RunAttachRejectReason =
  | 'run-not-found'
  | 'session-mismatch'
  | 'run-ended'
  | 'mirror-capacity'
  | 'ssh-unsupported'
  | 'restore-failed'
  | 'transport-failed';

/**
 * Ask the interpreter for every currently-active run (M1 mirror-active-runs
 * gap fix): a client that connects/re-mounts AFTER a run already started has
 * no other way to learn its `runId` for `attach-run` — `run-started` is
 * edge-triggered, broadcast only once at the moment a run begins. Correlated
 * by `requestId`, mirroring `CreateSessionMessage`'s round-trip shape.
 */
export interface ListRunsMessage {
  readonly type: 'list-runs';
  readonly requestId: string;
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

/** Interpreter -> main: authenticated SSH connection lifecycle. `closed` is
 * terminal in v1; there is no implicit reauthentication or id reuse. */
export interface SshConnectionStateMessage {
  readonly type: 'ssh-connection-state';
  readonly connectionId: string;
  readonly state: 'ready' | 'closed';
}

/** Interpreter builtin -> main forwarding-service RPC. */
export interface SshForwardRequestMessage {
  readonly type: 'ssh-forward-request';
  readonly requestId: string;
  readonly request: SshForwardAction;
  /** Main-owned authorization context; mobile may inspect but not mutate listeners. */
  readonly origin: WorktreeRequestOrigin;
}

export interface SshForwardRequestCancelMessage {
  readonly type: 'ssh-forward-request-cancel';
  readonly requestId: string;
}

/** Main -> interpreter: correlated start/list/stop result. */
export interface SshForwardResponseMessage {
  readonly type: 'ssh-forward-response';
  readonly requestId: string;
  readonly result: SshForwardResult;
}

/** Main -> interpreter: one accepted loopback socket requests an ssh2
 * direct-tcpip channel. Carries a dedicated MessagePort in event.ports[0]. */
export interface SshForwardStreamOpenMessage {
  readonly type: 'ssh-forward-stream-open';
  readonly streamId: string;
  readonly connectionId: string;
  readonly sourceHost: typeof SSH_FORWARD_BIND_HOST;
  readonly sourcePort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
}

/** Interpreter builtin -> main-owned WorktreeService RPC. */
export interface WorktreeActionRequestMessage {
  readonly type: 'worktree-action-request';
  readonly requestId: string;
  readonly request: WorktreeRequest;
  readonly origin: WorktreeRequestOrigin;
  /** Interpreter-authored identity of the run awaiting this request. Main
   * uses it only to exempt that exact run from the removal barrier. */
  readonly sessionId: string;
  readonly runId: string;
}

export interface WorktreeActionCancelMessage {
  readonly type: 'worktree-action-cancel';
  readonly requestId: string;
}

/** Main -> interpreter correlated worktree result. */
export interface WorktreeActionResponseMessage {
  readonly type: 'worktree-action-response';
  readonly requestId: string;
  readonly result: WorktreeResult;
}

export type MainToInterpreter =
  | RunMessage
  | CreateSessionMessage
  | RestoreSessionsMessage
  | SetSessionEnvironmentMessage
  | DestroySessionMessage
  | DestroySessionsGuardedMessage
  | AttachRunMessage
  | ListRunsMessage
  | ScriptHostReadyMessage
  | ScriptHostErrorMessage
  | ScriptHostExitMessage
  | KnownHostVerdictMessage
  | SshForwardResponseMessage
  | SshForwardStreamOpenMessage
  | WorktreeActionResponseMessage;

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

/** interpreter -> main: reply to `list-runs` — every currently-active run
 * (M1 mirror-active-runs), correlated by `requestId`. */
export interface RunListMessage {
  readonly type: 'run-list';
  readonly requestId: string;
  readonly runs: readonly RunStartedInfo[];
}

/** A foreground run reached its terminal boundary. The cwd is the
 * interpreter-owned ShellSession value after the command (including cd).
 * Main releases the run lease and refreshes its session directory together. */
export interface SessionRunSettledMessage {
  readonly type: 'session-run-settled';
  readonly sessionId: string;
  readonly runId: string;
  /** Absent only when the interpreter rejected the run before finding a live session. */
  readonly cwd?: string;
}

/** Interpreter acknowledgement for a guarded session destroy. `destroyed`
 * also means the session was already absent, preserving idempotent close. */
export interface SessionDestroyResultMessage {
  readonly type: 'session-destroy-result';
  readonly requestId: string;
  /** Echoed independently of main's short-lived correlation entry so a
   * successful late ACK can reconcile the main-side SessionDirectory. */
  readonly sessionIds: readonly string[];
  readonly destroyed: boolean;
}

/** Interpreter acknowledgement for an attach carrying `requestId`. Frames may
 * already be queued on the transferred port, but main must not start/release
 * takeover resources until this authoritative result arrives. */
export type RunAttachResultMessage =
  | {
      readonly type: 'run-attach-result';
      readonly requestId: string;
      readonly accepted: true;
    }
  | {
      readonly type: 'run-attach-result';
      readonly requestId: string;
      readonly accepted: false;
      readonly reason: RunAttachRejectReason;
    };

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
  | SessionRunSettledMessage
  | InterpreterRunStartedMessage
  | RunListMessage
  | SessionDestroyResultMessage
  | RunAttachResultMessage
  | SpawnScriptHostMessage
  | KillScriptHostMessage
  | KnownHostCheckMessage
  | KnownHostAddMessage
  | SshConnectionStateMessage
  | SshForwardRequestMessage
  | SshForwardRequestCancelMessage
  | WorktreeActionRequestMessage
  | WorktreeActionCancelMessage;

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
  /** Additive: absent when announced by an older desktop interpreter. */
  readonly executionKind?: ExecutionKind;
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

/** Fail-closed readiness of the desktop token store. */
export interface RemoteSecurityStatus {
  readonly state: 'ready' | 'error';
  readonly error: string | null;
}

/** Desired setting and independently observed listener lifecycle. */
export interface RemoteRuntimeStatus {
  readonly desiredEnabled: boolean;
  readonly state: 'off' | 'starting' | 'running' | 'stopping' | 'error';
  /** Configured port while stopped/error; actual bound port while running. */
  readonly port: number;
  readonly errorCode: string | null;
  readonly error: string | null;
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
  /** Destroy only if the interpreter still has exactly the foreground runs
   * observed by the closing surface. A state change fails closed. */
  destroySessionGuarded: (
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ) => Promise<DestroySessionGuardResult>;
  /** Atomically validate and destroy all creator sessions before replacing a
   * saved layout. Either every session is destroyed or none is. */
  destroySessionsGuarded: (
    sessions: readonly GuardedSessionDestroyRequest[],
  ) => Promise<DestroySessionGuardResult>;
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
  /** The interpreter supervisor restored every prior session identity and new
   * commands can be submitted again. Returns an unsubscribe. */
  onSessionRecovered: (listener: () => void) => () => void;

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
  /** The persisted theme choice (defaults to 'matrix' when never set). */
  getTheme: () => Promise<ThemeName>;
  /** Persist a theme choice — main validates before writing. */
  setTheme: (theme: ThemeName) => Promise<void>;

  // ── UI scale (v0.2.0 D1) ──────────────────────────────────────────────────
  /** The persisted UI scale percent (defaults to 100 when never set). */
  getUiScale: () => Promise<number>;
  /** Persist a UI scale percent — main validates before writing. */
  setUiScale: (uiScale: number) => Promise<void>;

  // ── Scrollback (WT-parity M5) ─────────────────────────────────────────────
  /** The persisted scrollback line count (defaults to 5000 when never set). */
  getScrollback: () => Promise<number>;
  /** Persist a scrollback line count — main validates before writing. */
  setScrollback: (scrollback: number) => Promise<void>;

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
  /** Whether the token file passed platform permission/ACL verification. */
  getRemoteSecurityStatus: () => Promise<RemoteSecurityStatus>;
  /** Mint + persist a new token — existing connections keep working (the bridge
   * only re-checks the token on new connections); new connections need it. */
  rotateRemoteToken: () => Promise<string>;
  /** Persisted desired state (legacy convenience; defaults to false). */
  getRemoteEnabled: () => Promise<boolean>;
  /** Desired setting plus the independently observed listener lifecycle. */
  getRemoteRuntimeStatus: () => Promise<RemoteRuntimeStatus>;
  /** Persist desired state and reconcile the real listener. */
  setRemoteEnabled: (enabled: boolean) => Promise<RemoteRuntimeStatus>;
  /** Retry listener startup without changing the persisted desired state. */
  retryRemoteRuntime: () => Promise<RemoteRuntimeStatus>;
  /** Runtime state transitions pushed by main. */
  onRemoteRuntimeStatus: (listener: (status: RemoteRuntimeStatus) => void) => () => void;

  // ── File explorer (file-explorer plan, M1) ────────────────────────────────
  // Desktop drawer thin passthroughs to main's `FileService`. `''` for a path
  // means "resolve to the home dir" (see `FileService.listDirectory`).
  /** List a directory's entries (folders-first, name-sorted, dotfiles included). */
  listFiles: (path: string) => Promise<FileListResult>;
  /** Windows drive letters (`A:\`..`Z:\`) to browse from when there's no parent. */
  listFileRoots: () => Promise<string[]>;
  /** Read a file for the read-only viewer — binary files come back `isText:false`. */
  readTextFile: (path: string) => Promise<FileReadTextResult>;
  /** Read a bounded, magic-classified rich preview (text/Markdown/image/PDF metadata). */
  readFilePreview: (path: string, terminalCapability?: string) => Promise<FilePreviewResult>;
  /** Explicit terminal-link resolution; main owns realpath containment policy. */
  resolveTerminalFileLocation: (request: TerminalFileLocationRequest) => Promise<TerminalFileLocationResult>;
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
  /** Every currently-active run across every session (M1 mirror-active-runs
   * gap fix) — lets a client that connects/mounts AFTER a run already started
   * learn its `runId` to call `attachRun` (`onRunStarted` below is edge-
   * triggered, firing only once at the moment a run begins). */
  listRuns: () => Promise<readonly RunStartedInfo[]>;
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

  // ── Agent Activity (desktop + connected mobile) ─────────────────────────
  /** Level-triggered seed; snapshots never contain prompts, transcripts or tool input. */
  getAgentActivitySnapshot: () => Promise<AgentActivitySnapshot>;
  /** Revisioned activity push. Returns an unsubscribe. */
  onAgentActivitySnapshot: (listener: (snapshot: AgentActivitySnapshot) => void) => () => void;
  /** Deliver one trimmed line to a waiting agent PTY. Never auto-submits approvals. */
  sendAgentFollowup: (activityId: string, text: string) => Promise<AgentFollowupResult>;

  /** Main-owned Git worktree operations. Mobile is restricted to list/open. */
  executeWorktree: (request: WorktreeRequest) => Promise<WorktreeResult>;
}

// ── Desktop-only preload bridge API (theme-effects-font M3) ──────────────────
// A SEPARATE bridge from EzTerminalApi (not an extension of it): mobile has no
// implementation of these 6 methods, and adding them to EzTerminalApi would
// force mobile's transport to stub every one of them (TS2420) just to satisfy
// the shared interface. `window.ezterminalDesktop` is optional on `Window` (see
// shared/window.d.ts) so every call site guards with `?.`.

export interface EzTerminalDesktopApi {
  /** Atomic Adaptive Workbench preferences persisted in desktop settings.json. */
  getUiPreferences: () => Promise<UiPreferences>;
  /** Main validates and atomically merges changed fields, then returns the snapshot. */
  setUiPreferences: (preferences: UiPreferencesPatch) => Promise<UiPreferences>;
  /** Rebuild the native menu after Chromium reports a system-language change. */
  refreshNativeMenuLocale: () => Promise<void>;
  /** Native Ctrl+Tab/escape/release input captured before Chromium consumes it. */
  onRecentPanelInput: (listener: (event: RecentPanelInputEvent) => void) => () => void;
  /** Desktop renderer seam used by `worktree open` to select a fresh terminal
   * rooted at the validated registered worktree. */
  onWorktreeOpenRequested: (listener: (worktree: WorktreeInfo) => void) => () => void;
  /** xterm renderer preference. `auto` tries WebGL and safely falls back to DOM. */
  getTerminalRendererPreference: () => Promise<TerminalRendererPreference>;
  setTerminalRendererPreference: (preference: TerminalRendererPreference) => Promise<void>;
  /** Whether creator-owned panes ask before destroying an active/risky session. */
  getConfirmRiskyPaneClose: () => Promise<boolean>;
  setConfirmRiskyPaneClose: (enabled: boolean) => Promise<void>;
  getAllowOsc52Clipboard: () => Promise<boolean>;
  setAllowOsc52Clipboard: (enabled: boolean) => Promise<void>;
  /** Windows Terminal-style multiline/large text paste warning preferences. */
  getTerminalPastePreferences: () => Promise<TerminalPastePreferences>;
  setTerminalPastePreferences: (preferences: TerminalPastePreferences) => Promise<void>;
  /** User-initiated routing snapshot; image bytes and paths never cross IPC. */
  readTerminalClipboard: () => Promise<TerminalClipboardSnapshot>;
  /** Main rechecks opt-in, size and rate limits before touching the OS clipboard. */
  writeOsc52Clipboard: (text: string) => Promise<boolean>;
  /** Active loopback-only listeners, for the compact Settings summary. */
  listSshForwards: () => Promise<readonly SshForwardInfo[]>;
  stopSshForward: (connectionId: string, forwardId: string) => Promise<SshForwardResult>;
  /** Validate and open only credential-free HTTP(S) URLs in the OS browser. */
  openExternalHttpUrl: (url: string) => Promise<boolean>;
  /** Electron's safe File -> absolute path bridge used by the global drop target. */
  getPathForFile: (file: File) => string | null;

  // Quick Open and main-owned Quick Commands.
  listQuickCommands: () => Promise<readonly QuickCommand[]>;
  createQuickCommand: (input: QuickCommandInput) => Promise<QuickCommandMutationResult>;
  updateQuickCommand: (id: string, input: QuickCommandInput) => Promise<QuickCommandMutationResult>;
  deleteQuickCommand: (id: string) => Promise<QuickCommandMutationResult>;
  onQuickCommandsChanged: (listener: (commands: readonly QuickCommand[]) => void) => () => void;
  searchWorkspaceFiles: (
    request: Omit<WorkspaceFileSearchRequest, 'signal'>,
  ) => Promise<WorkspaceFileSearchResult>;
  cancelWorkspaceFileSearch: (requestId: string) => void;

  /** Custom theme mods folder-scanned from `.ezterminal/themes/*.json` at
   * startup (main/theme-store.ts) — already validated (`ThemeMod`, not raw JSON). */
  getAvailableThemes: () => Promise<ThemeMod[]>;
  /** Validate + persist a pasted/uploaded theme mod so it reappears next launch. */
  importTheme: (json: string) => Promise<{ ok: boolean; error?: string }>;
  /** The persisted FONT_CATALOG id (undefined = use the active theme's own font). */
  getFont: () => Promise<string | undefined>;
  setFont: (id: string) => Promise<void>;
  /** Per-effect on/off overrides, keyed by EffectId. Absent entries default
   * per-platform (desktop: theme-declared default) via `resolveActiveEffects`. */
  getEffectToggles: () => Promise<Record<string, boolean>>;
  setEffectToggles: (toggles: Record<string, boolean>) => Promise<void>;
  /** crt-rollbar line params (rollbar-params) — a partial wire shape; the
   * renderer clamps/defaults absent fields via effect-params.ts's
   * `clampRollbarParams`. */
  getRollbar: () => Promise<RollbarSettings>;
  setRollbar: (params: RollbarSettings) => Promise<void>;
  /** CRT-interference param blob (crt-interference) — one loose record for
   * all parameterized effects; the renderer clamps via effect-params.ts's
   * `clampInterferenceParams` on both read and set. */
  getEffectParams: () => Promise<EffectParamsSettings>;
  setEffectParams: (params: EffectParamsSettings) => Promise<void>;

  // ── Agent hook integration/settings (desktop-only) ──────────────────────
  listAgentIntegrations: () => Promise<readonly AgentIntegrationStatus[]>;
  setAgentIntegrationEnabled: (
    provider: AgentIntegrationProvider,
    enabled: boolean,
  ) => Promise<AgentIntegrationMutationResult>;
  getAgentSettings: () => Promise<AgentSettings>;
  /** Null means validation rejected the payload and nothing was persisted. */
  setAgentSettings: (settings: AgentSettings) => Promise<AgentSettings | null>;
  /** OS notification click asks the owning renderer to reveal this session. */
  onAgentSessionReveal: (listener: (sessionId: string) => void) => () => void;

  // ── OpenClaw management (openclaw-management M1) ────────────────────────
  // `getChatUrl`/the raw token are deliberately ABSENT from this surface —
  // the token never crosses to the renderer (main owns the WebContentsView's
  // `#token=` URL assembly, M3); `isOpenClawChatAvailable` is the only signal
  // the UI needs to decide whether to offer the chat panel/CTA.
  getOpenClawStatus: (force?: boolean) => Promise<OpenClawStatus>;
  runOpenClawLifecycle: (action: OpenClawLifecycleAction) => Promise<OpenClawLifecycleResult>;
  listOpenClawSessions: () => Promise<readonly OpenClawAgentSession[]>;
  getOpenClawConfig: () => Promise<OpenClawCoreConfig>;
  setOpenClawConfig: (key: string, value: string) => Promise<OpenClawSetConfigResult>;
  isOpenClawChatAvailable: () => Promise<boolean>;
  /** Gates the main-side status/log push loops (mirrors `setStatsPanelVisible`). */
  setOpenClawDrawerOpen: (open: boolean) => void;
  onOpenClawStatus: (listener: (status: OpenClawStatus) => void) => () => void;
  onOpenClawLog: (listener: (line: OpenClawLogLine) => void) => () => void;
  /** `gateway install`/`gateway uninstall` (task #9, autostart toggle). */
  runOpenClawAutostart: (action: OpenClawAutostartAction) => Promise<OpenClawAutostartResult>;

  // ── OpenClaw desktop visibility (openclaw-stabilization M2) ──────────────
  // The tri-state setting gating whether ANY OpenClaw UI shows on desktop.
  getOpenClawMode: () => Promise<OpenClawMode>;
  setOpenClawMode: (mode: OpenClawMode) => Promise<void>;
  /** One-shot resolved `{mode, visible}` — 'auto' resolves through the CLI
   * install check (isInstalled), same as `getOpenClawStatus`'s not-installed
   * detection. */
  getOpenClawVisibility: () => Promise<OpenClawVisibility>;
  /** Pushed on every `setOpenClawMode` call (any window), matching
   * `onOpenClawStatus`'s subscription shape. */
  onOpenClawVisibilityChanged: (listener: (visibility: OpenClawVisibility) => void) => () => void;

  // ── OpenClaw chat panel (openclaw-management M3) ────────────────────────
  // The main-owned WebContentsView paints ABOVE the renderer's DOM — this
  // surface is how OpenClawChatPanel.tsx's placeholder drives it, never the
  // reverse. See openclaw-chat-view.ts's module doc for the full lifecycle.
  /** The singleton dockview tab's mount/unmount — gates status push
   * independently of the drawer (openclaw:chat-panel-mounted). */
  setOpenClawChatPanelMounted: (mounted: boolean) => void;
  /** Requests the view be created (only called once status === 'running'). */
  openOpenClawChatView: () => void;
  /** Tears the view down entirely — sent on the panel's unmount. */
  closeOpenClawChatView: () => void;
  /** Rate-limited by the caller (rAF-throttled ResizeObserver) — window-
   * content-relative pixels. */
  setOpenClawChatBounds: (bounds: OpenClawChatBounds) => void;
  /** The single effective-visibility derivation (panel visible ∧ no drawer/
   * palette overlay) — see App.tsx. */
  setOpenClawChatVisible: (visible: boolean) => void;
  /** The placeholder's "재연결" button, shown while `hasError` is true. */
  reloadOpenClawChatView: () => void;
  onOpenClawChatViewState: (listener: (state: OpenClawChatViewState) => void) => () => void;
  /** "브라우저로 열기" escape hatch (openclaw-stabilization M6) — opens the
   * SAME chat URL the embedded WebContentsView uses in the OS default
   * browser (`shell.openExternal`), for when the embed misbehaves. `false`
   * if no chat token is available yet. */
  openOpenClawChatExternal: () => Promise<boolean>;
}
