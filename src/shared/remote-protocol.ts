/**
 * Remote-control WS wire protocol (mobile remote-control M0) — a single
 * WebSocket connection multiplexes every interaction: auth, host-authorized
 * session surfaces, session listing, and concurrent command runs (correlated by
 * `runId`, echoing the shape of the desktop's per-command MessagePort broker
 * in `main.ts`'s `run-command` handler), and the status-panel mirror added in
 * M1 (stats + packet capture, §D1). `ClientToServerMessage`/
 * `ServerToClientMessage` wrap the existing `InterpreterFrame`/
 * `RendererControl`/`SystemStatsSnapshot`/packet-capture types from `ipc.ts`
 * rather than redefining them.
 *
 * `pty-data`'s `Uint8Array` cannot survive `JSON.stringify` — the wire form
 * (`WireInterpreterFrame`) carries it as base64 text instead (decision:
 * simplicity/correctness over throughput for M0). `encodeFrame`/`decodeFrame`
 * isolate this so a later swap to a binary WS frame (header + raw bytes) only
 * touches this module, not the bridge or transport call sites.
 *
 * Authentication requires the exact protocol version. Desktop and Android may
 * be installed independently, so a missing or unsupported version fails
 * closed with a distinct incompatibility response instead of masquerading as
 * a bad token or an endless transient reconnect.
 */
import type {
  DestroySessionGuardResult,
  InterpreterFrame,
  PacketBatchFrame,
  PacketCaptureStatus,
  PtyDataFrame,
  RendererControl,
  RunStartedInfo,
  SessionInfo,
  SystemStatsSnapshot,
} from './ipc';
import type { FileListResult, FileOpResult } from './files';
import type { FilePreviewStreamMetadata } from './file-preview';
import type {
  AgentActivitySnapshot,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
} from './agent';
import type {
  AgentCoordinationMutationResult,
  AgentCoordinationSnapshot,
  ManagedMergeRequest,
} from './agent-coordination';
import type {
  AgentHistorySessionPage,
  AgentLaunchPreparation,
  AgentLaunchStartRequest,
  AgentLaunchStartResult,
  AgentLaunchTarget,
  AgentProjectInput,
  AgentProjectLaunchPreparation,
  AgentProjectLauncherSummary,
  AgentProjectLaunchStartRequest,
  AgentProjectLaunchStartResult,
  AgentProjectMutationResult,
  AgentProjectPage,
  AgentResumePreparation,
  AgentResumeStartRequest,
  AgentResumeStartResult,
  AgentTranscriptPage,
} from './agent-history';
import type { TerminalFileLocationRequest, TerminalFileLocationResult } from './terminal-file-location';
import type { WorktreeRequest, WorktreeResult } from './worktree';
import type { GitDiffResult, GitDirectoryStatus } from './git-status';
import type {
  OpenClawAgentSession,
  OpenClawCoreConfig,
  OpenClawLifecycleAction,
  OpenClawLifecycleResult,
  OpenClawLogLine,
  OpenClawSetConfigResult,
  OpenClawStatus,
} from './openclaw';
import type { QuickCommand } from './quick-command';
import type {
  SessionSurfaceCloseDecision,
  SessionSurfaceCloseEntry,
  SessionSurfaceCommitCloseResult,
  SessionSurfaceIntent,
  SessionSurfaceOpenResult,
  SessionSurfacePrepareCloseResult,
  SessionSurfaceReleaseResult,
} from './session-surface';

export const REMOTE_CAPABILITY_QUICK_COMMANDS_READ = 'quick-commands-read' as const;
export const REMOTE_CAPABILITY_DESKTOP_CONTROL = 'desktop-control-v1' as const;
export type RemoteCapability =
  | typeof REMOTE_CAPABILITY_QUICK_COMMANDS_READ
  | typeof REMOTE_CAPABILITY_DESKTOP_CONTROL;

/**
 * Version markers document when capabilities entered the protocol. v7 is the
 * only accepted wire version: session-surface authority is a security and
 * lifecycle invariant, so v1-v6 fail closed instead of negotiating down.
 *
 * v1 terminal only · v2 added desktop control and client identity · v3 added
 * live Agent approval decisions, Git queries and the latency probe · v4 adds
 * on-demand Agent project/history reads and explicit history resume; v5 adds
 * project management/search and project-rooted fresh Agent launches; v6 adds
 * target-neutral project/direct-directory Agent launches.
 */
export const REMOTE_PROTOCOL_VERSION_DESKTOP_CONTROL = 2 as const;
export const REMOTE_PROTOCOL_VERSION_AGENT_LIVE = 3 as const;
export const REMOTE_PROTOCOL_VERSION_AGENT_HISTORY = 4 as const;
export const REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS = 5 as const;
export const REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS = 6 as const;
export const REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION = 8 as const;
export const REMOTE_PROTOCOL_VERSION = 8 as const;
export type RemoteProtocolVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const SUPPORTED_REMOTE_PROTOCOL_VERSIONS: readonly RemoteProtocolVersion[] = [8];

export function isRemoteProtocolVersion(value: unknown): value is RemoteProtocolVersion {
  return SUPPORTED_REMOTE_PROTOCOL_VERSIONS.includes(value as RemoteProtocolVersion);
}

/** Copy-safe identity shown in About/Diagnostics and release evidence. */
export interface BuildInfo {
  readonly appVersion: string;
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly buildSha: string;
}

// ── Uint8Array <-> base64 (isomorphic: relies only on global atob/btoa, no
//    Node Buffer — this module is shared with the browser-side mobile
//    transport shim, M1) ────────────────────────────────────────────────────

