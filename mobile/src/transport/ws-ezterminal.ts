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
  type InterpreterFrame,
  type RemoteConnectionInfo,
  type RemoteRuntimeStatus,
  type RendererControl,
  type RunStartedInfo,
  type RuntimeVersions,
  type SessionInfo,
  type SystemStatsSnapshot,
} from '../../../src/shared/ipc';
import {
  DOWNLOAD_MAX_FILE_BYTES,
  FILE_CHUNK_BYTES,
  TEXT_VIEW_MAX_BYTES,
  type FileListResult,
  type FileOpResult,
  type FileReadTextResult,
} from '../../../src/shared/files';
import {
  IMAGE_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_DIMENSION,
  IMAGE_PREVIEW_MAX_PIXELS,
  type FilePreviewResult,
  type FilePreviewStreamMetadata,
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
import { isPairingCode, isRemoteBearerToken } from '../../../src/shared/pairing';
import {
  EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  MAX_AGENT_PROVIDER_LABEL_LENGTH,
  type AgentActivitySnapshot,
  type AgentDecision,
  type AgentDecisionResult,
  type AgentFollowupResult,
} from '../../../src/shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationMutationResult,
  type AgentCoordinationSnapshot,
  type AgentParticipant,
  type AgentParticipantInput,
  type AgentProjectCoordination,
  type AgentProjectCoordinationInput,
  type ManagedMergeDecisionInput,
  type ManagedMergeGrantInput,
  type ManagedMergeRequest,
} from '../../../src/shared/agent-coordination';
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
} from '../../../src/shared/agent-history';
import {
  UNAVAILABLE_GIT_DIRECTORY_STATUS,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../../../src/shared/git-status';
import {
  base64ToUint8Array,
  decodeFrame,
  REMOTE_CAPABILITY_DESKTOP_CONTROL,
  REMOTE_CAPABILITY_QUICK_COMMANDS_READ,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION_AGENT_HISTORY,
  REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS,
  REMOTE_PROTOCOL_VERSION_AGENT_LIVE,
  REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS,
  REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION,
  uint8ArrayToBase64,
  type BuildInfo,
  type ClientToServerMessage,
  type DesktopControlEndedMessage,
  type DesktopControlStartResultMessage,
  type DesktopControlStatusMessage,
  type DesktopQualityPreference,
  type DesktopVideoViewport,
  type DesktopSessionSignal,
  type DesktopSignalMessage,
  type OpenClawChatTicketFailureReason,
  type RemoteCapability,
  type RemoteClientIdentity,
  type RemotePacketFrame,
  type RemoteProtocolVersion,
  type ServerToClientMessage,
} from '../../../src/shared/remote-protocol';
import type {
  SessionSurfaceCloseDecision,
  SessionSurfaceCloseEntry,
  SessionSurfaceCommitCloseResult,
  SessionSurfaceIntent,
  SessionSurfaceOpenResult,
  SessionSurfacePrepareCloseResult,
  SessionSurfaceReleaseResult,
} from '../../../src/shared/session-surface';
import {
  MAX_QUICK_COMMANDS,
  QuickCommandSchema,
  type QuickCommand,
} from '../../../src/shared/quick-command';
import {
  OPENCLAW_CONFIG_ALLOWLIST,
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawControlSnapshot,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleReceipt,
  type OpenClawLogLine,
  type OpenClawSetConfigResult,
  type OpenClawStatus,
} from '../../../src/shared/openclaw';
import {
  classifyEndpoint,
  smoothRoundTrip,
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

type FileReadMode = 'text' | 'raw' | 'preview';

/** Tracks one in-flight `file-read` request between `file-read-meta` and the
 * last `file-read-chunk` — `buffer` is allocated once `sendBytes` is known
 * (null beforehand, and stays null for a binary file in `'text'` mode, which
 * never streams any chunk). `onProgress` is only used by `downloadFile`. */
interface FileReadAssembly {
  buffer: Uint8Array | null;
  metaReceived: boolean;
  expectedOffset: number | null;
  readonly mode: FileReadMode;
  readonly maxSendBytes: number;
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
/**
 * Post-auth liveness (silent-socket detection): the desktop's WS-protocol
 * pings are answered by the browser's network stack and are invisible here,
 * so an idle-but-healthy link and a silently dead one (radio loss, NAT/VPN
 * drop with no RST) look identical from JS — and reconnects are otherwise
 * scheduled only from a real 'close' event, leaving a dead socket frozen on
 * screen forever. After `LIVENESS_IDLE_MS` without any server message, probe
 * with the cheapest existing request/reply (`list-runs` — no protocol change,
 * works against every desktop version); no server message within
 * `LIVENESS_PROBE_TIMEOUT_MS` of the probe means the socket is dead and is
 * force-closed so the ordinary backoff → reconnect → resume-run path repairs
 * the session. Background timer throttling only delays the probe; on
 * foreground return the throttled timers fire and a dead socket is detected
 * immediately.
 */
/** Often enough that the pill is current, rare enough to be free on a radio. */
const RTT_PROBE_INTERVAL_MS = 5_000;
/** Anything past this is a suspended tab or a clock jump, not a round trip. */
const RTT_MAX_PLAUSIBLE_MS = 60_000;

const LIVENESS_IDLE_MS = 45_000;
const LIVENESS_PROBE_TIMEOUT_MS = 10_000;
const LIVENESS_CHECK_INTERVAL_MS = 15_000;
const RESUME_RETRY_INITIAL_MS = 250;
const RESUME_RETRY_MAX_MS = 4000;
const RESUME_RETRY_MAX_ATTEMPTS = 5;
const MAX_GUARDED_DESTROY_ID_LENGTH = 256;
const MAX_REMOTE_AGENT_ITEMS = 2_048;
const MAX_REMOTE_AGENT_ID_LENGTH = 256;
const MAX_REMOTE_AGENT_CWD_LENGTH = 8_192;
const MAX_REMOTE_AGENT_TOOL_LENGTH = 256;
const MAX_REMOTE_AGENT_COMMAND_LENGTH = 64 * 1_024;
const MAX_REMOTE_AGENT_FOLLOWUP_LENGTH = 8_192;
const MAX_REMOTE_GIT_CHANGES = 2_000;
const MAX_REMOTE_GIT_OMISSIONS = 2_000;
const MAX_REMOTE_GIT_PATH_LENGTH = 8_192;
const MAX_REMOTE_GIT_BRANCH_LENGTH = 1_024;
const MAX_REMOTE_GIT_DIFF_LENGTH = 200_000;
const MAX_FILE_CHUNK_BASE64_CHARS = Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 4;

function maxFileReadBytes(mode: FileReadMode): number {
  if (mode === 'text') return TEXT_VIEW_MAX_BYTES;
  if (mode === 'preview') return IMAGE_PREVIEW_MAX_BYTES;
  return DOWNLOAD_MAX_FILE_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilePreviewStreamMetadata(value: unknown): value is FilePreviewStreamMetadata {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  switch (value.kind) {
    case 'text':
      return value.mime === 'text/plain' || value.mime === 'text/markdown';
    case 'image':
      return (
        (
          value.mime === 'image/png'
          || value.mime === 'image/jpeg'
          || value.mime === 'image/gif'
          || value.mime === 'image/webp'
        )
        && Number.isSafeInteger(value.width)
        && Number.isSafeInteger(value.height)
        && (value.width as number) > 0
        && (value.height as number) > 0
        && (value.width as number) <= IMAGE_PREVIEW_MAX_DIMENSION
        && (value.height as number) <= IMAGE_PREVIEW_MAX_DIMENSION
        && (value.width as number) * (value.height as number) <= IMAGE_PREVIEW_MAX_PIXELS
      );
    case 'pdf':
      return value.mime === 'application/pdf';
    case 'unsupported':
      return (
        value.reason === 'binary'
        || value.reason === 'image-too-large'
        || value.reason === 'image-dimensions'
        || value.reason === 'invalid-image'
      );
    default:
      return false;
  }
}

function isFileReadMetaConsistent(
  assembly: FileReadAssembly,
  fileSize: number,
  sendBytes: number,
  isText: boolean,
  truncated: boolean,
  preview: unknown,
): boolean {
  if (assembly.mode === 'raw') {
    return (
      preview === undefined
      && isText
      && !truncated
      && sendBytes === fileSize
      && fileSize <= DOWNLOAD_MAX_FILE_BYTES
    );
  }

  const expectedTextBytes = Math.min(fileSize, TEXT_VIEW_MAX_BYTES);
  if (assembly.mode === 'text') {
    if (preview !== undefined) return false;
    return isText
      ? sendBytes === expectedTextBytes && truncated === (fileSize > TEXT_VIEW_MAX_BYTES)
      : sendBytes === 0 && !truncated;
  }

  if (!isFilePreviewStreamMetadata(preview)) return false;
  switch (preview.kind) {
    case 'text':
      return isText
        && sendBytes === expectedTextBytes
        && truncated === (fileSize > TEXT_VIEW_MAX_BYTES);
    case 'image':
      return !isText
        && !truncated
        && fileSize <= IMAGE_PREVIEW_MAX_BYTES
        && sendBytes === fileSize;
    case 'pdf':
    case 'unsupported':
      return !isText && !truncated && sendBytes === 0;
  }
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
  );
}

/**
 * `JSON.parse` does not make a wire payload trustworthy. Keep malformed or
 * unbounded desktop snapshots out of React state instead of relying on a
 * compile-time cast that disappears at runtime.
 */
function isAgentActivitySnapshot(value: unknown): value is AgentActivitySnapshot {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !Array.isArray(value.items)
    || value.items.length > MAX_REMOTE_AGENT_ITEMS
  ) return false;

  return value.items.every((item) => {
    if (
      !isRecord(item)
      || !isBoundedString(item.id, MAX_REMOTE_AGENT_ID_LENGTH)
      || !isBoundedString(item.sessionId, MAX_REMOTE_AGENT_ID_LENGTH)
      || (item.provider !== 'codex' && item.provider !== 'claude' && item.provider !== 'generic')
      || (item.providerLabel !== undefined
        && !isBoundedString(item.providerLabel, MAX_AGENT_PROVIDER_LABEL_LENGTH))
      || !isBoundedString(item.cwd, MAX_REMOTE_AGENT_CWD_LENGTH, true)
      || (
        item.state !== 'starting'
        && item.state !== 'working'
        && item.state !== 'blocked'
        && item.state !== 'done'
        && item.state !== 'idle'
        && item.state !== 'error'
        && item.state !== 'unknown'
      )
      || item.status !== item.state
      || !Number.isSafeInteger(item.stateSeq)
      || (item.stateSeq as number) < 1
      || typeof item.live !== 'boolean'
      || typeof item.interactiveReady !== 'boolean'
      || (
        item.stateSource !== 'process'
        && item.stateSource !== 'provider-hook'
        && item.stateSource !== 'terminal'
        && item.stateSource !== 'unknown'
      )
      || !isFiniteTimestamp(item.createdAt)
      || !isFiniteTimestamp(item.updatedAt)
    ) return false;
    if (
      (item.projectId !== undefined && !isBoundedString(item.projectId, MAX_REMOTE_AGENT_ID_LENGTH))
      || (item.workspaceId !== undefined && !isBoundedString(item.workspaceId, MAX_REMOTE_AGENT_ID_LENGTH))
    ) return false;
    if (item.participant !== undefined) {
      if (
        !isRecord(item.participant)
        || !isBoundedString(item.participant.participantId, MAX_REMOTE_AGENT_ID_LENGTH)
        || !isBoundedString(item.participant.projectId, MAX_REMOTE_AGENT_ID_LENGTH)
        || !isBoundedString(item.participant.workspaceId, MAX_REMOTE_AGENT_ID_LENGTH)
        || (item.participant.worktreeId !== undefined
          && !isBoundedString(item.participant.worktreeId, MAX_REMOTE_AGENT_ID_LENGTH))
        || !isBoundedString(item.participant.alias, 48)
        || !isBoundedString(item.participant.role, 120)
        || !isBoundedString(item.participant.task, 1_000)
      ) return false;
    }
    if (item.approval === undefined) return true;
    if (
      !isRecord(item.approval)
      || !isBoundedString(item.approval.approvalId, MAX_REMOTE_AGENT_ID_LENGTH)
      || !isBoundedString(item.approval.toolName, MAX_REMOTE_AGENT_TOOL_LENGTH, true)
      || (
        item.approval.command !== undefined
        && !isBoundedString(item.approval.command, MAX_REMOTE_AGENT_COMMAND_LENGTH, true)
      )
      || (
        item.approval.risk !== 'danger'
        && item.approval.risk !== 'write'
        && item.approval.risk !== 'read'
      )
      || typeof item.approval.pending !== 'boolean'
      || !isFiniteTimestamp(item.approval.requestedAt)
      || !isFiniteTimestamp(item.approval.expiresAt)
      || item.approval.expiresAt < item.approval.requestedAt
    ) return false;
    return true;
  });
}

function isManagedMergeRequest(value: unknown): value is ManagedMergeRequest {
  if (!isRecord(value)) return false;
  const states = new Set([
    'preparing', 'validating', 'approval-required', 'override-required', 'merging',
    'merged', 'denied', 'conflict', 'stale', 'failed', 'interrupted', 'already-integrated',
  ]);
  if (
    !isBoundedString(value.requestId, MAX_REMOTE_AGENT_ID_LENGTH)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || !isBoundedString(value.projectId, MAX_REMOTE_AGENT_ID_LENGTH)
    || !isBoundedString(value.participantId, MAX_REMOTE_AGENT_ID_LENGTH)
    || !isBoundedString(value.activityId, MAX_REMOTE_AGENT_ID_LENGTH)
    || !isBoundedString(value.sourceWorkspaceId, MAX_REMOTE_AGENT_ID_LENGTH)
    || !isBoundedString(value.sourceBranch, 200)
    || !isBoundedString(value.sourceHead, 128)
    || !isBoundedString(value.targetBranch, 200)
    || !isBoundedString(value.targetHead, 128, true)
    || (value.candidateHead !== undefined && !isBoundedString(value.candidateHead, 128))
    || typeof value.state !== 'string'
    || !states.has(value.state)
    || !Number.isSafeInteger(value.validationConfigRevision)
    || !Array.isArray(value.validations)
    || value.validations.length > 8
    || (value.warning !== undefined && !isBoundedString(value.warning, 1_000, true))
    || (value.error !== undefined && !isBoundedString(value.error, 1_000, true))
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.updatedAt)
    || !isFiniteTimestamp(value.expiresAt)
  ) return false;
  return value.validations.every((validation) => (
    isRecord(validation)
    && isBoundedString(validation.id, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(validation.name, 120)
    && typeof validation.status === 'string'
    && ['pending', 'running', 'passed', 'failed', 'timed-out', 'cancelled'].includes(validation.status)
    // Coordination wire messages carry status metadata, never validation
    // output. The desktop keeps that bounded tail local to its review UI.
    && validation.outputTail === undefined
    && (validation.outputTruncated === undefined || typeof validation.outputTruncated === 'boolean')
    && (validation.startedAt === undefined || isFiniteTimestamp(validation.startedAt))
    && (validation.finishedAt === undefined || isFiniteTimestamp(validation.finishedAt))
    && (validation.durationMs === undefined
      || (typeof validation.durationMs === 'number' && Number.isFinite(validation.durationMs) && validation.durationMs >= 0))
    && (validation.exitCode === undefined
      || (typeof validation.exitCode === 'number' && Number.isSafeInteger(validation.exitCode)))
  ));
}

function isAgentCoordinationSnapshot(value: unknown): value is AgentCoordinationSnapshot {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !Number.isSafeInteger(value.activityRevision)
    || !Array.isArray(value.activities)
    || !Array.isArray(value.projects)
    || value.projects.length > 256
    || !Array.isArray(value.mergeRequests)
    || value.mergeRequests.length > 256
    || !isAgentActivitySnapshot({ revision: value.activityRevision, items: value.activities })
  ) return false;
  const projectsValid = value.projects.every((project) => (
    isRecord(project)
    && isBoundedString(project.projectId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(project.goal, 2_000)
    && isBoundedString(project.defaultTargetBranch, 200)
    && Array.isArray(project.validationCommands)
    && project.validationCommands.length <= 8
    && project.validationCommands.every((command) => (
      isRecord(command)
      && isBoundedString(command.id, MAX_REMOTE_AGENT_ID_LENGTH)
      && isBoundedString(command.name, 120)
      && isBoundedString(command.command, 8_192)
      && Number.isFinite(command.timeoutMs)
      && (command.timeoutMs as number) >= 1_000
      && (command.timeoutMs as number) <= 30 * 60_000
    ))
    && Number.isSafeInteger(project.configRevision)
    && isAgentStateCounts(project.counts)
    && Array.isArray(project.participants)
    && project.participants.length <= 32
    && project.participants.every(isAgentParticipantWire)
    && Number.isSafeInteger(project.pendingMergeCount)
  ));
  return projectsValid && value.mergeRequests.every(isManagedMergeRequest);
}

function isManagedMergeMutationResult(
  value: unknown,
): value is AgentCoordinationMutationResult<ManagedMergeRequest> {
  return isRecord(value) && (
    (value.ok === true && isManagedMergeRequest(value.value))
    || (
      value.ok === false
      && ['invalid', 'not-found', 'stale', 'conflict', 'unavailable'].includes(String(value.error))
      && isBoundedString(value.message, 1_000, true)
    )
  );
}

function isAgentParticipantWire(value: unknown): boolean {
  return isRecord(value)
    && isBoundedString(value.participantId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(value.projectId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(value.activityId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(value.sessionId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(value.workspaceId, MAX_REMOTE_AGENT_ID_LENGTH)
    && (value.worktreeId === undefined || isBoundedString(value.worktreeId, MAX_REMOTE_AGENT_ID_LENGTH))
    && isBoundedString(value.alias, 48)
    && isBoundedString(value.role, 120)
    && isBoundedString(value.task, 1_000)
    && (value.provider === 'codex' || value.provider === 'claude')
    && value.joined === true
    && isFiniteTimestamp(value.joinedAt)
    && isFiniteTimestamp(value.updatedAt);
}

function isAgentStateCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['starting', 'working', 'blocked', 'done', 'idle', 'error', 'unknown'].every((state) => (
    Number.isSafeInteger(value[state]) && (value[state] as number) >= 0
  ));
}

function isAgentFollowupResult(value: unknown): value is AgentFollowupResult {
  return isRecord(value) && (
    value.ok === true
    || (
      value.ok === false
      && (
        value.error === 'not-found'
        || value.error === 'not-waiting'
        || value.error === 'not-ready'
        || value.error === 'invalid-text'
        || value.error === 'session-ended'
        || value.error === 'delivery-failed'
      )
    )
  );
}

function isAgentDecisionResult(value: unknown): value is AgentDecisionResult {
  return isRecord(value) && (
    value.ok === true
    || (
      value.ok === false
      && (
        value.error === 'not-found'
        || value.error === 'not-pending'
        || value.error === 'expired'
        || value.error === 'stale'
        || value.error === 'conflict'
        || value.error === 'delivery-failed'
        || value.error === 'outcome-unknown'
      )
    )
  );
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (
    Number.isSafeInteger(value)
    && (value as number) >= 0
  );
}

function isSafeRelativeGitPath(value: unknown): value is string {
  if (
    !isBoundedString(value, MAX_REMOTE_GIT_PATH_LENGTH)
    || value.includes('\0')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
  ) return false;
  return value.split(/[\\/]/u).every((segment) => segment !== '..');
}

function isGitDirectoryStatus(value: unknown): value is GitDirectoryStatus {
  if (
    !isRecord(value)
    || !Array.isArray(value.changes)
    || value.changes.length > MAX_REMOTE_GIT_CHANGES
  ) return false;
  if (value.availability === 'ready') {
    if (
      value.tracked !== true
      || typeof value.truncated !== 'boolean'
      || (
        value.branch !== undefined
        && !isBoundedString(value.branch, MAX_REMOTE_GIT_BRANCH_LENGTH)
      )
    ) return false;
    return value.changes.every((change) => (
      isRecord(change)
      && isSafeRelativeGitPath(change.path)
      && (
        change.kind === 'added'
        || change.kind === 'modified'
        || change.kind === 'deleted'
        || change.kind === 'renamed'
        || change.kind === 'untracked'
        || change.kind === 'conflicted'
      )
      && isOptionalNonNegativeInteger(change.added)
      && isOptionalNonNegativeInteger(change.removed)
    ));
  }
  return (
    (value.availability === 'not-a-repository' || value.availability === 'unavailable')
    && value.tracked === false
    && value.branch === undefined
    && value.changes.length === 0
    && value.truncated === false
  );
}

function isGitDiffResult(value: unknown): value is GitDiffResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) {
    return (
      value.error === 'not-a-repository'
      || value.error === 'invalid-path'
      || value.error === 'git-failed'
    );
  }
  if (
    typeof value.text !== 'string'
    || value.text.length > MAX_REMOTE_GIT_DIFF_LENGTH
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.omissions)
    || value.omissions.length > MAX_REMOTE_GIT_OMISSIONS
  ) return false;
  return value.omissions.every((omission) => (
    isRecord(omission)
    && isSafeRelativeGitPath(omission.path)
    && (
      omission.reason === 'binary'
      || omission.reason === 'symlink'
      || omission.reason === 'too-large'
      || omission.reason === 'unsupported'
      || omission.reason === 'read-failed'
      || omission.reason === 'budget-exhausted'
    )
  ));
}

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
/** An approval may already have executed when its reply is lost. Keep the
 * exact idempotency key alive across a short reconnect window instead of
 * reporting a false failure. */
const AGENT_DECISION_RETRY_WINDOW_MS = 60_000;

interface PendingAgentDecision {
  readonly activityId: string;
  readonly approvalId: string;
  readonly decision: AgentDecision;
  readonly resolve: (result: AgentDecisionResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  readonly clientIdentity?: RemoteClientIdentity;
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
  /** Test seams for the post-auth liveness monitor (silent-socket detection). */
  readonly livenessIdleMs?: number;
  readonly livenessProbeTimeoutMs?: number;
  readonly livenessCheckMs?: number;
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

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

export class WsEzTerminalTransport implements EzTerminalApi {
  /** Not meaningful for a remote WS client — no local Electron/Chrome/Node process. */
  readonly versions: RuntimeVersions;

  private readonly url: string;
  /** Replaced in place when the host issues a bearer after a code pairing. */
  private token: string;
  private readonly clientIdentity: RemoteClientIdentity | undefined;
  private readonly buildInfo: BuildInfo;
  private readonly createSocket: CreateSocket;
  private readonly newId: () => string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly authTimeoutMs: number;
  private readonly openClawTicketTimeoutMs: number;
  private readonly openClawConfigTimeoutMs: number;
  private readonly openClawLifecycleTimeoutMs: number;
  private readonly livenessIdleMs: number;
  private readonly livenessProbeTimeoutMs: number;
  private readonly livenessCheckMs: number;
  /** Advanced by EVERY valid server message — the liveness monitor's signal. */
  private lastServerMessageAt = 0;
  private livenessCheckTimer: ReturnType<typeof setInterval> | null = null;
  private livenessProbeDeadline: ReturnType<typeof setTimeout> | null = null;

  private socket: WsLike | null = null;
  private authed = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-attempt auth watchdog — self-heals a stuck/half-open connection. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Android background suspension is reversible and deliberately preserves
   * renderer-side run ports. It is distinct from explicit disconnect(). */
  private lifecycleSuspended = false;
  private everAuthed = false;
  private generation = 0;
  private connectionState: RemoteConnectionState = 'connecting';
  private reconnectAttempts = 0;
  private nextRetryAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private hostVersion = 'unknown';
  private hostBuildSha = 'unknown';
  private negotiatedProtocolVersion: RemoteProtocolVersion | null = null;
  private reattachPrioritySessionId: string | null = null;

  /** Stable renderer-side ports. They deliberately survive transient sockets;
   * `resume-run` rebinds the same BlockController/xterm after authentication. */
  private readonly ports = new Map<string, RunPortRecord>();
  /** Capacity can be transient while another mirror releases its PTY slot.
   * Retry only within the current authenticated generation, with a bounded
   * exponential backoff so a permanently busy run cannot spin forever. */
  private readonly resumeRetries = new Map<string, ResumeRetryState>();
  private readonly pendingSurfaceOpens = new Map<
    string,
    (result: SessionSurfaceOpenResult) => void
  >();
  private readonly pendingSurfaceClosePreparations = new Map<
    string,
    (result: SessionSurfacePrepareCloseResult) => void
  >();
  private readonly pendingSurfaceCloseCommits = new Map<
    string,
    (result: SessionSurfaceCommitCloseResult) => void
  >();
  private readonly pendingSurfaceReleases = new Map<
    string,
    (result: SessionSurfaceReleaseResult) => void
  >();
  private readonly pendingSessionTerminations = new Map<
    string,
    (result: DestroySessionGuardResult) => void
  >();
  /** `list-sessions` has no request/response correlation id on the wire (M0) —
   * concurrent callers are served FIFO as `session-list` replies arrive. */
  private readonly pendingListSessions: Array<(sessions: readonly SessionInfo[]) => void> = [];
  /** `list-runs` has no correlation id on the wire either (M1 mirror-active-
   * runs) — same FIFO precedent as `pendingListSessions` above. */
  private readonly pendingListRuns: Array<(runs: readonly RunStartedInfo[]) => void> = [];
  /** Parked initiating runs advertised to this install after a full WebView
   * process restart. attachRun consumes the marker and performs an
   * authoritative resume instead of creating a viewing-only mirror. */
  private readonly restartResumableRuns = new Set<string>();
  private readonly sessionDeadListeners = new Set<(info?: { logPath?: string | null }) => void>();
  /** Mobile-only (M2 ConnectScreen): fires on every authed transition, including
   * an immediate replay of the CURRENT state to a listener that just subscribed. */
  private readonly authListeners = new Set<(authed: boolean) => void>();
  private readonly tokenIssuedListeners = new Set<(token: string) => void>();
  /** Retained separately from `token` so a listener mounted after a fast
   * pairing handshake can distinguish and persist the issued bearer. */
  private pairingIssuedToken: string | null = null;
  private readonly connectionStateListeners = new Set<(state: RemoteConnectionState) => void>();
  private readonly connectionHealthListeners = new Set<(snapshot: ConnectionHealthSnapshot) => void>();
  private remoteCapabilities = new Set<RemoteCapability>();
  private readonly pendingQuickCommands = new Map<
    string,
    (result: RemoteQuickCommandsResult) => void
  >();
  private readonly pendingDesktopStarts = new Map<
    string,
    (result: DesktopControlStartResultMessage) => void
  >();
  private readonly desktopSignalListeners = new Set<(message: DesktopSignalMessage) => void>();
  private readonly desktopStatusListeners = new Set<(message: DesktopControlStatusMessage) => void>();
  private readonly desktopEndedListeners = new Set<(message: DesktopControlEndedMessage) => void>();
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
  private agentCoordinationSnapshot: AgentCoordinationSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT;
  /** Revisions are process-local to the desktop. The first snapshot from each
   * newly-created socket is therefore an authoritative epoch seed even when
   * its revision is below the cache retained across reconnects. */
  private awaitingAgentSeed = true;
  private awaitingAgentCoordinationSeed = true;
  private readonly agentSnapshotListeners = new Set<(snapshot: AgentActivitySnapshot) => void>();
  private readonly agentCoordinationSnapshotListeners = new Set<
    (snapshot: AgentCoordinationSnapshot) => void
  >();
  private readonly pendingAgentSnapshots = new Map<string, (snapshot: AgentActivitySnapshot) => void>();
  private readonly pendingAgentCoordinationSnapshots = new Map<
    string,
    (snapshot: AgentCoordinationSnapshot) => void
  >();
  private readonly pendingAgentSeen = new Map<string, (marked: boolean) => void>();
  private readonly pendingManagedMergeDecisions = new Map<
    string,
    (result: AgentCoordinationMutationResult<ManagedMergeRequest>) => void
  >();
  private readonly pendingAgentFollowups = new Map<string, (result: AgentFollowupResult) => void>();
  private readonly pendingAgentDecisions = new Map<string, PendingAgentDecision>();
  private readonly pendingAgentProjects = new Map<string, (result: AgentProjectPage) => void>();
  private readonly pendingAgentProjectSaves = new Map<string, (result: AgentProjectMutationResult) => void>();
  private readonly pendingAgentProjectRemovals = new Map<string, (removed: boolean) => void>();
  private readonly pendingAgentProjectLaunchers = new Map<
    string,
    (result: readonly AgentProjectLauncherSummary[]) => void
  >();
  private readonly pendingAgentProjectLaunchPreparation = new Map<
    string,
    (result: AgentProjectLaunchPreparation) => void
  >();
  private readonly pendingAgentProjectLaunchStarts = new Map<
    string,
    (result: AgentProjectLaunchStartResult) => void
  >();
  private readonly pendingAgentLaunchPreparation = new Map<
    string,
    (result: AgentLaunchPreparation) => void
  >();
  private readonly pendingAgentLaunchStarts = new Map<
    string,
    (result: AgentLaunchStartResult) => void
  >();
  private readonly pendingAgentHistorySessions = new Map<string, (result: AgentHistorySessionPage) => void>();
  private readonly pendingAgentHistoryReads = new Map<string, (result: AgentTranscriptPage | null) => void>();
  private readonly pendingAgentResumePreparation = new Map<
    string,
    (result: AgentResumePreparation | null) => void
  >();
  private readonly pendingAgentResumeStarts = new Map<
    string,
    (result: AgentResumeStartResult) => void
  >();

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
  private roundTripMs: number | null = null;
  private roundTripTimer: ReturnType<typeof setInterval> | null = null;
  private roundTripProbeSequence = 0;
  private readonly pendingRoundTripProbes = new Map<
    string,
    { readonly sentAt: number; readonly generation: number }
  >();
  private readonly pendingGitStatus = new Map<string, (status: GitDirectoryStatus) => void>();
  private readonly pendingGitDiffs = new Map<string, (result: GitDiffResult) => void>();
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
  private readonly openclawControlListeners = new Set<(snapshot: OpenClawControlSnapshot) => void>();
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
  private readonly pendingOpenClawLifecycle = new Map<string, (result: OpenClawLifecycleReceipt) => void>();
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
    this.clientIdentity = options.clientIdentity;
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
    this.livenessIdleMs = options.livenessIdleMs ?? LIVENESS_IDLE_MS;
    this.livenessProbeTimeoutMs = options.livenessProbeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS;
    this.livenessCheckMs = options.livenessCheckMs ?? LIVENESS_CHECK_INTERVAL_MS;
    this.backoffMs = this.initialBackoffMs;
    this.connect();
  }

  /** Stop reconnecting, release live runs, and close all stable local ports. */
  disconnect(): void {
    this.lifecycleSuspended = false;
    this.stopped = true;
    // This is a user-authorized disconnect, not a transient radio handoff.
    // Tell main to close live run ports instead of placing them in the lease.
    if (this.authed) this.send({ kind: 'release-runs' });
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    this.stopLivenessMonitor();
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

  /**
   * Pause network work after a sustained Android background interval while
   * retaining stable FakeMessagePorts and their BlockControllers. Closing the
   * socket parks the corresponding host ports in the remote run lease; the
   * next authenticated generation resumes those exact runs.
   */
  suspend(): boolean {
    if (this.lifecycleSuspended || this.connectionState === 'disconnected') return false;
    this.lifecycleSuspended = true;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAllResumeRetries();
    this.clearWatchdog();
    this.stopLivenessMonitor();
    this.stopRoundTripProbe();
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.close();
    } catch {
      // Socket identity was invalidated first, so a close failure cannot
      // restart work or mutate this suspended generation.
    }
    this.nextRetryAt = null;
    this.setAuthed(false);
    this.resolvePendingRequestsUnavailable(true);
    if (this.openclawAvailable !== false) {
      this.openclawAvailable = false;
      for (const listener of this.openclawAvailabilityListeners) listener(false);
    }
    this.setConnectionState('suspended');
    return true;
  }

  /** Resume one fresh socket generation after lifecycle suspension. */
  resume(): boolean {
    if (!this.lifecycleSuspended) return false;
    this.lifecycleSuspended = false;
    this.stopped = false;
    this.nextRetryAt = null;
    this.setConnectionState(this.everAuthed ? 'reconnecting' : 'connecting');
    this.connect();
    return true;
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

  openSessionSurface(
    surfaceId: string,
    intent: SessionSurfaceIntent,
  ): Promise<SessionSurfaceOpenResult> {
    const requestId = this.newId();
    return new Promise((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'session-surface-open', requestId, surfaceId, intent },
        this.pendingSurfaceOpens,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  prepareSessionSurfaceClose(
    entries: readonly SessionSurfaceCloseEntry[],
  ): Promise<SessionSurfacePrepareCloseResult> {
    const requestId = this.newId();
    return new Promise((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'session-surface-prepare-close', requestId, entries },
        this.pendingSurfaceClosePreparations,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  commitSessionSurfaceClose(
    closeToken: string,
    decisions: readonly SessionSurfaceCloseDecision[],
  ): Promise<SessionSurfaceCommitCloseResult> {
    const requestId = this.newId();
    return new Promise((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'session-surface-commit-close', requestId, closeToken, decisions },
        this.pendingSurfaceCloseCommits,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  releaseSessionSurface(bindingId: string): Promise<SessionSurfaceReleaseResult> {
    const requestId = this.newId();
    return new Promise((resolve) => {
      if (!this.tryStartMapRequest(
        { kind: 'session-surface-release', requestId, bindingId },
        this.pendingSurfaceReleases,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'state-changed' });
    });
  }

  terminateSessionGuarded(
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
          kind: 'session-terminate-guarded',
          requestId,
          sessionId,
          expectedActiveRunIds,
        },
        this.pendingSessionTerminations,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
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
    const resumeOwned = this.restartResumableRuns.delete(runKey(sessionId, runId));
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(runId);
        this.ports.delete(runId);
      }
    });
    this.clearResumeRetry(runId);
    this.ports.get(runId)?.port.close();
    this.ports.set(runId, { sessionId, runId, port, initiatedHere: resumeOwned });
    this.send(
      resumeOwned
        ? { kind: 'resume-run', sessionId, runId, generation: this.generation }
        : { kind: 'attach-run', sessionId, runId },
    );
    e2eLog(
      resumeOwned ? 'transport:resume-owned' : 'transport:attach',
      `generation=${this.generation}`,
      `runId=${runId}`,
    );
    const event = new MessageEvent('message', { data: { _ezAttachPort: runId }, source: window });
    Object.defineProperty(event, 'ports', { value: [port], enumerable: true, configurable: true });
    window.dispatchEvent(event);
    return Promise.resolve();
  }

  getGitStatus(directory: string): Promise<GitDirectoryStatus> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
      return Promise.resolve(UNAVAILABLE_GIT_DIRECTORY_STATUS);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'git-status', requestId, directory },
        this.pendingGitStatus,
        requestId,
        resolve,
      )) resolve(UNAVAILABLE_GIT_DIRECTORY_STATUS);
    });
  }

  getGitDiff(directory: string): Promise<GitDiffResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
      return Promise.resolve({ ok: false, error: 'git-failed' });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'git-diff', requestId, directory },
        this.pendingGitDiffs,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'git-failed' });
    });
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
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
      return Promise.resolve(this.agentSnapshot);
    }
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

  getAgentCoordinationSnapshot(): Promise<AgentCoordinationSnapshot> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) {
      return Promise.resolve(this.agentCoordinationSnapshot);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-coordination-snapshot-get', requestId },
        this.pendingAgentCoordinationSnapshots,
        requestId,
        resolve,
      )) resolve(this.agentCoordinationSnapshot);
    });
  }

  onAgentCoordinationSnapshot(listener: (snapshot: AgentCoordinationSnapshot) => void): () => void {
    this.agentCoordinationSnapshotListeners.add(listener);
    listener(this.agentCoordinationSnapshot);
    return () => this.agentCoordinationSnapshotListeners.delete(listener);
  }

  joinAgentCollaboration(
    _input: AgentParticipantInput,
  ): Promise<AgentCoordinationMutationResult<{ readonly participant: AgentParticipant; readonly brief: string }>> {
    void _input;
    return Promise.resolve({ ok: false, error: 'unavailable', message: 'Join configuration is desktop-only.' });
  }

  leaveAgentCollaboration(_activityId: string): Promise<boolean> {
    void _activityId;
    return Promise.resolve(false);
  }

  saveAgentCoordinationProject(
    _input: AgentProjectCoordinationInput,
  ): Promise<AgentCoordinationMutationResult<AgentProjectCoordination>> {
    void _input;
    return Promise.resolve({ ok: false, error: 'unavailable', message: 'Project configuration is desktop-only.' });
  }

  markAgentSeen(activityId: string, stateSeq: number): Promise<boolean> {
    if (
      (this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION
      || !isBoundedString(activityId, MAX_REMOTE_AGENT_ID_LENGTH)
      || !Number.isSafeInteger(stateSeq)
    ) return Promise.resolve(false);
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-seen', requestId, activityId, stateSeq },
        this.pendingAgentSeen,
        requestId,
        resolve,
      )) resolve(false);
    });
  }

  sendAgentPrompt(activityId: string, text: string): Promise<AgentFollowupResult> {
    return this.sendAgentFollowup(activityId, text);
  }

  requestManagedMerge(
    _activityId: string,
    _targetBranch: string,
  ): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>> {
    void _activityId;
    void _targetBranch;
    return Promise.resolve({ ok: false, error: 'unavailable', message: 'Merge requests originate from an Agent session.' });
  }

  decideManagedMerge(
    input: ManagedMergeDecisionInput,
  ): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>> {
    if (
      (this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION
      || !isBoundedString(input.requestId, MAX_REMOTE_AGENT_ID_LENGTH)
      || !Number.isSafeInteger(input.revision)
      || (input.decision !== 'approve' && input.decision !== 'deny')
    ) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid merge decision.' });
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        {
          kind: 'managed-merge-decision',
          requestId,
          mergeRequestId: input.requestId,
          revision: input.revision,
          decision: input.decision,
        },
        this.pendingManagedMergeDecisions,
        requestId,
        resolve,
      )) resolve({ ok: false, error: 'unavailable', message: 'Desktop is unavailable.' });
    });
  }

  grantNextManagedMerge(
    _input: ManagedMergeGrantInput,
  ): Promise<AgentCoordinationMutationResult<{ readonly expiresAt: number }>> {
    void _input;
    return Promise.resolve({ ok: false, error: 'unavailable', message: 'One-shot grants are desktop-only.' });
  }

  getManagedMergeDiff(_requestId: string, _revision: number): Promise<GitDiffResult> {
    void _requestId;
    void _revision;
    return Promise.resolve({ ok: false, error: 'git-failed' });
  }

  sendAgentFollowup(activityId: string, text: string): Promise<AgentFollowupResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
      return Promise.resolve({ ok: false, error: 'delivery-failed' });
    }
    if (
      !isBoundedString(activityId, MAX_REMOTE_AGENT_ID_LENGTH)
      || /[\r\n]/u.test(text)
      || text.trim().length === 0
      || text.trim().length > MAX_REMOTE_AGENT_FOLLOWUP_LENGTH
    ) {
      return Promise.resolve({ ok: false, error: 'invalid-text' });
    }
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

  decideAgentApproval(
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ): Promise<AgentDecisionResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
      return Promise.resolve({ ok: false, error: 'delivery-failed' });
    }
    if (
      !isBoundedString(activityId, MAX_REMOTE_AGENT_ID_LENGTH)
      || !isBoundedString(approvalId, MAX_REMOTE_AGENT_ID_LENGTH)
    ) {
      return Promise.resolve({ ok: false, error: 'delivery-failed' });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      const pending: PendingAgentDecision = {
        activityId,
        approvalId,
        decision,
        resolve,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        if (this.pendingAgentDecisions.get(requestId) !== pending) return;
        this.pendingAgentDecisions.delete(requestId);
        pending.timer = null;
        pending.resolve({ ok: false, error: 'outcome-unknown' });
      }, AGENT_DECISION_RETRY_WINDOW_MS);
      if (!this.tryStartMapRequest(
        { kind: 'agent-decision', requestId, activityId, approvalId, decision },
        this.pendingAgentDecisions,
        requestId,
        pending,
        // A desktop older than protocol v3 does not know this verb. Reporting
        // it as not-found keeps the phone honest instead of showing a success
        // the gate never granted.
      )) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = null;
        resolve({ ok: false, error: 'delivery-failed' });
      }
    });
  }

  listAgentProjects(
    force?: boolean,
    cursor?: string,
    limit?: number,
    query?: string,
  ): Promise<AgentProjectPage> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    if (query && (this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-projects-list', requestId, force, cursor, limit, query },
        this.pendingAgentProjects,
        requestId,
        resolve,
      )) resolve({ items: [], nextCursor: null });
    });
  }

  saveAgentProject(input: AgentProjectInput): Promise<AgentProjectMutationResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-project-save', requestId, input },
        this.pendingAgentProjectSaves,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'invalid' });
    });
  }

  removeAgentProject(projectId: string): Promise<boolean> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-project-remove', requestId, projectId },
        this.pendingAgentProjectRemovals,
        requestId,
        resolve,
      )) resolve(false);
    });
  }

  listAgentProjectLaunchers(): Promise<readonly AgentProjectLauncherSummary[]> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-project-launchers', requestId },
        this.pendingAgentProjectLaunchers,
        requestId,
        resolve,
      )) resolve([]);
    });
  }

  async prepareAgentLaunch(
    target: AgentLaunchTarget,
    launcherId: string,
  ): Promise<AgentLaunchPreparation> {
    if ((this.negotiatedProtocolVersion ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) {
      return new Promise((resolve) => {
        const requestId = this.newId();
        if (!this.tryStartMapRequest(
          { kind: 'agent-launch-prepare', requestId, target, launcherId },
          this.pendingAgentLaunchPreparation,
          requestId,
          resolve,
        )) resolve({ ok: false, reason: 'unavailable' });
      });
    }
    if (target.kind !== 'project') return { ok: false, reason: 'unavailable' };
    const preparation = await this.prepareAgentProjectLaunch(target.projectId, launcherId);
    return preparation.ok
      ? {
          ok: true,
          target,
          launcherId: preparation.launcherId,
          provider: preparation.provider,
          name: preparation.name,
          cwd: preparation.cwd,
          roots: preparation.roots,
          ignoredAdditionalRootCount: 0,
          revision: preparation.revision,
        }
      : preparation;
  }

  startAgentLaunch(request: AgentLaunchStartRequest): Promise<AgentLaunchStartResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) {
      return request.target.kind === 'project'
        ? this.startAgentProjectLaunch({
            projectId: request.target.projectId,
            launcherId: request.launcherId,
            sessionId: request.sessionId,
            runId: request.runId,
            revision: request.revision,
          })
        : Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId: request.runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(request.runId);
        this.ports.delete(request.runId);
      }
    });
    return new Promise((resolve) => {
      const requestId = this.newId();
      const settle = (result: AgentLaunchStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.clearResumeRetry(request.runId);
        this.ports.get(request.runId)?.port.close();
        this.ports.set(request.runId, {
          sessionId: request.sessionId,
          runId: request.runId,
          port,
          initiatedHere: true,
        });
        const event = new MessageEvent('message', {
          data: { _ezPort: request.runId },
          source: window,
        });
        Object.defineProperty(event, 'ports', {
          value: [port],
          enumerable: true,
          configurable: true,
        });
        window.dispatchEvent(event);
        resolve(result);
      };
      if (!this.tryStartMapRequest(
        { kind: 'agent-launch-start', requestId, request },
        this.pendingAgentLaunchStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }

  prepareAgentProjectLaunch(
    projectId: string,
    launcherId: string,
  ): Promise<AgentProjectLaunchPreparation> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-project-prepare-launch', requestId, projectId, launcherId },
        this.pendingAgentProjectLaunchPreparation,
        requestId,
        resolve,
      )) resolve({ ok: false, reason: 'unavailable' });
    });
  }

  startAgentProjectLaunch(
    request: AgentProjectLaunchStartRequest,
  ): Promise<AgentProjectLaunchStartResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId: request.runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(request.runId);
        this.ports.delete(request.runId);
      }
    });
    return new Promise((resolve) => {
      const requestId = this.newId();
      const settle = (result: AgentProjectLaunchStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.clearResumeRetry(request.runId);
        this.ports.get(request.runId)?.port.close();
        this.ports.set(request.runId, {
          sessionId: request.sessionId,
          runId: request.runId,
          port,
          initiatedHere: true,
        });
        const event = new MessageEvent('message', {
          data: { _ezPort: request.runId },
          source: window,
        });
        Object.defineProperty(event, 'ports', {
          value: [port],
          enumerable: true,
          configurable: true,
        });
        window.dispatchEvent(event);
        resolve(result);
      };
      if (!this.tryStartMapRequest(
        { kind: 'agent-project-start-launch', requestId, request },
        this.pendingAgentProjectLaunchStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }

  get supportsAgentProjectManagement(): boolean {
    return (this.negotiatedProtocolVersion ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS;
  }

  get supportsAgentDirectLaunch(): boolean {
    return (this.negotiatedProtocolVersion ?? 0) >= REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS;
  }

  listAgentHistorySessions(
    projectId: string,
    cursor?: string,
    limit?: number,
    force?: boolean,
  ): Promise<AgentHistorySessionPage> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-history-sessions', requestId, projectId, cursor, limit, force },
        this.pendingAgentHistorySessions,
        requestId,
        resolve,
      )) resolve({ items: [], nextCursor: null });
    });
  }

  readAgentHistory(
    historyId: string,
    cursor?: string,
    limit?: number,
  ): Promise<AgentTranscriptPage | null> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-history-read', requestId, historyId, cursor, limit },
        this.pendingAgentHistoryReads,
        requestId,
        resolve,
      )) resolve(null);
    });
  }

  prepareAgentResume(historyId: string): Promise<AgentResumePreparation | null> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartMapRequest(
        { kind: 'agent-history-prepare-resume', requestId, historyId },
        this.pendingAgentResumePreparation,
        requestId,
        resolve,
      )) resolve(null);
    });
  }

  startAgentResume(request: AgentResumeStartRequest): Promise<AgentResumeStartResult> {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const port = new FakeMessagePort((control) => {
      this.send({ kind: 'control', runId: request.runId, control });
      if (control.type === 'close') {
        this.clearResumeRetry(request.runId);
        this.ports.delete(request.runId);
      }
    });
    return new Promise((resolve) => {
      const requestId = this.newId();
      const settle = (result: AgentResumeStartResult): void => {
        if (!result.ok) {
          port.close();
          resolve(result);
          return;
        }
        this.clearResumeRetry(request.runId);
        this.ports.get(request.runId)?.port.close();
        this.ports.set(request.runId, {
          sessionId: request.sessionId,
          runId: request.runId,
          port,
          initiatedHere: true,
        });
        const event = new MessageEvent('message', {
          data: { _ezPort: request.runId },
          source: window,
        });
        Object.defineProperty(event, 'ports', {
          value: [port],
          enumerable: true,
          configurable: true,
        });
        window.dispatchEvent(event);
        resolve(result);
      };
      if (!this.tryStartMapRequest(
        { kind: 'agent-history-start-resume', requestId, request },
        this.pendingAgentResumeStarts,
        requestId,
        settle,
      )) settle({ ok: false, reason: 'unavailable' });
    });
  }

  /** Mobile-only: the host handed over a long-lived bearer after this link
   * authenticated with a one-time pairing code. The app persists it so the
   * next launch does not need the desktop's screen. Replays the issued bearer
   * because the constructor starts the socket before React can mount effects. */
  onTokenIssued(listener: (token: string) => void): () => void {
    this.tokenIssuedListeners.add(listener);
    if (this.pairingIssuedToken !== null) {
      try {
        listener(this.pairingIssuedToken);
      } catch {
        // A persistence observer cannot invalidate the adopted credential.
      }
    }
    return () => this.tokenIssuedListeners.delete(listener);
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

  /** Desired state, recovery phase, and critical remediation paired with status. */
  onOpenClawControl(listener: (snapshot: OpenClawControlSnapshot) => void): () => void {
    this.openclawControlListeners.add(listener);
    return () => this.openclawControlListeners.delete(listener);
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

  runOpenClawLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleReceipt> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      if (!this.tryStartTimedMapRequest(
        { kind: 'openclaw-lifecycle', requestId, action },
        this.pendingOpenClawLifecycle,
        requestId,
        resolve,
        this.openClawLifecycleTimeoutMs,
        {
          accepted: false,
          issue: {
            code: 'supervisor-failed',
            detail: 'OpenClaw lifecycle request timed out.',
            remediation: 'Reconnect to EZTerminal and retry the action.',
            diagnosticId: `mobile-timeout-${requestId}`,
          },
        },
      )) resolve({
        accepted: false,
        issue: {
          code: 'supervisor-failed',
          detail: 'Not connected to EZTerminal.',
          remediation: 'Reconnect to EZTerminal and retry the action.',
          diagnosticId: `mobile-offline-${requestId}`,
        },
      });
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

  get supportsDesktopControl(): boolean {
    return this.remoteCapabilities.has(REMOTE_CAPABILITY_DESKTOP_CONTROL);
  }

  startDesktopControl(
    viewport?: DesktopVideoViewport,
    qualityPreference?: DesktopQualityPreference,
  ): Promise<DesktopControlStartResultMessage> {
    const requestId = this.newId();
    if (!this.supportsDesktopControl || !this.authed) {
      return Promise.resolve({
        kind: 'desktop-control-start-result',
        requestId,
        ok: false,
        reason: 'unavailable',
        errorCode: this.authed ? 'UNSUPPORTED' : 'OFFLINE',
      });
    }
    return new Promise((resolve) => {
      this.pendingDesktopStarts.set(requestId, resolve);
      if (!this.send({
        kind: 'desktop-control-start',
        requestId,
        ...(viewport ? { viewport } : {}),
        ...(qualityPreference ? { qualityPreference } : {}),
      })) {
        this.pendingDesktopStarts.delete(requestId);
        resolve({
          kind: 'desktop-control-start-result',
          requestId,
          ok: false,
          reason: 'unavailable',
          errorCode: 'OFFLINE',
        });
      }
    });
  }

  sendDesktopSignal(sessionId: string, signal: DesktopSessionSignal): boolean {
    return this.send({ kind: 'desktop-signal', sessionId, signal });
  }

  stopDesktopControl(
    sessionId: string,
    reason: 'client-stop' | 'background' | 'navigation' = 'client-stop',
  ): boolean {
    return this.send({ kind: 'desktop-control-stop', sessionId, reason });
  }

  onDesktopSignal(listener: (message: DesktopSignalMessage) => void): () => void {
    this.desktopSignalListeners.add(listener);
    return () => this.desktopSignalListeners.delete(listener);
  }

  onDesktopStatus(listener: (message: DesktopControlStatusMessage) => void): () => void {
    this.desktopStatusListeners.add(listener);
    return () => this.desktopStatusListeners.delete(listener);
  }

  onDesktopEnded(listener: (message: DesktopControlEndedMessage) => void): () => void {
    this.desktopEndedListeners.add(listener);
    return () => this.desktopEndedListeners.delete(listener);
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
      this.lifecycleSuspended
      ||
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
  private failFileReadResponse(requestId: string, assembly: FileReadAssembly): void {
    if (this.pendingFileReads.get(requestId) !== assembly) return;
    this.pendingFileReads.delete(requestId);
    assembly.buffer = null;
    assembly.expectedOffset = null;
    this.send({ kind: 'file-read-cancel', requestId });
    assembly.resolve({ ok: false, error: 'Invalid file read response' });
  }

  private requestFileRead(
    path: string,
    mode: FileReadMode,
    onProgress?: (received: number, total: number) => void,
    terminalCapability?: string,
  ): Promise<FileReadResult> {
    return new Promise((resolve) => {
      const requestId = this.newId();
      const pending: FileReadAssembly = {
        buffer: null,
        metaReceived: false,
        expectedOffset: null,
        mode,
        maxSendBytes: maxFileReadBytes(mode),
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
    if (this.stopped || this.lifecycleSuspended) return;
    this.nextRetryAt = null;
    this.recordConnectionDiagnostic('connect');
    this.emitConnectionHealth();
    const socket = this.createSocket(this.url);
    this.socket = socket;
    this.awaitingAgentSeed = true;
    this.awaitingAgentCoordinationSeed = true;
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
        ...(this.clientIdentity ? { clientIdentity: this.clientIdentity } : {}),
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

  // Post-auth liveness monitor — see the LIVENESS_* constants' doc for the
  // full rationale (silent sockets are invisible to JS and never fire 'close').

  private startLivenessMonitor(): void {
    this.stopLivenessMonitor();
    this.lastServerMessageAt = Date.now();
    this.livenessCheckTimer = setInterval(() => this.checkLiveness(), this.livenessCheckMs);
  }

  private stopLivenessMonitor(): void {
    if (this.livenessCheckTimer !== null) {
      clearInterval(this.livenessCheckTimer);
      this.livenessCheckTimer = null;
    }
    if (this.livenessProbeDeadline !== null) {
      clearTimeout(this.livenessProbeDeadline);
      this.livenessProbeDeadline = null;
    }
  }

  private checkLiveness(): void {
    if (this.stopped || !this.authed || !this.socket) return;
    if (this.livenessProbeDeadline !== null) return; // probe already outstanding
    if (Date.now() - this.lastServerMessageAt < this.livenessIdleMs) return;
    const probeSentAt = Date.now();
    void this.listRuns(); // any server message — this reply or otherwise — proves liveness
    this.livenessProbeDeadline = setTimeout(() => {
      this.livenessProbeDeadline = null;
      if (this.stopped || !this.authed) return;
      if (this.lastServerMessageAt >= probeSentAt) return; // traffic arrived meanwhile
      this.closeTerminalSocket(); // dead socket → backoff reconnect → resume-run
    }, this.livenessProbeTimeoutMs);
  }

  private setAuthed(value: boolean): void {
    if (this.authed === value) return;
    this.authed = value;
    if (value) this.startRoundTripProbe();
    else this.stopRoundTripProbe();
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
      roundTripMs: this.roundTripMs,
    };
  }

  /** Probe on a timer while authenticated. Stops on every disconnect and
   * forgets the old number, because a latency from the previous link is not a
   * measurement of this one. */
  private startRoundTripProbe(): void {
    this.stopRoundTripProbe();
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) return;
    const probe = (): void => {
      if (!this.authed) return;
      const sentAt = Date.now();
      const probeId = `${this.generation}:${++this.roundTripProbeSequence}`;
      while (this.pendingRoundTripProbes.size >= 4) {
        const oldest = this.pendingRoundTripProbes.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.pendingRoundTripProbes.delete(oldest);
      }
      this.pendingRoundTripProbes.set(probeId, { sentAt, generation: this.generation });
      this.send({ kind: 'ping', probeId, sentAt });
    };
    probe();
    this.roundTripTimer = setInterval(probe, RTT_PROBE_INTERVAL_MS);
  }

  private stopRoundTripProbe(): void {
    if (this.roundTripTimer !== null) clearInterval(this.roundTripTimer);
    this.roundTripTimer = null;
    this.pendingRoundTripProbes.clear();
    this.roundTripMs = null;
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

  private settlePendingAgentDecision(
    requestId: string,
    pending: PendingAgentDecision,
    result: AgentDecisionResult,
  ): void {
    if (this.pendingAgentDecisions.get(requestId) !== pending) return;
    this.pendingAgentDecisions.delete(requestId);
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.resolve(result);
  }

  private replayPendingAgentDecisions(): void {
    if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) return;
    for (const [requestId, pending] of this.pendingAgentDecisions) {
      this.send({
        kind: 'agent-decision',
        requestId,
        activityId: pending.activityId,
        approvalId: pending.approvalId,
        decision: pending.decision,
      });
    }
  }

  /** Settle every request/reply waiter that belonged to the ending socket.
   * Shared by transient close, auth rejection, and explicit disconnect so no
   * public Promise can remain orphaned when `disconnect()` nulls the socket
   * before its eventual close event reaches `endConnection`. */
  private resolvePendingRequestsUnavailable(preserveAgentDecisions = false): void {
    for (const [requestId, resolve] of this.pendingDesktopStarts) {
      resolve({
        kind: 'desktop-control-start-result',
        requestId,
        ok: false,
        reason: 'unavailable',
        errorCode: 'OFFLINE',
      });
    }
    this.pendingDesktopStarts.clear();
    for (const resolve of this.pendingQuickCommands.values()) {
      resolve({ ok: false, error: 'offline' });
    }
    this.pendingQuickCommands.clear();
    for (const resolve of this.pendingSurfaceOpens.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingSurfaceOpens.clear();
    for (const resolve of this.pendingSurfaceClosePreparations.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingSurfaceClosePreparations.clear();
    for (const resolve of this.pendingSurfaceCloseCommits.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingSurfaceCloseCommits.clear();
    for (const resolve of this.pendingSurfaceReleases.values()) {
      resolve({ ok: false, reason: 'state-changed' });
    }
    this.pendingSurfaceReleases.clear();
    for (const resolve of this.pendingSessionTerminations.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingSessionTerminations.clear();
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
    for (const resolve of this.pendingAgentCoordinationSnapshots.values()) {
      resolve(this.agentCoordinationSnapshot);
    }
    this.pendingAgentCoordinationSnapshots.clear();
    for (const resolve of this.pendingAgentSeen.values()) resolve(false);
    this.pendingAgentSeen.clear();
    for (const resolve of this.pendingManagedMergeDecisions.values()) {
      resolve({ ok: false, error: 'unavailable', message: 'Desktop disconnected.' });
    }
    this.pendingManagedMergeDecisions.clear();
    for (const resolve of this.pendingAgentFollowups.values()) {
      resolve({ ok: false, error: 'delivery-failed' });
    }
    this.pendingAgentFollowups.clear();
    for (const resolve of this.pendingAgentProjects.values()) {
      resolve({ items: [], nextCursor: null });
    }
    this.pendingAgentProjects.clear();
    for (const resolve of this.pendingAgentProjectSaves.values()) {
      resolve({ ok: false, reason: 'invalid' });
    }
    this.pendingAgentProjectSaves.clear();
    for (const resolve of this.pendingAgentProjectRemovals.values()) resolve(false);
    this.pendingAgentProjectRemovals.clear();
    for (const resolve of this.pendingAgentProjectLaunchers.values()) resolve([]);
    this.pendingAgentProjectLaunchers.clear();
    for (const resolve of this.pendingAgentProjectLaunchPreparation.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentProjectLaunchPreparation.clear();
    for (const resolve of this.pendingAgentProjectLaunchStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentProjectLaunchStarts.clear();
    for (const resolve of this.pendingAgentLaunchPreparation.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentLaunchPreparation.clear();
    for (const resolve of this.pendingAgentLaunchStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentLaunchStarts.clear();
    for (const resolve of this.pendingAgentHistorySessions.values()) {
      resolve({ items: [], nextCursor: null });
    }
    this.pendingAgentHistorySessions.clear();
    for (const resolve of this.pendingAgentHistoryReads.values()) resolve(null);
    this.pendingAgentHistoryReads.clear();
    for (const resolve of this.pendingAgentResumePreparation.values()) resolve(null);
    this.pendingAgentResumePreparation.clear();
    for (const resolve of this.pendingAgentResumeStarts.values()) {
      resolve({ ok: false, reason: 'unavailable' });
    }
    this.pendingAgentResumeStarts.clear();
    if (!preserveAgentDecisions) {
      for (const [requestId, pending] of [...this.pendingAgentDecisions]) {
        this.settlePendingAgentDecision(
          requestId,
          pending,
          { ok: false, error: 'outcome-unknown' },
        );
      }
    }
    for (const resolve of this.pendingGitStatus.values()) {
      resolve(UNAVAILABLE_GIT_DIRECTORY_STATUS);
    }
    this.pendingGitStatus.clear();
    for (const resolve of this.pendingGitDiffs.values()) resolve({ ok: false, error: 'git-failed' });
    this.pendingGitDiffs.clear();
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
      resolve({
        accepted: false,
        issue: {
          code: 'supervisor-failed',
          detail: 'Connection to EZTerminal lost.',
          remediation: 'Reconnect to observe or retry the OpenClaw action.',
          diagnosticId: `mobile-disconnect-${Date.now().toString(36)}`,
        },
      });
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
    this.stopLivenessMonitor();
    this.setAuthed(false);
    this.socket = null;
    // No frames can arrive for these runs anymore — tell every open block so it
    // doesn't sit showing "running" forever, then drop them (mirrors a real
    // MessagePort going away: no further send/receive).
    // Stable local ports survive transient sockets; the next authenticated
    // generation resumes them against the bridge's bounded run lease.
    this.resolvePendingRequestsUnavailable(true);
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
  private send(msg: ClientToServerMessage): boolean {
    if (!this.socket) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      // A close can race one-way traffic. Request/reply calls use the
      // rollback-aware helpers above; one-way traffic is best-effort and must
      // never prevent disconnect cleanup or escape into the mobile UI.
      return false;
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
    this.negotiatedProtocolVersion = null;
    this.setAuthed(false);
    this.stopped = true;
    this.nextRetryAt = null;
    this.setConnectionState('protocol-incompatible');
    this.recordConnectionDiagnostic('protocol-incompatible');
    this.emitConnectionHealth();
    this.resolvePendingRequestsUnavailable();
    this.closeTerminalSocket();
  }

  /** Fail closed for a syntactically valid handshake that violates the
   * credential handoff contract (for example a pairing auth without a valid
   * replacement bearer). */
  private rejectAuthentication(): void {
    this.remoteCapabilities.clear();
    this.negotiatedProtocolVersion = null;
    this.setAuthed(false);
    this.stopped = true;
    this.nextRetryAt = null;
    this.setConnectionState('auth-rejected');
    this.recordConnectionDiagnostic('auth-rejected');
    this.emitConnectionHealth();
    this.resolvePendingRequestsUnavailable();
    this.closeTerminalSocket();
  }

  /** Close and synchronously invalidate a socket after a fail-closed decision
   * (auth/protocol rejection, or a liveness probe declaring it dead). Browser
   * close events are asynchronous, so waiting for `close` would let
   * already-queued messages mutate state after that decision. */
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || typeof (parsed as { kind?: unknown }).kind !== 'string'
    ) return;
    const msg = parsed as ServerToClientMessage;
    // Any valid server message proves the socket is alive (liveness monitor).
    this.lastServerMessageAt = Date.now();
    if (this.stopped) return;
    if (!this.authed && msg.kind !== 'auth-ok' && msg.kind !== 'auth-fail') return;
    switch (msg.kind) {
      case 'auth-ok':
        // Auth is a one-shot transition for a socket. Late duplicate
        // envelopes cannot renegotiate or kill a healthy connection while
        // correlated requests are in flight.
        if (this.authed) break;
        if (
          msg.protocolVersion !== REMOTE_PROTOCOL_VERSION
          || typeof msg.hostVersion !== 'string'
          || msg.hostVersion.trim().length === 0
        ) {
          this.rejectIncompatibleProtocol(msg.hostVersion);
          break;
        }
        {
          const pairingAttempt = isPairingCode(this.token);
          const hasIssuedToken = msg.issuedToken !== undefined;
          if (
            (pairingAttempt && !isRemoteBearerToken(msg.issuedToken))
            || (!pairingAttempt && hasIssuedToken)
          ) {
            this.rejectAuthentication();
            break;
          }
        }
        this.hostVersion = msg.hostVersion;
        this.negotiatedProtocolVersion = msg.protocolVersion;
        // A pairing code buys exactly one connection; the bearer that comes
        // back with it is what makes the next one work without the desktop
        // being in the room. Adopt it before anything else can fail.
        if (isRemoteBearerToken(msg.issuedToken)) {
          this.token = msg.issuedToken;
          this.pairingIssuedToken = msg.issuedToken;
          for (const listener of this.tokenIssuedListeners) {
            try {
              listener(msg.issuedToken);
            } catch {
              // Credential adoption is authoritative even if an observer has
              // already unmounted or its persistence callback fails.
            }
          }
        }
        this.hostBuildSha = typeof msg.hostBuildSha === 'string' && msg.hostBuildSha.trim()
          ? msg.hostBuildSha
          : 'unknown';
        this.remoteCapabilities = new Set(
          Array.isArray(msg.capabilities)
            ? msg.capabilities.filter(
                (capability): capability is RemoteCapability => (
                  capability === REMOTE_CAPABILITY_QUICK_COMMANDS_READ
                  || capability === REMOTE_CAPABILITY_DESKTOP_CONTROL
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
        this.startLivenessMonitor();
        this.replayPendingAgentDecisions();
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
        if (this.authed) break;
        if (msg.reason === 'incompatible-protocol') {
          this.rejectIncompatibleProtocol(msg.hostVersion);
          break;
        }
        this.rejectAuthentication();
        break;
      case 'session-surface-open-result': {
        this.pendingSurfaceOpens.get(msg.requestId)?.(msg.result);
        this.pendingSurfaceOpens.delete(msg.requestId);
        break;
      }
      case 'session-surface-prepare-close-result':
        this.pendingSurfaceClosePreparations.get(msg.requestId)?.(msg.result);
        this.pendingSurfaceClosePreparations.delete(msg.requestId);
        break;
      case 'session-surface-commit-close-result':
        this.pendingSurfaceCloseCommits.get(msg.requestId)?.(msg.result);
        this.pendingSurfaceCloseCommits.delete(msg.requestId);
        break;
      case 'session-surface-release-result':
        this.pendingSurfaceReleases.get(msg.requestId)?.(msg.result);
        this.pendingSurfaceReleases.delete(msg.requestId);
        break;
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
      case 'desktop-control-start-result':
        this.pendingDesktopStarts.get(msg.requestId)?.(msg);
        this.pendingDesktopStarts.delete(msg.requestId);
        break;
      case 'desktop-signal':
        for (const listener of this.desktopSignalListeners) listener(msg);
        break;
      case 'desktop-control-status':
        for (const listener of this.desktopStatusListeners) listener(msg);
        break;
      case 'desktop-control-ended':
        for (const listener of this.desktopEndedListeners) listener(msg);
        break;
      case 'session-terminate-result':
        this.pendingSessionTerminations.get(msg.requestId)?.(msg.result);
        this.pendingSessionTerminations.delete(msg.requestId);
        break;
      case 'session-list':
        this.pendingListSessions.shift()?.(msg.sessions);
        break;
      case 'run-list':
        this.restartResumableRuns.clear();
        for (const run of msg.runs) {
          if (run.resumeOwned) this.restartResumableRuns.add(runKey(run.sessionId, run.runId));
        }
        e2eLog(
          'transport:run-list',
          `count=${msg.runs.length}`,
          `resumeOwned=${this.restartResumableRuns.size}`,
        );
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
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        if (!isAgentActivitySnapshot(msg.snapshot)) {
          if (typeof msg.requestId === 'string') {
            this.pendingAgentSnapshots.get(msg.requestId)?.(this.agentSnapshot);
            this.pendingAgentSnapshots.delete(msg.requestId);
          }
          break;
        }
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

      case 'agent-coordination-snapshot': {
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        if (isAgentCoordinationSnapshot(msg.snapshot)) {
          const changed = this.awaitingAgentCoordinationSeed
            || msg.snapshot.revision > this.agentCoordinationSnapshot.revision;
          this.awaitingAgentCoordinationSeed = false;
          if (changed) {
            this.agentCoordinationSnapshot = msg.snapshot;
            for (const listener of this.agentCoordinationSnapshotListeners) listener(msg.snapshot);
          }
          if (msg.requestId) {
            this.pendingAgentCoordinationSnapshots.get(msg.requestId)?.(this.agentCoordinationSnapshot);
            this.pendingAgentCoordinationSnapshots.delete(msg.requestId);
          }
        } else if (msg.requestId) {
          this.pendingAgentCoordinationSnapshots.get(msg.requestId)?.(this.agentCoordinationSnapshot);
          this.pendingAgentCoordinationSnapshots.delete(msg.requestId);
        }
        break;
      }

      case 'agent-seen-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        this.pendingAgentSeen.get(msg.requestId)?.(msg.marked === true);
        this.pendingAgentSeen.delete(msg.requestId);
        break;

      case 'managed-merge-decision-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        this.pendingManagedMergeDecisions.get(msg.requestId)?.(
          isManagedMergeMutationResult(msg.result)
            ? msg.result
            : { ok: false, error: 'unavailable', message: 'Desktop returned an invalid merge decision.' },
        );
        this.pendingManagedMergeDecisions.delete(msg.requestId);
        break;
      case 'agent-followup-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        this.pendingAgentFollowups.get(msg.requestId)?.(
          isAgentFollowupResult(msg.result)
            ? msg.result
            : { ok: false, error: 'delivery-failed' },
        );
        this.pendingAgentFollowups.delete(msg.requestId);
        break;
      case 'agent-decision-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        {
          const pending = this.pendingAgentDecisions.get(msg.requestId);
          if (pending) {
            this.settlePendingAgentDecision(
              msg.requestId,
              pending,
              isAgentDecisionResult(msg.result)
                ? msg.result
                : { ok: false, error: 'outcome-unknown' },
            );
          }
        }
        break;
      case 'agent-projects-list-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentProjects.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjects.delete(msg.requestId);
        break;
      case 'agent-project-save-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectSaves.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectSaves.delete(msg.requestId);
        break;
      case 'agent-project-remove-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectRemovals.get(msg.requestId)?.(msg.removed);
        this.pendingAgentProjectRemovals.delete(msg.requestId);
        break;
      case 'agent-project-launchers-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchers.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchers.delete(msg.requestId);
        break;
      case 'agent-project-prepare-launch-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchPreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchPreparation.delete(msg.requestId);
        break;
      case 'agent-project-start-launch-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        this.pendingAgentProjectLaunchStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentProjectLaunchStarts.delete(msg.requestId);
        break;
      case 'agent-launch-prepare-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        this.pendingAgentLaunchPreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentLaunchPreparation.delete(msg.requestId);
        break;
      case 'agent-launch-start-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        this.pendingAgentLaunchStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentLaunchStarts.delete(msg.requestId);
        break;
      case 'agent-history-sessions-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentHistorySessions.get(msg.requestId)?.(msg.result);
        this.pendingAgentHistorySessions.delete(msg.requestId);
        break;
      case 'agent-history-read-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentHistoryReads.get(msg.requestId)?.(msg.result);
        this.pendingAgentHistoryReads.delete(msg.requestId);
        break;
      case 'agent-history-prepare-resume-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentResumePreparation.get(msg.requestId)?.(msg.result);
        this.pendingAgentResumePreparation.delete(msg.requestId);
        break;
      case 'agent-history-start-resume-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        this.pendingAgentResumeStarts.get(msg.requestId)?.(msg.result);
        this.pendingAgentResumeStarts.delete(msg.requestId);
        break;
      case 'pong': {
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        if (
          typeof msg.probeId !== 'string'
          || typeof msg.sentAt !== 'number'
          || !Number.isFinite(msg.sentAt)
        ) break;
        const pending = this.pendingRoundTripProbes.get(msg.probeId);
        if (!pending || pending.generation !== this.generation) break;
        this.pendingRoundTripProbes.delete(msg.probeId);
        const sample = Date.now() - pending.sentAt;
        // A clock that jumped backwards would otherwise report a negative or
        // absurd latency; ignore the sample rather than publish a lie.
        if (sample >= 0 && sample < RTT_MAX_PLAUSIBLE_MS) {
          this.roundTripMs = smoothRoundTrip(this.roundTripMs, sample);
          this.emitConnectionHealth();
        }
        break;
      }
      case 'git-status-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        this.pendingGitStatus.get(msg.requestId)?.(
          isGitDirectoryStatus(msg.status)
            ? msg.status
            : UNAVAILABLE_GIT_DIRECTORY_STATUS,
        );
        this.pendingGitStatus.delete(msg.requestId);
        break;
      case 'git-diff-reply':
        if ((this.negotiatedProtocolVersion ?? 0) < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        this.pendingGitDiffs.get(msg.requestId)?.(
          isGitDiffResult(msg.result)
            ? msg.result
            : { ok: false, error: 'git-failed' },
        );
        this.pendingGitDiffs.delete(msg.requestId);
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
        if (assembly.metaReceived) {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        if (!msg.ok) {
          this.pendingFileReads.delete(msg.requestId);
          assembly.resolve({
            ok: false,
            error: typeof msg.error === 'string' ? msg.error : 'Invalid file read response',
          });
          break;
        }
        if (
          !Number.isSafeInteger(msg.fileSize)
          || msg.fileSize < 0
          || !Number.isSafeInteger(msg.sendBytes)
          || msg.sendBytes < 0
          || msg.sendBytes > assembly.maxSendBytes
          || msg.sendBytes > msg.fileSize
          || typeof msg.isText !== 'boolean'
          || typeof msg.truncated !== 'boolean'
          || !isFileReadMetaConsistent(
            assembly,
            msg.fileSize,
            msg.sendBytes,
            msg.isText,
            msg.truncated,
            msg.preview,
          )
        ) {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        assembly.metaReceived = true;
        if (msg.sendBytes === 0) {
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
        try {
          assembly.buffer = new Uint8Array(msg.sendBytes);
        } catch {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        assembly.expectedOffset = 0;
        assembly.fileSize = msg.fileSize;
        assembly.isText = msg.isText;
        assembly.truncated = msg.truncated;
        assembly.preview = msg.preview ?? null;
        break;
      }

      case 'file-read-chunk': {
        const assembly = this.pendingFileReads.get(msg.requestId);
        if (!assembly) break;
        if (
          !assembly.metaReceived
          || !assembly.buffer
          || assembly.expectedOffset === null
          || !Number.isSafeInteger(msg.offset)
          || typeof msg.data !== 'string'
          || msg.data.length > MAX_FILE_CHUNK_BASE64_CHARS
          || typeof msg.done !== 'boolean'
        ) {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        let data: Uint8Array;
        try {
          data = base64ToUint8Array(msg.data);
        } catch {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        const received = msg.offset + data.length;
        if (
          msg.offset !== assembly.expectedOffset
          || data.length <= 0
          || data.length > FILE_CHUNK_BYTES
          || !Number.isSafeInteger(received)
          || received > assembly.buffer.length
          || msg.done !== (received === assembly.buffer.length)
        ) {
          this.failFileReadResponse(msg.requestId, assembly);
          break;
        }
        assembly.buffer.set(data, msg.offset);
        assembly.expectedOffset = received;
        assembly.onProgress?.(received, assembly.buffer.length);
        if (msg.done) {
          this.pendingFileReads.delete(msg.requestId);
          assembly.expectedOffset = null;
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

      case 'openclaw-control':
        for (const listener of this.openclawControlListeners) listener(msg.control);
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