/** Below the safe argument-count ceiling for `String.fromCharCode(...chunk)`. */
const CHUNK_SIZE = 0x8000;

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Wire frame (pty-data's Uint8Array -> base64 text) ────────────────────────

export interface WirePtyDataFrame {
  readonly type: 'pty-data';
  readonly data: string;
  readonly suppressSideEffects?: true;
}

/** Same union as `InterpreterFrame`, except `pty-data` carries base64 text. */
export type WireInterpreterFrame = Exclude<InterpreterFrame, PtyDataFrame> | WirePtyDataFrame;

export function encodeFrame(frame: InterpreterFrame): WireInterpreterFrame {
  if (frame.type === 'pty-data') {
    return frame.suppressSideEffects
      ? { type: 'pty-data', data: uint8ArrayToBase64(frame.data), suppressSideEffects: true }
      : { type: 'pty-data', data: uint8ArrayToBase64(frame.data) };
  }
  return frame;
}

export function decodeFrame(frame: WireInterpreterFrame): InterpreterFrame {
  if (frame.type === 'pty-data') {
    return frame.suppressSideEffects
      ? { type: 'pty-data', data: base64ToUint8Array(frame.data), suppressSideEffects: true }
      : { type: 'pty-data', data: base64ToUint8Array(frame.data) };
  }
  return frame;
}

// ── Client -> server envelopes ───────────────────────────────────────────────

/** Must be the FIRST message on a new connection — anything else closes the socket. */
export interface AuthMessage {
  readonly kind: 'auth';
  readonly token: string;
  readonly protocolVersion: RemoteProtocolVersion;
  readonly clientVersion: string;
  readonly buildSha?: string;
  /** Required to advertise/use desktop control in protocol v2. */
  readonly clientIdentity?: RemoteClientIdentity;
}

export interface RemoteClientIdentity {
  /** Install-scoped random UUID. It is not derived from Android hardware. */
  readonly clientId: string;
  readonly clientName: string;
  readonly platform: 'android';
}

export interface DesktopDisplay {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly rotationDegrees: number;
  readonly primary: boolean;
}

export interface DesktopControlCapabilities {
  readonly ctrlAltDelete: boolean;
  readonly clipboardText: boolean;
  readonly directTouch: boolean;
  readonly multiMonitor: boolean;
  /** New hosts accept viewport-sized adaptive capture hints. */
  readonly adaptiveViewport?: boolean;
  /** New hosts can encode a server-side region for sharp zoom and pan. */
  readonly adaptiveRegion?: boolean;
  /** Ordered preferences accepted by the active native video pipeline. */
  readonly qualityPreferences?: readonly DesktopQualityPreference[];
  /** New hosts consume decoded FPS and visible freeze duration. */
  readonly clientVideoStatsV2?: boolean;
}

export const MIN_DESKTOP_VIEWPORT_PIXELS = 64;
export const MAX_DESKTOP_VIEWPORT_PIXELS = 4_096;

export type DesktopQualityPreference = 'balanced' | 'clarity' | 'responsiveness';

export interface DesktopNormalizedRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopVideoViewport {
  /** Physical pixels available to the decoded video, after device pixel ratio. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** Visible source region in normalized display coordinates. */
  readonly visibleRegion?: DesktopNormalizedRegion;
  /** Monotonic client view revision; zero is reserved for legacy viewports. */
  readonly revision?: number;
}

export type DesktopControlState =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'active'
  | 'reconnecting'
  | 'busy'
  | 'stopping'
  | 'error';

export interface DesktopIceCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export type DesktopSessionSignal =
  | { readonly type: 'offer' | 'answer'; readonly sdp: string }
  | { readonly type: 'ice'; readonly candidate: DesktopIceCandidate };

export interface DesktopControlStartRequest {
  readonly kind: 'desktop-control-start';
  readonly requestId: string;
  readonly viewport?: DesktopVideoViewport;
  readonly qualityPreference?: DesktopQualityPreference;
}

export interface DesktopSignalMessage {
  readonly kind: 'desktop-signal';
  readonly sessionId: string;
  readonly signal: DesktopSessionSignal;
}

export interface DesktopControlStopMessage {
  readonly kind: 'desktop-control-stop';
  readonly sessionId: string;
  readonly reason: 'client-stop' | 'background' | 'navigation';
}

export interface ListSessionsMessage {
  readonly kind: 'list-sessions';
}

/** Ask for every currently-active run across every session (M1 mirror-active-
 * runs gap fix) — no correlation id, FIFO reply (same precedent as `list-sessions`). */
export interface ListRunsMessage {
  readonly kind: 'list-runs';
}

export interface OpenSessionSurfaceRequest {
  readonly kind: 'session-surface-open';
  readonly requestId: string;
  readonly surfaceId: string;
  readonly intent: SessionSurfaceIntent;
}

export interface PrepareSessionSurfaceCloseRequest {
  readonly kind: 'session-surface-prepare-close';
  readonly requestId: string;
  readonly entries: readonly SessionSurfaceCloseEntry[];
}

export interface CommitSessionSurfaceCloseRequest {
  readonly kind: 'session-surface-commit-close';
  readonly requestId: string;
  readonly closeToken: string;
  readonly decisions: readonly SessionSurfaceCloseDecision[];
}

export interface ReleaseSessionSurfaceRequest {
  readonly kind: 'session-surface-release';
  readonly requestId: string;
  readonly bindingId: string;
}

/** Explicit SessionSwitcher administrative action, independent of view ownership. */
export interface TerminateSessionGuardedRequest {
  readonly kind: 'session-terminate-guarded';
  readonly requestId: string;
  readonly sessionId: string;
  readonly expectedActiveRunIds: readonly string[];
}

export interface RunCommandRequest {
  readonly kind: 'run-command';
  /** Client-minted id correlating every `frame`/`control` for this run. */
  readonly runId: string;
  readonly sessionId: string;
  readonly commandText: string;
}

/** Relays a `RendererControl` (cancel/requestRows/pty-input/close/...) for `runId`. */
export interface ControlMessage {
  readonly kind: 'control';
  readonly runId: string;
  readonly control: RendererControl;
}

/**
 * Attach as a non-initiating observer to a run (mirroring, M2) — mirrors
 * `RunCommandRequest`'s shape but never starts a new run. Frames for
 * `runId` (replay-then-live) arrive over the same `frame` messages this
 * connection already gets for its own runs; a `frame` for a `runId` this
 * connection didn't itself `run-command`/`attach-run` simply won't arrive
 * until one of those is sent. `control` messages for `runId` (e.g.
 * `pty-input`) are accepted the same as from the initiator; this
 * connection closing never tears the run down for the initiator or other
 * attachers (last-port-close semantics, owned by main).
 */
export interface AttachRunRequest {
  readonly kind: 'attach-run';
  readonly sessionId: string;
  readonly runId: string;
}

/**
 * Rebind a stable mobile-side port to an active run. Main consumes a parked
 * liveness lease when one still exists, but an initiating installation may
 * also resume after that bounded port lease has expired.
 */
export interface ResumeRunRequest {
  readonly kind: 'resume-run';
  readonly sessionId: string;
  readonly runId: string;
  /** Client connection generation; echoed so stale replies are harmless. */
  readonly generation: number;
}

/**
 * Explicit disconnect releases this installation's run ports instead of
 * leasing them and relinquishes automatic initiator restoration.
 */
export interface ReleaseRunsMessage {
  readonly kind: 'release-runs';
}

/** Tell main whether THIS connection wants the 1Hz stats push (mirrors `setStatsPanelVisible`). */
export interface StatsVisibleMessage {
  readonly kind: 'stats-visible';
  readonly visible: boolean;
}

/** Ask for the last up-to-60 stats snapshots (FIFO reply, no correlation id — same precedent as `list-sessions`). */
export interface StatsHistoryRequest {
  readonly kind: 'stats-history';
}

/** Ask main to broker packet-capture frames to this connection (view-only — desktop owns start/stop). */
export interface PacketsSubscribeMessage {
  readonly kind: 'packets-subscribe';
}

export interface PacketsUnsubscribeMessage {
  readonly kind: 'packets-unsubscribe';
}

export interface AgentSnapshotRequest {
  readonly kind: 'agent-snapshot-get';
  readonly requestId: string;
}

export interface AgentCoordinationSnapshotRequest {
  readonly kind: 'agent-coordination-snapshot-get';
  readonly requestId: string;
}

export interface AgentSeenRequest {
  readonly kind: 'agent-seen';
  readonly requestId: string;
  readonly activityId: string;
  readonly stateSeq: number;
}

export interface ManagedMergeDecisionRequest {
  readonly kind: 'managed-merge-decision';
  readonly requestId: string;
  readonly mergeRequestId: string;
  readonly revision: number;
  readonly decision: 'approve' | 'deny';
}

export interface AgentFollowupRequest {
  readonly kind: 'agent-followup';
  readonly requestId: string;
  readonly activityId: string;
  readonly text: string;
}

/** Protocol v3. A v2 peer never sends this and never has to understand it. */
export interface AgentDecisionRequest {
  readonly kind: 'agent-decision';
  readonly requestId: string;
  readonly activityId: string;
  /** Opaque id of the exact parked provider hook being answered. */
  readonly approvalId: string;
  readonly decision: AgentDecision;
}

export interface AgentProjectsListRequest {
  readonly kind: 'agent-projects-list';
  readonly requestId: string;
  readonly force?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  /** Protocol v5. v4 peers omit it and retain the unfiltered history list. */
  readonly query?: string;
}

export interface AgentProjectSaveRequest {
  readonly kind: 'agent-project-save';
  readonly requestId: string;
  readonly input: AgentProjectInput;
}

export interface AgentProjectRemoveRequest {
  readonly kind: 'agent-project-remove';
  readonly requestId: string;
  readonly projectId: string;
}

export interface AgentProjectLaunchersRequest {
  readonly kind: 'agent-project-launchers';
  readonly requestId: string;
}

export interface AgentProjectPrepareLaunchRequest {
  readonly kind: 'agent-project-prepare-launch';
  readonly requestId: string;
  readonly projectId: string;
  readonly launcherId: string;
}

export interface AgentProjectStartLaunchRequest {
  readonly kind: 'agent-project-start-launch';
  readonly requestId: string;
  readonly request: AgentProjectLaunchStartRequest;
}

export interface AgentLaunchPrepareRequest {
  readonly kind: 'agent-launch-prepare';
  readonly requestId: string;
  readonly target: AgentLaunchTarget;
  readonly launcherId: string;
}

export interface AgentLaunchStartRequestMessage {
  readonly kind: 'agent-launch-start';
  readonly requestId: string;
  readonly request: AgentLaunchStartRequest;
}

export interface AgentHistorySessionsRequest {
  readonly kind: 'agent-history-sessions';
  readonly requestId: string;
  readonly projectId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly force?: boolean;
}

export interface AgentHistoryReadRequest {
  readonly kind: 'agent-history-read';
  readonly requestId: string;
  readonly historyId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentHistoryPrepareResumeRequest {
  readonly kind: 'agent-history-prepare-resume';
  readonly requestId: string;
  readonly historyId: string;
}

export interface AgentHistoryStartResumeRequest {
  readonly kind: 'agent-history-start-resume';
  readonly requestId: string;
  readonly request: AgentResumeStartRequest;
}

export interface WorktreeRequestMessage {
  readonly kind: 'worktree-request';
  readonly requestId: string;
  readonly request: WorktreeRequest;
}

/**
 * Application-level round-trip probe.
 *
 * WebSocket's own ping/pong is answered by the browser's socket stack before
 * any of this code runs, so it proves the connection is alive and tells the
 * app nothing about how long anything took. This one is echoed by the peer's
 * message loop, which is the path every other request actually travels.
 */
export interface PingMessage {
  readonly kind: 'ping';
  /** Connection-generation-scoped correlation id. */
  readonly probeId: string;
  /** Client clock. Echoed verbatim — the server never interprets it, so the
   * two peers do not need agreeing clocks for the difference to be right. */
  readonly sentAt: number;
}

export interface GitStatusRequest {
  readonly kind: 'git-status';
  readonly requestId: string;
  readonly directory: string;
}

export interface GitDiffRequest {
  readonly kind: 'git-diff';
  readonly requestId: string;
  readonly directory: string;
}

// ── File explorer (file-explorer plan, M3) ───────────────────────────────────
// Mirrors the desktop drawer's IPC surface (src/shared/ipc.ts's 8 members),
// framed for the wire — `FileService` on main is the single fs authority for
// both; the bridge's `RemoteFileSource` (remote-bridge.ts) is a thin protocol
// adapter over the exact same method signatures. `requestId` is CLIENT-minted
// (same precedent as `CreateSessionRequest` above); `uploadId` is SERVER-
// minted (it names the `.ezpart` file `FileService.beginUpload` opens), so
// every upload message after `file-upload-begin` correlates by `uploadId`
// instead, not `requestId`.
//
// Streaming contract (file-read / file-upload-chunk): ONE chunk may be in
// flight at a time in EACH direction. A download only sends chunk N+1 after
// the client acks chunk N (`file-read-ack`) — the client has no
// bufferedAmount-style gauge of its own to self-pace on, so the server paces
// it instead. An upload is already client-paced the other way: the client
// only sends its next slice after the previous `file-upload-ack`. Binary
// payloads always travel as base64 text inside JSON (the bridge never sends
// or receives a raw WS binary frame) — reuses `uint8ArrayToBase64`/
// `base64ToUint8Array` above; never redefined here.

/** `''` = the desktop's home dir (mirrors `FileService.listDirectory`). */
export interface FileListRequest {
  readonly kind: 'file-list';
  readonly requestId: string;
  readonly path: string;
}

export interface FileRootsRequest {
  readonly kind: 'file-roots';
  readonly requestId: string;
}

export interface TerminalFileLocationRequestMessage {
  readonly kind: 'terminal-file-location';
  readonly requestId: string;
  readonly request: TerminalFileLocationRequest;
}

/** `'text'` = legacy read-only viewer; `'preview'` = magic-classified rich
 * preview; `'raw'` = a phone download (50MiB cap, no detection). */
export interface FileReadRequest {
  readonly kind: 'file-read';
  readonly requestId: string;
  readonly path: string;
  readonly mode: 'text' | 'raw' | 'preview';
  /** Required only for a preview launched from a terminal link. General file
   * explorer reads omit it and retain their existing behavior. */
  readonly terminalCapability?: string;
}

/** Client ack for one `file-read-chunk` — see the streaming contract above:
 * the server sends chunk N+1 only after receiving the ack for chunk N. */
export interface FileReadAckMessage {
  readonly kind: 'file-read-ack';
  readonly requestId: string;
  readonly offset: number;
}

export interface FileReadCancelMessage {
  readonly kind: 'file-read-cancel';
  readonly requestId: string;
}

export interface FileMkdirRequest {
  readonly kind: 'file-mkdir';
  readonly requestId: string;
  readonly dirPath: string;
  readonly name: string;
}

export interface FileRenameRequest {
  readonly kind: 'file-rename';
  readonly requestId: string;
  readonly path: string;
  readonly newName: string;
}

export interface FileTrashRequest {
  readonly kind: 'file-trash';
  readonly requestId: string;
  readonly path: string;
}

export interface FileUploadBeginRequest {
  readonly kind: 'file-upload-begin';
  readonly requestId: string;
  readonly dirPath: string;
  readonly name: string;
  readonly size: number;
}

/** `uploadId` (not `requestId` — that round trip already completed at
 * `file-upload-begin-reply`) correlates every chunk/commit/abort to the
 * upload it belongs to. */
export interface FileUploadChunkMessage {
  readonly kind: 'file-upload-chunk';
  readonly uploadId: string;
  readonly offset: number;
  /** Base64 — decoded length must be <= `FILE_CHUNK_BYTES`; the bridge hard-
   * rejects (aborts the upload) anything over 2x that as a corrupt/hostile chunk. */
  readonly data: string;
}

export interface FileUploadCommitMessage {
  readonly kind: 'file-upload-commit';
  readonly uploadId: string;
}

export interface FileUploadAbortMessage {
  readonly kind: 'file-upload-abort';
  readonly uploadId: string;
}

// ── OpenClaw management (openclaw-management M4) ────────────────────────────
// Mirrors the desktop drawer's IPC surface (src/shared/openclaw.ts +
// openclaw-service.ts's method names) framed for the wire, same "thin
// protocol adapter over the exact same shapes" precedent as the file
// explorer messages above — `RemoteOpenClawSource` (remote-bridge.ts) adapts
// an `OpenClawService` instance + the proxy's `mintTicket()` to this.
// Status/logs are PUSH subscriptions (mirrors `stats-visible`/
// `packets-subscribe` — no one-shot "get" for either, since the service
// itself already polls/pushes); lifecycle/sessions/config/chat-ticket are
// request/reply, correlated by a CLIENT-minted `requestId` (same precedent
// as `CreateSessionRequest`).

export interface OpenClawStatusSubscribeMessage {
  readonly kind: 'openclaw-status-subscribe';
}

export interface OpenClawStatusUnsubscribeMessage {
  readonly kind: 'openclaw-status-unsubscribe';
}

export interface OpenClawLifecycleRequest {
  readonly kind: 'openclaw-lifecycle';
  readonly requestId: string;
  readonly action: OpenClawLifecycleAction;
}

export interface OpenClawLogsSubscribeMessage {
  readonly kind: 'openclaw-logs-subscribe';
}

export interface OpenClawLogsUnsubscribeMessage {
  readonly kind: 'openclaw-logs-unsubscribe';
}

export interface OpenClawSessionsGetRequest {
  readonly kind: 'openclaw-sessions-get';
  readonly requestId: string;
}

export interface OpenClawConfigGetRequest {
  readonly kind: 'openclaw-config-get';
  readonly requestId: string;
}

export interface OpenClawConfigSetRequest {
  readonly kind: 'openclaw-config-set';
  readonly requestId: string;
  readonly key: string;
  readonly value: string;
}

/** Ask the bridge to mint a fresh chat ticket for the mobile chat embed
 * (M5) — see openclaw-proxy.ts's module doc for the ticket+cookie auth flow
 * this feeds. */
export interface OpenClawChatTicketRequest {
  readonly kind: 'openclaw-chat-ticket';
  readonly requestId: string;
}

/** Capability-gated, read-only Quick Command snapshot for paired mobile. */
export interface QuickCommandsListRequest {
  readonly kind: 'quick-commands-list';
  readonly requestId: string;
}

export type ClientToServerMessage =
  | AuthMessage
  | ListSessionsMessage
  | ListRunsMessage
  | OpenSessionSurfaceRequest
  | PrepareSessionSurfaceCloseRequest
  | CommitSessionSurfaceCloseRequest
  | ReleaseSessionSurfaceRequest
  | TerminateSessionGuardedRequest
  | RunCommandRequest
  | ControlMessage
  | AttachRunRequest
  | ResumeRunRequest
  | ReleaseRunsMessage
  | StatsVisibleMessage
  | StatsHistoryRequest
  | PacketsSubscribeMessage
  | PacketsUnsubscribeMessage
  | AgentSnapshotRequest
  | AgentCoordinationSnapshotRequest
  | AgentSeenRequest
  | ManagedMergeDecisionRequest
  | AgentFollowupRequest
  | AgentDecisionRequest
  | AgentProjectsListRequest
  | AgentProjectSaveRequest
  | AgentProjectRemoveRequest
  | AgentProjectLaunchersRequest
  | AgentProjectPrepareLaunchRequest
  | AgentProjectStartLaunchRequest
  | AgentLaunchPrepareRequest
  | AgentLaunchStartRequestMessage
  | AgentHistorySessionsRequest
  | AgentHistoryReadRequest
  | AgentHistoryPrepareResumeRequest
  | AgentHistoryStartResumeRequest
  | PingMessage
  | GitStatusRequest
  | GitDiffRequest
  | WorktreeRequestMessage
  | FileListRequest
  | FileRootsRequest
  | TerminalFileLocationRequestMessage
  | FileReadRequest
  | FileReadAckMessage
  | FileReadCancelMessage
  | FileMkdirRequest
  | FileRenameRequest
  | FileTrashRequest
  | FileUploadBeginRequest
  | FileUploadChunkMessage
  | FileUploadCommitMessage
  | FileUploadAbortMessage
  | OpenClawStatusSubscribeMessage
  | OpenClawStatusUnsubscribeMessage
  | OpenClawLifecycleRequest
  | OpenClawLogsSubscribeMessage
  | OpenClawLogsUnsubscribeMessage
  | OpenClawSessionsGetRequest
  | OpenClawConfigGetRequest
  | OpenClawConfigSetRequest
  | OpenClawChatTicketRequest
  | QuickCommandsListRequest
  | DesktopControlStartRequest
  | DesktopSignalMessage
  | DesktopControlStopMessage;

// ── Server -> client envelopes ───────────────────────────────────────────────

export interface AuthOkMessage {
  readonly kind: 'auth-ok';
  readonly protocolVersion: RemoteProtocolVersion;
  readonly hostVersion: string;
  readonly hostBuildSha?: string;
  readonly capabilities?: readonly RemoteCapability[];
  /** Present only when this connection authenticated with a one-time pairing
   * code. The client saves it and uses it from then on; without this, pairing
   * would have to be repeated on every launch, which is not pairing. */
  readonly issuedToken?: string;
}

export type AuthFailMessage =
  | {
      readonly kind: 'auth-fail';
      readonly reason: 'invalid-token';
    }
  | {
      readonly kind: 'auth-fail';
      readonly reason: 'incompatible-protocol';
      readonly supportedProtocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      readonly supportedProtocolVersions?: readonly RemoteProtocolVersion[];
      readonly hostVersion: string;
    };

export type DesktopControlStartResultMessage =
  | {
      readonly kind: 'desktop-control-start-result';
      readonly requestId: string;
      readonly ok: true;
      readonly sessionId: string;
      readonly displays: readonly DesktopDisplay[];
      readonly selectedDisplayId: string | null;
      readonly endpoint: { readonly address: string; readonly port: number };
      readonly capabilities: DesktopControlCapabilities;
      readonly resumed: boolean;
    }
  | {
      readonly kind: 'desktop-control-start-result';
      readonly requestId: string;
      readonly ok: false;
      readonly reason: 'busy' | 'unavailable' | 'error';
      readonly controllerName?: string;
      readonly errorCode?: string;
    };

export interface DesktopControlStatusMessage {
  readonly kind: 'desktop-control-status';
  readonly sessionId: string;
  readonly state: DesktopControlState;
  readonly displays?: readonly DesktopDisplay[];
  readonly selectedDisplayId?: string | null;
  readonly qualityTier?: 'high' | 'medium' | 'low' | 'survival';
  readonly framesPerSecond?: number;
  readonly roundTripTimeMs?: number;
  readonly packetLossPercent?: number;
  readonly bitrateKbps?: number;
  readonly streamWidth?: number;
  readonly streamHeight?: number;
  readonly qualityPreference?: DesktopQualityPreference;
  readonly targetFramesPerSecond?: number;
  readonly decodedFramesPerSecond?: number;
  readonly clientDroppedFramePercent?: number;
  readonly clientFreezeDurationMs?: number;
  readonly captureBackend?: 'dxgi' | 'gdi';
  readonly encoderBackend?: 'media-foundation-hardware' | 'openh264-software';
  readonly appliedViewRevision?: number;
  readonly sourceRegion?: DesktopNormalizedRegion;
}

export interface DesktopControlEndedMessage {
  readonly kind: 'desktop-control-ended';
  readonly sessionId: string;
  readonly reason:
    | 'client-stop'
    | 'local-disconnect'
    | 'bridge-disabled'
    | 'token-rotated'
    | 'app-quit'
    | 'peer-timeout'
    | 'service-stopped'
    | 'agent-stopped'
    | 'capture-failed'
    | 'encoder-failed'
    | 'transport-failed';
  readonly errorCode?: string;
}

export interface SessionListMessage {
  readonly kind: 'session-list';
  readonly sessions: readonly SessionInfo[];
}

/**
 * Connection-relative metadata for restoring a run after a full mobile
 * process restart. It is derived from active-run initiator identity rather
 * than the shorter MessagePort lease and does not belong on the
 * origin-agnostic run broadcast.
 */
export interface RemoteRunListEntry extends RunStartedInfo {
  readonly resumeOwned?: true;
}

/** Reply to `list-runs` — every currently-active run (M1 mirror-active-runs). */
export interface RunListMessage {
  readonly kind: 'run-list';
  readonly runs: readonly RemoteRunListEntry[];
}

export interface SessionSurfaceOpenResultMessage {
  readonly kind: 'session-surface-open-result';
  readonly requestId: string;
  readonly result: SessionSurfaceOpenResult;
}

export interface SessionSurfacePrepareCloseResultMessage {
  readonly kind: 'session-surface-prepare-close-result';
  readonly requestId: string;
  readonly result: SessionSurfacePrepareCloseResult;
}

export interface SessionSurfaceCommitCloseResultMessage {
  readonly kind: 'session-surface-commit-close-result';
  readonly requestId: string;
  readonly result: SessionSurfaceCommitCloseResult;
}

export interface SessionSurfaceReleaseResultMessage {
  readonly kind: 'session-surface-release-result';
  readonly requestId: string;
  readonly result: SessionSurfaceReleaseResult;
}

export interface SessionTerminateResultMessage {
  readonly kind: 'session-terminate-result';
  readonly requestId: string;
  readonly result: DestroySessionGuardResult;
}

/** Relays one `InterpreterFrame` (wire-encoded) for `runId`. */
export interface FrameMessage {
  readonly kind: 'frame';
  readonly runId: string;
  readonly frame: WireInterpreterFrame;
}

// ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ────
// Broadcast to EVERY connection (origin-agnostic — including one this same
// connection just created through a session surface, same self-echo shape as
// `ipc.ts`'s `onSessionAdded`/`onSessionRemoved`/`onRunStarted`). A client
// answers `RunStartedMessage` with `attach-run` to mirror that run's frames.

export interface SessionAddedMessage {
  readonly kind: 'session-added';
  readonly session: SessionInfo;
}

export interface SessionRemovedMessage {
  readonly kind: 'session-removed';
  readonly sessionId: string;
}

/** Same fields as `ipc.ts`'s `RunStartedInfo`, framed for the wire. */
export interface RunStartedMessage extends RunStartedInfo {
  readonly kind: 'run-started';
}

/** The shared interpreter utilityProcess died — every session is gone. */
export interface SessionDeadMessage {
  readonly kind: 'session-dead';
  readonly logPath?: string | null;
}

export interface ResumeRunReadyMessage {
  readonly kind: 'resume-run-ready';
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
}

export interface ResumeRunMissingMessage {
  readonly kind: 'resume-run-missing';
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
}

/** The run still exists (or its liveness lease was preserved), but a fresh
 * observer could not be installed. Retryable failures are bounded client-side. */
export interface ResumeRunBusyMessage {
  readonly kind: 'resume-run-busy';
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly reason: 'capacity' | 'unsupported' | 'unavailable';
  readonly retryable: boolean;
}

/** Snapshot push (requestId absent) or reply to agent-snapshot-get. */
export interface AgentSnapshotMessage {
  readonly kind: 'agent-snapshot';
  readonly snapshot: AgentActivitySnapshot;
  readonly requestId?: string;
}

export interface AgentCoordinationSnapshotMessage {
  readonly kind: 'agent-coordination-snapshot';
  readonly snapshot: AgentCoordinationSnapshot;
  readonly requestId?: string;
}

export interface AgentSeenReply {
  readonly kind: 'agent-seen-reply';
  readonly requestId: string;
  readonly marked: boolean;
}

export interface ManagedMergeDecisionReply {
  readonly kind: 'managed-merge-decision-reply';
  readonly requestId: string;
  readonly result: AgentCoordinationMutationResult<ManagedMergeRequest>;
}

export interface AgentFollowupReply {
  readonly kind: 'agent-followup-reply';
  readonly requestId: string;
  readonly result: AgentFollowupResult;
}

export interface AgentDecisionReply {
  readonly kind: 'agent-decision-reply';
  readonly requestId: string;
  readonly result: AgentDecisionResult;
}

export interface AgentProjectsListReply {
  readonly kind: 'agent-projects-list-reply';
  readonly requestId: string;
  readonly result: AgentProjectPage;
}

export interface AgentProjectSaveReply {
  readonly kind: 'agent-project-save-reply';
  readonly requestId: string;
  readonly result: AgentProjectMutationResult;
}

export interface AgentProjectRemoveReply {
  readonly kind: 'agent-project-remove-reply';
  readonly requestId: string;
  readonly removed: boolean;
}

export interface AgentProjectLaunchersReply {
  readonly kind: 'agent-project-launchers-reply';
  readonly requestId: string;
  readonly result: readonly AgentProjectLauncherSummary[];
}

export interface AgentProjectPrepareLaunchReply {
  readonly kind: 'agent-project-prepare-launch-reply';
  readonly requestId: string;
  readonly result: AgentProjectLaunchPreparation;
}

export interface AgentProjectStartLaunchReply {
  readonly kind: 'agent-project-start-launch-reply';
  readonly requestId: string;
  readonly result: AgentProjectLaunchStartResult;
}

export interface AgentLaunchPrepareReply {
  readonly kind: 'agent-launch-prepare-reply';
  readonly requestId: string;
  readonly result: AgentLaunchPreparation;
}

export interface AgentLaunchStartReply {
  readonly kind: 'agent-launch-start-reply';
  readonly requestId: string;
  readonly result: AgentLaunchStartResult;
}

export interface AgentHistorySessionsReply {
  readonly kind: 'agent-history-sessions-reply';
  readonly requestId: string;
  readonly result: AgentHistorySessionPage;
}

export interface AgentHistoryReadReply {
  readonly kind: 'agent-history-read-reply';
  readonly requestId: string;
  readonly result: AgentTranscriptPage | null;
}

export interface AgentHistoryPrepareResumeReply {
  readonly kind: 'agent-history-prepare-resume-reply';
  readonly requestId: string;
  readonly result: AgentResumePreparation | null;
}

export interface AgentHistoryStartResumeReply {
  readonly kind: 'agent-history-start-resume-reply';
  readonly requestId: string;
  readonly result: AgentResumeStartResult;
}

export interface PongMessage {
  readonly kind: 'pong';
  readonly probeId: string;
  readonly sentAt: number;
}

export interface GitStatusReply {
  readonly kind: 'git-status-reply';
  readonly requestId: string;
  readonly status: GitDirectoryStatus;
}

export interface GitDiffReply {
  readonly kind: 'git-diff-reply';
  readonly requestId: string;
  readonly result: GitDiffResult;
}

/** One 1Hz stats push while this connection has `stats-visible:true`. */
export interface StatsUpdateMessage {
  readonly kind: 'stats-update';
  readonly snapshot: SystemStatsSnapshot;
}

/** Reply to `stats-history`. */
export interface StatsHistoryReply {
  readonly kind: 'stats-history';
  readonly snapshots: readonly SystemStatsSnapshot[];
}

/** `'idle'` = the desktop isn't capturing right now (distinct from any `PacketCaptureStatus`). */
export type RemotePacketStatus = PacketCaptureStatus | 'idle';

/** Same shape as the desktop's packet-port frames, except `status` widens to include `'idle'`. */
export type RemotePacketFrame = PacketBatchFrame | { readonly type: 'status'; readonly status: RemotePacketStatus };

/** One packet-capture frame (batch or status), relayed while this connection subscribes. */
export interface PacketFrameMessage {
  readonly kind: 'packet-frame';
  readonly frame: RemotePacketFrame;
}

// ── File explorer (file-explorer plan, M3) — replies for the client messages above ──

export interface FileListReply {
  readonly kind: 'file-list-reply';
  readonly requestId: string;
  readonly result: FileListResult;
}

export interface FileRootsReply {
  readonly kind: 'file-roots-reply';
  readonly requestId: string;
  readonly roots: readonly string[];
}

export interface TerminalFileLocationReply {
  readonly kind: 'terminal-file-location-reply';
  readonly requestId: string;
  readonly result: TerminalFileLocationResult;
}

/** `ok:false` OR `isText:false` ENDS the exchange — no `file-read-chunk` ever
 * follows either case (mirrors `FileService.openReadStream`'s meta, plus the
 * failure branch `openReadStream` itself returns). */
export type FileReadMetaMessage =
  | {
      readonly kind: 'file-read-meta';
      readonly requestId: string;
      readonly ok: true;
      readonly fileSize: number;
      readonly sendBytes: number;
      readonly isText: boolean;
      readonly truncated: boolean;
      readonly preview?: FilePreviewStreamMetadata;
    }
  | {
      readonly kind: 'file-read-meta';
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export interface FileReadChunkMessage {
  readonly kind: 'file-read-chunk';
  readonly requestId: string;
  readonly offset: number;
  /** Base64 — see the streaming contract above `ClientToServerMessage`. */
  readonly data: string;
  readonly done: boolean;
}

/** Shared reply shape for `file-mkdir`/`file-rename`/`file-trash` — all three
 * resolve to a plain `FileOpResult` on `FileService`. */
export interface FileOpReply {
  readonly kind: 'file-op-reply';
  readonly requestId: string;
  readonly result: FileOpResult;
}

export type FileUploadBeginReply =
  | {
      readonly kind: 'file-upload-begin-reply';
      readonly requestId: string;
      readonly ok: true;
      readonly uploadId: string;
      readonly finalName: string;
    }
  | {
      readonly kind: 'file-upload-begin-reply';
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

/** `ok:false` means the server already aborted (and unlinked the `.ezpart`
 * file for) this upload — the client must not send further chunks for it. */
export type FileUploadAckMessage =
  | { readonly kind: 'file-upload-ack'; readonly uploadId: string; readonly ok: true; readonly receivedBytes: number }
  | { readonly kind: 'file-upload-ack'; readonly uploadId: string; readonly ok: false; readonly error: string };

export type FileUploadDoneMessage =
  | { readonly kind: 'file-upload-done'; readonly uploadId: string; readonly ok: true; readonly finalName: string }
  | { readonly kind: 'file-upload-done'; readonly uploadId: string; readonly ok: false; readonly error: string };

// ── OpenClaw management (openclaw-management M4) — replies for the client
// messages above. `openclaw-log-lines` is coalesced ~500ms per connection
// (same batching/backpressure-skip pattern as `packet-frame` — see
// remote-bridge.ts's `MOBILE_PACKET_FLUSH_MS`/`MOBILE_PACKET_PENDING_CAP`/
// `MOBILE_PACKET_BACKPRESSURE_BYTES`), never sent one line at a time. ────────

export interface OpenClawStatusMessage {
  readonly kind: 'openclaw-status';
  readonly status: OpenClawStatus;
}

/** Effective OpenClaw visibility on the DESKTOP side (openclaw-stabilization
 * M3) — sent once right after auth-ok, and again to every authed connection
 * whenever the desktop's tri-state `openclawMode` changes, so a phone can
 * show/hide its own OpenClaw entry points without polling. Unlike
 * `openclaw-status`, there is no subscribe/unsubscribe pair for this one —
 * every authed connection gets it unconditionally (see remote-bridge.ts's
 * `RemoteOpenClawSource.subscribeVisibility`). */
export interface OpenClawAvailabilityMessage {
  readonly kind: 'openclaw-availability';
  readonly visible: boolean;
}

export interface OpenClawLifecycleResultMessage {
  readonly kind: 'openclaw-lifecycle-result';
  readonly requestId: string;
  readonly result: OpenClawLifecycleResult;
}

export interface OpenClawLogLinesMessage {
  readonly kind: 'openclaw-log-lines';
  readonly lines: readonly OpenClawLogLine[];
}

export interface OpenClawSessionsReply {
  readonly kind: 'openclaw-sessions-reply';
  readonly requestId: string;
  readonly sessions: readonly OpenClawAgentSession[];
}

export interface OpenClawConfigReply {
  readonly kind: 'openclaw-config-reply';
  readonly requestId: string;
  readonly config: OpenClawCoreConfig;
}

export interface OpenClawConfigSetReply {
  readonly kind: 'openclaw-config-set-reply';
  readonly requestId: string;
  readonly result: OpenClawSetConfigResult;
}

/** `ticket`/`token` are `null` when no ticket could be minted (proxy not
 * running, or no gateway token available) — `proxyPort` is `0` in that case
 * too. The client assembles the chat URL itself from the host it already
 * dials (`http://<host>:<proxyPort>/?t=<ticket>#token=<token>`) — this
 * server never guesses which of its own reachable IPs the client used. */
export type OpenClawChatTicketFailureReason =
  | 'gateway-stopped'
  | 'gateway-unreachable'
  | 'token-unavailable'
  | 'proxy-unavailable'
  | 'insecure-auth-required'
  | 'timeout';

export interface OpenClawChatTicketReply {
  readonly kind: 'openclaw-chat-ticket-reply';
  readonly requestId: string;
  readonly ticket: string | null;
  readonly proxyPort: number;
  readonly token: string | null;
  /** Present on failure; optional on the wire so older saved fixtures remain readable. */
  readonly reason?: OpenClawChatTicketFailureReason;
}

export type QuickCommandsListReply =
  | {
      readonly kind: 'quick-commands-list-reply';
      readonly requestId: string;
      readonly ok: true;
      readonly commands: readonly QuickCommand[];
    }
  | {
      readonly kind: 'quick-commands-list-reply';
      readonly requestId: string;
      readonly ok: false;
      readonly error: 'unavailable';
    };

export interface WorktreeReplyMessage {
  readonly kind: 'worktree-reply';
  readonly requestId: string;
  readonly result: WorktreeResult;
}

export type ServerToClientMessage =
  | AuthOkMessage
  | AuthFailMessage
  | SessionListMessage
  | RunListMessage
  | SessionSurfaceOpenResultMessage
  | SessionSurfacePrepareCloseResultMessage
  | SessionSurfaceCommitCloseResultMessage
  | SessionSurfaceReleaseResultMessage
  | SessionTerminateResultMessage
  | FrameMessage
  | ResumeRunReadyMessage
  | ResumeRunMissingMessage
  | ResumeRunBusyMessage
  | SessionAddedMessage
  | SessionRemovedMessage
  | RunStartedMessage
  | SessionDeadMessage
  | AgentSnapshotMessage
  | AgentCoordinationSnapshotMessage
  | AgentSeenReply
  | ManagedMergeDecisionReply
  | AgentFollowupReply
  | AgentDecisionReply
  | AgentProjectsListReply
  | AgentProjectSaveReply
  | AgentProjectRemoveReply
  | AgentProjectLaunchersReply
  | AgentProjectPrepareLaunchReply
  | AgentProjectStartLaunchReply
  | AgentLaunchPrepareReply
  | AgentLaunchStartReply
  | AgentHistorySessionsReply
  | AgentHistoryReadReply
  | AgentHistoryPrepareResumeReply
  | AgentHistoryStartResumeReply
  | PongMessage
  | GitStatusReply
  | GitDiffReply
  | WorktreeReplyMessage
  | StatsUpdateMessage
  | StatsHistoryReply
  | PacketFrameMessage
  | FileListReply
  | FileRootsReply
  | TerminalFileLocationReply
  | FileReadMetaMessage
  | FileReadChunkMessage
  | FileOpReply
  | FileUploadBeginReply
  | FileUploadAckMessage
  | FileUploadDoneMessage
  | OpenClawStatusMessage
  | OpenClawAvailabilityMessage
  | OpenClawLifecycleResultMessage
  | OpenClawLogLinesMessage
  | OpenClawSessionsReply
  | OpenClawConfigReply
  | OpenClawConfigSetReply
  | OpenClawChatTicketReply
  | QuickCommandsListReply
  | DesktopControlStartResultMessage
  | DesktopSignalMessage
  | DesktopControlStatusMessage
  | DesktopControlEndedMessage;
