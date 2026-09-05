/**
 * RemoteBridge — WS multiplexer for the mobile remote-control bridge (M0).
 *
 * Reuses the SAME per-run MessagePort broker shape as `main.ts`'s
 * `run-command` IPC handler (a fresh port pair per run; one half transferred
 * to the interpreter, the other kept here): a WS connection stands in for the
 * renderer's side of that port, relaying `InterpreterFrame`/`RendererControl`
 * over the single multiplexed socket instead of a dedicated MessagePort.
 * View lifecycle is exposed only through host-issued session-surface
 * capabilities. The interpreter broker remains the session/run authority;
 * clients cannot invoke its raw create/destroy operations.
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
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

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
  REMOTE_CAPABILITY_DESKTOP_CONTROL,
  REMOTE_CAPABILITY_QUICK_COMMANDS_READ,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION_AGENT_HISTORY,
  REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS,
  REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS,
  REMOTE_PROTOCOL_VERSION_AGENT_LIVE,
  REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION,
  REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION_WRITE,
  REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION,
  REMOTE_PROTOCOL_VERSION_DESKTOP_CONTROL,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  isRemoteProtocolVersion,
  MAX_DESKTOP_VIEWPORT_PIXELS,
  MIN_DESKTOP_VIEWPORT_PIXELS,
  base64ToUint8Array,
  encodeFrame,
  uint8ArrayToBase64,
  type ClientToServerMessage,
  type OpenClawChatTicketFailureReason,
  type DesktopControlEndedMessage,
  type DesktopControlStartResultMessage,
  type DesktopControlStatusMessage,
  type DesktopNormalizedRegion,
  type DesktopQualityPreference,
  type DesktopVideoViewport,
  type DesktopSessionSignal,
  type DesktopSignalMessage,
  type RemoteClientIdentity,
  type RemoteProtocolVersion,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../shared/remote-protocol';
import {
  DAEMON_PROTOCOL_VERSION,
  parseDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import {
  DAEMON_DATABASE_SCHEMA_VERSION,
  redactDaemonAuthorityAvailability,
  type DaemonAuthorityAvailability,
  type RemoteDaemonAuthorityAvailability,
} from '../shared/daemon-authority';
import {
  isSessionSurfaceCloseDecisions,
  isSessionSurfaceCloseEntries,
  isSessionSurfaceId,
  isSessionSurfaceIntent,
} from '../shared/session-surface';
import {
  MAX_QUICK_COMMANDS,
  QuickCommandSchema,
  type QuickCommand,
} from '../shared/quick-command';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import type { FileReadStream } from './file-service';
import type {
  AgentActivitySnapshot,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
} from '../shared/agent';
import {
  withoutManagedMergeOutput,
  type AgentCoordinationMutationResult,
  type AgentCoordinationSnapshot,
  type AgentProjectCoordination,
  type AgentProjectCoordinationInput,
  type ManagedMergeRequest,
} from '../shared/agent-coordination';
import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  type AgentOrchestrationMutationResult,
  type AgentOrchestrationSnapshot,
  type CollaborationPolicy,
  type CollaborationPolicyInput,
  type CollaborationRun,
  type CollaborationTask,
} from '../shared/agent-orchestration';
import type {
  AgentHistorySessionPage,
  AgentLaunchPreparation,
  AgentLaunchTarget,
  AgentProjectInput,
  AgentProjectLaunchPreparation,
  AgentProjectLauncherSummary,
  AgentProjectMutationResult,
  AgentProjectPage,
  AgentResumePreparation,
  AgentResumeRootChoice,
  AgentTranscriptPage,
} from '../shared/agent-history';
import {
  UNAVAILABLE_GIT_DIRECTORY_STATUS,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../shared/git-status';
import {
  isWorktreeRequest,
  type WorktreeRequest,
  type WorktreeRequestOrigin,
  type WorktreeResult,
} from '../shared/worktree';
import type { InterpreterBroker, RemoteInterpreter, RemoteMessageChannel, RemotePort } from './interpreter-broker';
import { RemoteRunInitiatorRegistry } from './remote-run-initiator';
import { RemoteRunLeaseRegistry } from './remote-run-lease';
import { SessionSurfaceAuthority } from './session-surface-authority';
import { resolveTerminalFileLocation } from './terminal-path-resolver';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
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
/** Pending begin calls and ready upload FileHandles share this per-connection
 * budget. FileService independently enforces a process-wide ceiling. */
export const MAX_REMOTE_FILE_UPLOADS = 8;
/** Shared correlation-id ceiling for low-cost control requests. */
const MAX_REMOTE_REQUEST_ID_LENGTH = 128;
const MAX_REMOTE_AGENT_ID_LENGTH = 256;
const MAX_REMOTE_AGENT_TEXT_LENGTH = 8_192;
/** Agent Hub resolves several branches in parallel. Keep Git work bounded
 * without orphaning earlier request/reply promises. */
const MAX_REMOTE_GIT_REQUESTS = 16;
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

function normalizeSocketAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
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

type RemoteFileUploadRecord = {
  /** False once commit/abort (or a fatal protocol rejection) owns terminal. */
  acceptingMessages: boolean;
  /** The wire contract permits exactly one unacknowledged chunk. */
  chunkInFlight: boolean;
  /** Distinguishes a queued commit from an abort that close/error must dedupe. */
  terminalKind: 'none' | 'commit' | 'abort';
  /** Per-upload promise chain: the source never observes overlapping fd work. */
  operationTail: Promise<void>;
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

function isRemoteAgentLaunchTarget(value: unknown): value is AgentLaunchTarget {
  if (!isRecord(value)) return false;
  if (value.kind === 'project') {
    return (
      Object.keys(value).every((key) => key === 'kind' || key === 'projectId')
      &&
      typeof value.projectId === 'string'
      && value.projectId.length > 0
      && value.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH
    );
  }
  if (value.kind === 'directory') {
    return (
      typeof value.directory === 'string'
      && value.directory.length > 0
      && value.directory.length <= 8_192
    );
  }
  return false;
}

const MAX_GUARDED_DESTROY_ID_LENGTH = 256;
const MAX_DESKTOP_SDP_BYTES = 256 * 1024;
const MAX_DESKTOP_ICE_BYTES = 8 * 1024;

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

function isRemoteClientIdentity(value: unknown): value is RemoteClientIdentity {
  if (!isRecord(value)) return false;
  return value.platform === 'android'
    && typeof value.clientId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.clientId)
    && typeof value.clientName === 'string'
    && value.clientName.trim().length > 0
    && value.clientName.length <= 80
    && ![...value.clientName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || codePoint === 0x061c
        || codePoint === 0x200e
        || codePoint === 0x200f
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    });
}

function isDesktopSignal(value: unknown): value is DesktopSessionSignal {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'offer' || value.type === 'answer') {
    return typeof value.sdp === 'string'
      && value.sdp.length > 0
      && Buffer.byteLength(value.sdp) <= MAX_DESKTOP_SDP_BYTES;
  }
  if (value.type !== 'ice' || !isRecord(value.candidate)) return false;
  return typeof value.candidate.candidate === 'string'
    && value.candidate.candidate.length > 0
    && Buffer.byteLength(value.candidate.candidate) <= MAX_DESKTOP_ICE_BYTES
    && (value.candidate.sdpMid === undefined
      || value.candidate.sdpMid === null
      || typeof value.candidate.sdpMid === 'string')
    && (value.candidate.sdpMLineIndex === undefined
      || value.candidate.sdpMLineIndex === null
      || isFiniteNumber(value.candidate.sdpMLineIndex));
}

function isDesktopVideoViewport(value: unknown): value is DesktopVideoViewport {
  if (!isRecord(value)) return false;
  return (
    typeof value.pixelWidth === 'number'
    && Number.isInteger(value.pixelWidth)
    && value.pixelWidth >= MIN_DESKTOP_VIEWPORT_PIXELS
    && value.pixelWidth <= MAX_DESKTOP_VIEWPORT_PIXELS
    && typeof value.pixelHeight === 'number'
    && Number.isInteger(value.pixelHeight)
    && value.pixelHeight >= MIN_DESKTOP_VIEWPORT_PIXELS
    && value.pixelHeight <= MAX_DESKTOP_VIEWPORT_PIXELS
    && (value.visibleRegion === undefined || isDesktopNormalizedRegion(value.visibleRegion))
    && (value.revision === undefined
      || (Number.isSafeInteger(value.revision) && (value.revision as number) > 0))
  );
}

function isDesktopNormalizedRegion(value: unknown): value is DesktopNormalizedRegion {
  if (!isRecord(value)) return false;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  return [x, y, width, height].every(isFiniteNumber)
    && (x as number) >= 0
    && (y as number) >= 0
    && (x as number) < 1
    && (y as number) < 1
    && (width as number) > 0
    && (height as number) > 0
    && (x as number) + (width as number) <= 1 + 1e-9
    && (y as number) + (height as number) <= 1 + 1e-9;
}

function isDesktopQualityPreference(value: unknown): value is DesktopQualityPreference {
  return value === 'balanced' || value === 'clarity' || value === 'responsiveness';
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
    case 'session-surface-open':
      return isGuardedDestroyId(value.requestId)
        && isSessionSurfaceId(value.surfaceId)
        && isSessionSurfaceIntent(value.intent)
        && value.intent.kind !== 'create-project';
    case 'session-surface-prepare-close':
      return isGuardedDestroyId(value.requestId)
        && isSessionSurfaceCloseEntries(value.entries);
    case 'session-surface-commit-close':
      return isGuardedDestroyId(value.requestId)
        && isSessionSurfaceId(value.closeToken)
        && isSessionSurfaceCloseDecisions(value.decisions);
    case 'session-surface-release':
      return isGuardedDestroyId(value.requestId)
        && isSessionSurfaceId(value.bindingId);
    case 'session-terminate-guarded':
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
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'agent-coordination-snapshot-get':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'agent-coordination-project-save':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && isRecord(value.input)
      );
    case 'agent-orchestration-snapshot-get':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'agent-collaboration-policy-save':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && isRecord(value.input)
      );
    case 'agent-orchestration-action':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && ['cancel-worker', 'archive-worker', 'stop-run'].includes(String(value.action))
        && typeof value.runId === 'string'
        && value.runId.length > 0
        && value.runId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && (value.taskId === undefined || (
          typeof value.taskId === 'string'
          && value.taskId.length > 0
          && value.taskId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        ))
        && (value.action === 'stop-run' || typeof value.taskId === 'string')
      );
    case 'agent-legacy-migration-confirm':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'daemon-snapshot-get':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'daemon-transcript-get':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.sessionId === 'string'
        && value.sessionId.length > 0
        && value.sessionId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && Number.isSafeInteger(value.afterSequence)
        && (value.afterSequence as number) >= 0
        && Number.isSafeInteger(value.limit)
        && (value.limit as number) >= 1
        && (value.limit as number) <= 2_000
      );
    case 'daemon-command':
      if (
        typeof value.requestId !== 'string'
        || value.requestId.length === 0
        || value.requestId.length > MAX_REMOTE_REQUEST_ID_LENGTH
      ) return false;
      try {
        parseDaemonCommand(value.command);
        return true;
      } catch {
        return false;
      }
    case 'daemon-events-subscribe':
      return Number.isSafeInteger(value.afterSequence) && (value.afterSequence as number) >= 0;
    case 'daemon-events-unsubscribe':
      return true;
    case 'agent-seen':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.activityId === 'string'
        && value.activityId.length > 0
        && value.activityId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && Number.isSafeInteger(value.stateSeq)
        && (value.stateSeq as number) >= 0
      );
    case 'managed-merge-decision':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.mergeRequestId === 'string'
        && value.mergeRequestId.length > 0
        && value.mergeRequestId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && Number.isSafeInteger(value.revision)
        && (value.revision as number) > 0
        && (value.decision === 'approve' || value.decision === 'deny')
        && (value.overrideReason === undefined || (
          typeof value.overrideReason === 'string'
          && value.overrideReason.length <= 500
        ))
      );
    case 'agent-followup':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.activityId === 'string'
        && value.activityId.length > 0
        && value.activityId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof value.text === 'string'
        && value.text.length <= MAX_REMOTE_AGENT_TEXT_LENGTH
      );
    case 'agent-decision':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.activityId === 'string'
        && value.activityId.length > 0
        && value.activityId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof value.approvalId === 'string'
        && value.approvalId.length > 0
        && value.approvalId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && (value.decision === 'allow' || value.decision === 'deny')
      );
    case 'agent-projects-list':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && (value.query === undefined
          || (typeof value.query === 'string' && value.query.length <= 512))
      );
    case 'agent-project-save': {
      const input = isRecord(value.input) ? value.input : null;
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && input !== null
        && (input.projectId === undefined
          || (typeof input.projectId === 'string' && input.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH))
        && typeof input.name === 'string'
        && typeof input.primaryRoot === 'string'
        && Array.isArray(input.additionalRoots)
        && input.additionalRoots.every((root) => typeof root === 'string')
        && typeof input.pinned === 'boolean'
      );
    }
    case 'agent-project-remove':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.projectId === 'string'
        && value.projectId.length > 0
        && value.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    case 'agent-project-launchers':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
      );
    case 'agent-project-prepare-launch':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.projectId === 'string'
        && value.projectId.length > 0
        && value.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof value.launcherId === 'string'
        && value.launcherId.length > 0
        && value.launcherId.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    case 'agent-project-start-launch': {
      const request = isRecord(value.request) ? value.request : null;
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && request !== null
        && typeof request.projectId === 'string'
        && request.projectId.length > 0
        && request.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.launcherId === 'string'
        && request.launcherId.length > 0
        && request.launcherId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.sessionId === 'string'
        && request.sessionId.length > 0
        && request.sessionId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.runId === 'string'
        && request.runId.length > 0
        && request.runId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.revision === 'string'
        && request.revision.length > 0
        && request.revision.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    }
    case 'agent-launch-prepare':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && isRemoteAgentLaunchTarget(value.target)
        && typeof value.launcherId === 'string'
        && value.launcherId.length > 0
        && value.launcherId.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    case 'agent-launch-start': {
      const request = isRecord(value.request) ? value.request : null;
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && request !== null
        && isRemoteAgentLaunchTarget(request.target)
        && typeof request.launcherId === 'string'
        && request.launcherId.length > 0
        && request.launcherId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.sessionId === 'string'
        && request.sessionId.length > 0
        && request.sessionId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.runId === 'string'
        && request.runId.length > 0
        && request.runId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.revision === 'string'
        && request.revision.length > 0
        && request.revision.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    }
    case 'agent-history-sessions':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.projectId === 'string'
        && value.projectId.length > 0
        && value.projectId.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    case 'agent-history-read':
    case 'agent-history-prepare-resume':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.historyId === 'string'
        && value.historyId.length > 0
        && value.historyId.length <= MAX_REMOTE_AGENT_ID_LENGTH
      );
    case 'agent-history-start-resume': {
      const request = isRecord(value.request) ? value.request : null;
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && request !== null
        && typeof request.historyId === 'string'
        && request.historyId.length > 0
        && request.historyId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.sessionId === 'string'
        && request.sessionId.length > 0
        && request.sessionId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.runId === 'string'
        && request.runId.length > 0
        && request.runId.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && typeof request.revision === 'string'
        && request.revision.length > 0
        && request.revision.length <= MAX_REMOTE_AGENT_ID_LENGTH
        && (request.rootChoice === 'recorded' || request.rootChoice === 'current')
      );
    }
    case 'worktree-request':
      return typeof value.requestId === 'string';
    case 'git-status':
    case 'git-diff':
      return (
        typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && typeof value.directory === 'string'
        && value.directory.length > 0
        && value.directory.length <= 8_192
      );
    case 'ping':
      return (
        typeof value.probeId === 'string'
        && value.probeId.length > 0
        && value.probeId.length <= MAX_REMOTE_REQUEST_ID_LENGTH
        && isFiniteNumber(value.sentAt)
      );
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
    case 'desktop-control-start':
      return typeof value.requestId === 'string'
        && value.requestId.length > 0
        && value.requestId.length <= 256
        && (value.viewport === undefined || isDesktopVideoViewport(value.viewport))
        && (value.qualityPreference === undefined
          || isDesktopQualityPreference(value.qualityPreference));
    case 'desktop-signal':
      return typeof value.sessionId === 'string'
        && value.sessionId.length <= 256
        && isDesktopSignal(value.signal);
    case 'desktop-control-stop':
      return typeof value.sessionId === 'string'
        && value.sessionId.length <= 256
        && (value.reason === 'client-stop' || value.reason === 'background' || value.reason === 'navigation');
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
  subscribeControl(listener: (snapshot: OpenClawControlSnapshot) => void): () => void;
  runLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleReceipt>;
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
  sendFollowup(activityId: string, text: string): Promise<AgentFollowupResult>;
  decideApproval(activityId: string, approvalId: string, decision: AgentDecision): AgentDecisionResult;
}

export interface RemoteAgentCoordinationSource {
  getSnapshot(): AgentCoordinationSnapshot;
  onSnapshot(
    listener: (snapshot: AgentCoordinationSnapshot) => void,
  ): () => void;
  saveProject(
    input: AgentProjectCoordinationInput,
  ): Promise<AgentCoordinationMutationResult<AgentProjectCoordination>>;
  markSeen(activityId: string, stateSeq: number): boolean;
  decideManagedMerge(input: {
    readonly requestId: string;
    readonly revision: number;
    readonly decision: 'approve' | 'deny';
    readonly actor: 'mobile';
    readonly overrideReason?: string;
  }): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>>;
}

export interface RemoteAgentOrchestrationSource {
  getSnapshot(): AgentOrchestrationSnapshot;
  onSnapshot(
    listener: (snapshot: AgentOrchestrationSnapshot) => void,
  ): () => void;
  savePolicy(
    input: CollaborationPolicyInput,
  ): Promise<AgentOrchestrationMutationResult<CollaborationPolicy>>;
  cancelWorker(
    runId: string,
    taskId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>>;
  archiveWorker(
    runId: string,
    taskId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>>;
  stopRun(runId: string): Promise<AgentOrchestrationMutationResult<CollaborationRun>>;
  confirmLegacyMigration(): Promise<AgentOrchestrationSnapshot['migration']>;
}

/** Revisioned runtime projection shared by Desktop IPC, Android, CLI and MCP. */
export interface RemoteDaemonSource {
  getAvailability?(): DaemonAuthorityAvailability;
  getSnapshot(): DaemonSnapshot;
  readTranscript?(
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): readonly DaemonTranscriptItem[];
  execute(command: DaemonCommand): Promise<DaemonCommandReceipt>;
  onEvent(listener: (event: DaemonEvent) => void): () => void;
}

function remoteDaemonAvailability(source: RemoteDaemonSource): RemoteDaemonAuthorityAvailability {
  try {
    const availability = source.getAvailability?.() ?? {
      state: 'ready' as const,
      supportedSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
      currentSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
    };
    return redactDaemonAuthorityAvailability(availability);
  } catch {
    return {
      state: 'legacy-only-safe-mode',
      initializationCode: 'initialization-failed',
      databaseDisposition: 'preserved',
      supportedSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
    };
  }
}

function daemonRevision(source: RemoteDaemonSource): number {
  try {
    return source.getSnapshot().revision;
  } catch {
    return 0;
  }
}

function remoteCoordinationSnapshot(snapshot: AgentCoordinationSnapshot): AgentCoordinationSnapshot {
  return {
    ...snapshot,
    mergeRequests: snapshot.mergeRequests.map(withoutManagedMergeOutput),
  };
}

function remoteMergeDecisionResult(
  result: AgentCoordinationMutationResult<ManagedMergeRequest>,
): AgentCoordinationMutationResult<ManagedMergeRequest> {
  return result.ok ? { ok: true, value: withoutManagedMergeOutput(result.value) } : result;
}

export interface RemoteAgentHistorySource {
  listProjects(force?: boolean, cursor?: string, limit?: number, query?: string): Promise<AgentProjectPage>;
  saveProject?(input: AgentProjectInput): Promise<AgentProjectMutationResult>;
  removeProject?(projectId: string): Promise<boolean>;
  listLaunchers?(): readonly AgentProjectLauncherSummary[];
  prepareLaunch?(target: AgentLaunchTarget, launcherId: string): Promise<AgentLaunchPreparation>;
  prepareProjectLaunch?(projectId: string, launcherId: string): Promise<AgentProjectLaunchPreparation>;
  resolveLaunch?(
    target: AgentLaunchTarget,
    launcherId: string,
    revision: string,
  ): Promise<
    | {
      readonly ok: true;
      readonly roots: readonly string[];
      readonly commandText: string;
      readonly displayCommandText: string;
    }
    | { readonly ok: false; readonly reason: 'not-found' | 'stale' | 'missing-root' | 'unavailable' }
  >;
  listSessions(
    projectId: string,
    cursor?: string,
    limit?: number,
    force?: boolean,
  ): Promise<AgentHistorySessionPage>;
  readTranscript(historyId: string, cursor?: string, limit?: number): Promise<AgentTranscriptPage | null>;
  prepareResume(historyId: string): Promise<AgentResumePreparation | null>;
  recordLaunchTargetWork(
    target: AgentLaunchTarget,
    roots: readonly string[],
    lastActiveAt?: number,
  ): Promise<void>;
  recordResumeWork(historyId: string, lastActiveAt?: number): Promise<void>;
  resolveResume(
    historyId: string,
    revision: string,
    choice: AgentResumeRootChoice,
  ): Promise<
    | {
      readonly ok: true;
      readonly roots: readonly string[];
      /** Built by the provider adapter; carries the provider's private id. */
      readonly commandText: string;
      /** All the mobile client and shell history ever see. */
      readonly displayCommandText: string;
    }
    | { readonly ok: false; readonly reason: 'not-found' | 'stale' | 'missing-root' | 'unavailable' }
  >;
}

/** Read-only Git working-tree queries. Nothing here can mutate a repository,
 * so unlike the worktree service it needs no origin and no gate. */
export interface RemoteGitSource {
  getStatus(directory: string, signal?: AbortSignal): Promise<GitDirectoryStatus>;
  getDiff(directory: string, signal?: AbortSignal): Promise<GitDiffResult>;
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

export type RemoteDesktopServerEvent =
  | DesktopSignalMessage
  | DesktopControlStatusMessage
  | DesktopControlEndedMessage;

type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K & keyof T> : never;

export interface RemoteDesktopSource {
  /** False suppresses capability advertisement before the installed host is ready. */
  isAvailable?(): boolean;
  /** Establishes socket-generation authority immediately after authentication. */
  connected(clientId: string, connectionId: string): void;
  start(
    identity: RemoteClientIdentity,
    connectionId: string,
    endpoint: { readonly localAddress: string; readonly peerAddress: string },
    emit: (event: RemoteDesktopServerEvent) => void,
    viewport?: DesktopVideoViewport,
    qualityPreference?: DesktopQualityPreference,
  ): Promise<DistributedOmit<DesktopControlStartResultMessage, 'kind' | 'requestId'>>;
  signal(
    clientId: string,
    connectionId: string,
    sessionId: string,
    signal: DesktopSessionSignal,
  ): boolean;
  stop(clientId: string, connectionId: string, sessionId: string): Promise<boolean>;
  disconnected(clientId: string, connectionId: string): void;
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
  /** Shared with desktop IPC so every transport observes one ownership graph. */
  readonly sessionSurfaceAuthority?: SessionSurfaceAuthority;
  /** Optional so existing fixtures/tests without stats wiring keep working. */
  readonly statsSource?: RemoteStatsSource;
  /** Optional so existing fixtures/tests without packet wiring keep working. */
  readonly packetSource?: RemotePacketSource;
  /** Optional so existing fixtures/tests without file wiring keep working. */
  readonly fileSource?: RemoteFileSource;
  /** Optional so existing fixtures/tests without OpenClaw wiring keep working. */
  readonly openclawSource?: RemoteOpenClawSource;
  readonly agentSource?: RemoteAgentSource;
  readonly agentCoordinationSource?: RemoteAgentCoordinationSource;
  readonly agentOrchestrationSource?: RemoteAgentOrchestrationSource;
  readonly daemonSource?: RemoteDaemonSource;
  readonly agentHistorySource?: RemoteAgentHistorySource;
  /** Optional so existing fixtures without Git wiring keep working. */
  readonly gitSource?: RemoteGitSource;
  /** Redeems a one-time pairing code. Absent means pairing is unavailable and
   * only the bearer token authenticates. */
  readonly pairingSource?: {
    /** Non-consuming constant-time match; returns an opaque issue generation. */
    match(code: string): number | null;
    /** Atomically consumes only the same issue generation that was matched. */
    consume(code: string, generation: number): boolean;
  };
  /** Optional so older bridge fixtures remain valid. */
  readonly worktreeSource?: RemoteWorktreeSource;
  /** Optional capability: old hosts omit it and mobile hides the surface. */
  readonly quickCommandSource?: RemoteQuickCommandSource;
  /** Optional until the privileged host is installed and ready. */
  readonly desktopSource?: RemoteDesktopSource;
  /** Trusted VPN address selected by main. Defaults only for legacy tests. */
  readonly bindHost?: string;
  /** Shared across websocket generations so transiently orphaned runs resume. */
  readonly runLeases?: RemoteRunLeaseRegistry;
  /** Shared across generations for the full lifetime of an active mobile run. */
  readonly runInitiators?: RemoteRunInitiatorRegistry;
  /** Called once a client has authenticated and supplied a valid identity, and
   * again when its socket closes. Purely observational — it drives the Remote
   * panel's device roster and never gates auth or capability. */
  readonly onClientPresence?: (
    identity: RemoteClientIdentity,
    presence: 'connected' | 'disconnected',
    connectionId: string,
  ) => void;
}

const defaultRunLeases = new WeakMap<InterpreterBroker, RemoteRunLeaseRegistry>();
const defaultSessionSurfaceAuthorities = new WeakMap<InterpreterBroker, SessionSurfaceAuthority>();
const defaultRunInitiators = new WeakMap<
  InterpreterBroker,
  RemoteRunInitiatorRegistry
>();

function leasesFor(options: RemoteBridgeOptions): RemoteRunLeaseRegistry {
  if (options.runLeases) return options.runLeases;
  let leases = defaultRunLeases.get(options.broker);
  if (!leases) {
    leases = new RemoteRunLeaseRegistry();
    defaultRunLeases.set(options.broker, leases);
  }
  return leases;
}

function sessionSurfacesFor(options: RemoteBridgeOptions): SessionSurfaceAuthority {
  if (options.sessionSurfaceAuthority) return options.sessionSurfaceAuthority;
  let authority = defaultSessionSurfaceAuthorities.get(options.broker);
  if (!authority) {
    authority = new SessionSurfaceAuthority(options.broker);
    defaultSessionSurfaceAuthorities.set(options.broker, authority);
  }
  return authority;
}

function initiatorsFor(options: RemoteBridgeOptions): RemoteRunInitiatorRegistry {
  if (options.runInitiators) return options.runInitiators;
  let initiators = defaultRunInitiators.get(options.broker);
  if (!initiators) {
    initiators = new RemoteRunInitiatorRegistry(options.broker);
    defaultRunInitiators.set(options.broker, initiators);
  }
  return initiators;
}

/**
 * Attach the bridge's protocol handling to one already-open WS connection.
 * Exported standalone (not bundled into `startRemoteBridge`) so tests can
 * drive it with a fake `RemoteWs` without opening a real network socket.
 */
export function attachConnection(
  ws: RemoteWs,
  options: RemoteBridgeOptions,
  hooks?: {
    onAuthenticated?: () => void;
    onUploadDrain?: (drain: Promise<void>) => void;
    readonly localAddress?: string;
    readonly peerAddress?: string;
  },
): void {
  let authed = false;
  let negotiatedProtocol: RemoteProtocolVersion = REMOTE_PROTOCOL_VERSION;
  let clientIdentity: RemoteClientIdentity | null = null;
  let sessionSurfacePrincipalId: string | null = null;
  let authPending = false;
  let releaseRunsOnClose = false;
  let connectionClosed = false;
  let daemonEventsSubscribed = false;
  const connectionId = randomUUID();
  const sessionSurfaces = sessionSurfacesFor(options);
  const runLeases = leasesFor(options);
  const runInitiators = initiatorsFor(options);
  const terminalCapabilities = new TerminalFileCapabilityStore();
  const runs = new Map<string, {
    readonly sessionId: string;
    readonly port: RemotePort;
    readonly initiatedHere: boolean;
  }>();
  const pendingLeaseResumes = new Map<string, { readonly sessionId: string; readonly runId: string }>();
  const pendingResumeAttempts = new Set<string>();
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
  const fileUploads = new Map<string, RemoteFileUploadRecord>();
  const pendingUploadBegins = new Set<string>();
  const pendingUploadBeginOperations = new Set<Promise<void>>();
  const pendingGitRequests = new Map<string, AbortController>();
  // OpenClaw management (M4): this connection's own status/logs subscription
  // state — same shape as stats/packets above (refcounted on the service
  // side via `subscribeStatus`/`subscribeLogs`; per-connection here is just
  // "do I currently have one, and its unsubscribe").
  let openclawStatusSubscribed = false;
  let openclawStatusUnsub: (() => void) | null = null;
  let openclawControlUnsub: (() => void) | null = null;
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
  const sessionMatchesPrimaryRoot = (sessionId: string, roots: readonly string[]): boolean => {
    const primaryRoot = roots[0];
    const session = options.broker.listSessions().find((item) => item.sessionId === sessionId);
    if (!primaryRoot || !session) return false;
    const key = (value: string): string => {
      const normalized = path.normalize(path.resolve(value));
      return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
    };
    return key(session.cwd) === key(primaryRoot);
  };
  const installPrivateRun = (
    sessionId: string,
    runId: string,
    commandText: string,
    displayCommandText: string,
    beforeStart: () => void,
  ): boolean => {
    const port = options.broker.runPrivateCommand(
      sessionId,
      runId,
      commandText,
      displayCommandText,
      'mobile',
    );
    if (!port) return false;
    if (clientIdentity) runInitiators.remember(sessionId, runId, clientIdentity.clientId);
    const record = { sessionId, port, initiatedHere: true };
    runs.get(runId)?.port.close();
    runs.set(runId, record);
    port.on('message', (event) => {
      send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
    });
    port.on('close', () => {
      if (runs.get(runId) === record) runs.delete(runId);
    });
    beforeStart();
    port.start();
    return true;
  };

  const queueFileUploadAbort = (
    uploadId: string,
    record: RemoteFileUploadRecord,
    afterAbort?: () => void,
  ): void => {
    if (record.terminalKind === 'abort') return;
    record.acceptingMessages = false;
    record.chunkInFlight = false;
    record.terminalKind = 'abort';
    const abort = record.operationTail.then(async () => {
      try {
        await options.fileSource?.abortUpload(uploadId);
      } catch {
        // Source failures are contained; the slot is still released exactly
        // once when this terminal operation settles.
      }
      if (!connectionClosed) afterAbort?.();
    });
    record.operationTail = abort.then(() => undefined, () => undefined);
    // A terminating upload still owns its per-connection slot until the
    // underlying source has actually released its fd/part-file resources.
    void record.operationTail.then(() => {
      if (fileUploads.get(uploadId) === record) fileUploads.delete(uploadId);
    });
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
    if (pendingResumeAttempts.has(pendingKey)) return;
    pendingResumeAttempts.add(pendingKey);
    const leaseWasPresent = runLeases.has(sessionId, runId);
    const initiatedByClient = clientIdentity !== null
      && runInitiators.isInitiatedBy(
        sessionId,
        runId,
        clientIdentity.clientId,
      );
    if (leaseWasPresent) pendingLeaseResumes.set(pendingKey, { sessionId, runId });
    const attached = await options.broker.attachRunChecked(sessionId, runId)
      .catch(() => null)
      .finally(() => pendingResumeAttempts.delete(pendingKey));
    if (leaseWasPresent) pendingLeaseResumes.delete(pendingKey);

    if (!attached) {
      if (!connectionClosed && !releaseRunsOnClose) {
        send({
          kind: 'resume-run-busy',
          sessionId,
          runId,
          generation,
          reason: 'unavailable',
          retryable: true,
        });
      }
      return;
    }
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

    const record = {
      sessionId,
      port: port1,
      initiatedHere: initiatedByClient,
    };
    runs.get(runId)?.port.close();
    runs.set(runId, record);
    port1.on('message', (event) => {
      send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
    });
    port1.on('close', () => {
      if (runs.get(runId) === record) runs.delete(runId);
    });
    // Reset the stable renderer before starting the replay queue. The
    // initiating installation reclaims PTY control independently of whether
    // its bounded liveness lease still exists. The lease-less case retains the
    // existing claim because an old socket may still be half-open. A resumed
    // observer lease stays viewing-only.
    send({ kind: 'resume-run-ready', sessionId, runId, generation });
    if (initiatedByClient || !orphan) {
      port1.postMessage({ type: 'pty-claim-control' });
    }
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
    const unsubscribe = packetsUnsub;
    packetsUnsub = null;
    if (packetFlushTimer !== null) {
      clearInterval(packetFlushTimer);
      packetFlushTimer = null;
    }
    pendingPacketRows = [];
    unsubscribe?.();
  };

  // OpenClaw management (M4): status/logs subscription teardown — same
  // idempotent-stop + backpressure-aware-flush shape as packets above.
  const stopOpenClawStatusSubscription = (): void => {
    if (!openclawStatusSubscribed) return;
    openclawStatusSubscribed = false;
    const unsubscribe = openclawStatusUnsub;
    const unsubscribeControl = openclawControlUnsub;
    openclawStatusUnsub = null;
    openclawControlUnsub = null;
    unsubscribe?.();
    unsubscribeControl?.();
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
    const unsubscribe = openclawLogsUnsub;
    openclawLogsUnsub = null;
    if (openclawLogFlushTimer !== null) {
      clearInterval(openclawLogFlushTimer);
      openclawLogFlushTimer = null;
    }
    pendingOpenClawLogLines = [];
    unsubscribe?.();
  };

  // Session/run mirroring (M2): every connection observes every session/run
  // change via the SHARED broker, origin-agnostic (including one THIS connection
  // just created — the broker resolves creation to SessionSurfaceAuthority
  // BEFORE its deferred onSessionAdded fan-out, so the requester receives its
  // binding before the broadcast echo (ADR C6). Gated on `authed` so an
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
      if (authed && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
        send({ kind: 'agent-snapshot', snapshot });
      }
    }) ?? (() => undefined);
  const unsubAgentCoordination =
    options.agentCoordinationSource?.onSnapshot((snapshot) => {
      if (authed && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) {
        send({ kind: 'agent-coordination-snapshot', snapshot: remoteCoordinationSnapshot(snapshot) });
      }
    }) ?? (() => undefined);
  const unsubAgentOrchestration =
    options.agentOrchestrationSource?.onSnapshot((snapshot) => {
      if (authed && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION) {
        send({ kind: 'agent-orchestration-snapshot', snapshot });
      }
    }) ?? (() => undefined);
  const unsubDaemonEvents =
    options.daemonSource?.onEvent((event) => {
      if (authed && daemonEventsSubscribed && negotiatedProtocol >= DAEMON_PROTOCOL_VERSION) {
        send({ kind: 'daemon-event', event });
      }
    }) ?? (() => undefined);

  ws.on('close', () => {
    if (connectionClosed) return;
    connectionClosed = true;
    const contain = (operation: () => void | Promise<unknown>): void => {
      try {
        void Promise.resolve(operation()).catch(() => undefined);
      } catch {
        // Teardown is a collection of independent ownership releases. One
        // stale observer or native handle must not strand the rest.
      }
    };
    const disconnectedIdentity = clientIdentity;
    const disconnectedSurfacePrincipal = sessionSurfacePrincipalId;
    sessionSurfacePrincipalId = null;
    if (disconnectedSurfacePrincipal) {
      contain(() => sessionSurfaces.disconnectClient(disconnectedSurfacePrincipal));
    }
    if (disconnectedIdentity) {
      contain(() => options.desktopSource?.disconnected(disconnectedIdentity.clientId, connectionId));
      contain(() => options.onClientPresence?.(disconnectedIdentity, 'disconnected', connectionId));
    }
    terminalCapabilities.clear();
    if (releaseRunsOnClose) contain(releasePendingResumeLeases);
    contain(unsubSessionAdded);
    contain(unsubSessionRemoved);
    contain(unsubRunStarted);
    contain(unsubOpenClawVisibility);
    contain(unsubAgentSnapshot);
    contain(unsubAgentCoordination);
    contain(unsubAgentOrchestration);
    contain(unsubDaemonEvents);
    for (const [runId, record] of runs) {
      if (releaseRunsOnClose) contain(() => record.port.close());
      else {
        contain(() => runLeases.park(record.sessionId, runId, record.port));
      }
    }
    runs.clear();
    if (statsVisible) {
      statsVisible = false;
      const unsubscribe = statsUnsub;
      statsUnsub = null;
      contain(() => unsubscribe?.());
      contain(() => options.statsSource?.release());
    }
    contain(stopPacketsSubscription);
    // File explorer (M3): a dropped connection is the only owner of its open
    // reads/uploads — close every stream and abort every upload rather than
    // leaving a `.ezpart` file or an fd open until the idle sweep gets to it.
    for (const [requestId, record] of fileReads) {
      contain(() => closeFileRead(requestId, record));
    }
    for (const [uploadId, record] of fileUploads) {
      record.acceptingMessages = false;
      queueFileUploadAbort(uploadId, record);
    }
    const uploadDrain = Promise.all([
      ...pendingUploadBeginOperations,
      ...[...fileUploads.values()].map((record) => record.operationTail),
    ]).then(() => undefined);
    hooks?.onUploadDrain?.(uploadDrain);
    // OpenClaw management (M4): same teardown discipline as stats/packets above.
    contain(stopOpenClawStatusSubscription);
    contain(stopOpenClawLogsSubscription);
    for (const controller of pendingGitRequests.values()) contain(() => controller.abort());
    pendingGitRequests.clear();
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
      const requestedProtocol = parsed.protocolVersion;
      const protocolCompatible = (
        isRemoteProtocolVersion(requestedProtocol)
        && requestedProtocol === REMOTE_PROTOCOL_VERSION
        && typeof parsed.clientVersion === 'string'
        && parsed.clientVersion.trim().length > 0
        && isRemoteClientIdentity(parsed.clientIdentity)
      );
      const candidateToken = parsed.token;
      authPending = true;
      void Promise.resolve(options.getToken()).then((token) => {
        if (connectionClosed || authed) return;
        // The bearer is checked first so an ordinary reconnect never burns the
        // pairing code the user is still looking at on screen.
        const byBearer = tokensMatch(candidateToken, token);
        const pairingGeneration = !byBearer
          ? (options.pairingSource?.match(candidateToken) ?? null)
          : null;
        if (byBearer || pairingGeneration !== null) {
          // Every credential kind requires the exact v7 lifecycle contract;
          // neither a persisted bearer nor a pairing code can negotiate down.
          if (!protocolCompatible) {
            send({
              kind: 'auth-fail',
              reason: 'incompatible-protocol',
              supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
              supportedProtocolVersions: SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
              hostVersion: options.hostVersion,
            });
            ws.close(PROTOCOL_CLOSE_CODE);
            return;
          }
          const byPairingCode = pairingGeneration !== null
            && (options.pairingSource?.consume(candidateToken, pairingGeneration) ?? false);
          // A replacement issue/redeem can invalidate the claim between
          // validation and this final consume. Fail closed instead of
          // authenticating a connection that did not consume its code.
          if (!byBearer && !byPairingCode) {
            send({ kind: 'auth-fail', reason: 'invalid-token' });
            ws.close(AUTH_CLOSE_CODE);
            return;
          }
          negotiatedProtocol = requestedProtocol as RemoteProtocolVersion;
          clientIdentity = isRemoteClientIdentity(parsed.clientIdentity)
            ? parsed.clientIdentity
            : null;
          if (!clientIdentity) {
            send({
              kind: 'auth-fail',
              reason: 'incompatible-protocol',
              supportedProtocolVersion: REMOTE_PROTOCOL_VERSION,
              supportedProtocolVersions: SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
              hostVersion: options.hostVersion,
            });
            ws.close(PROTOCOL_CLOSE_CODE);
            return;
          }
          sessionSurfacePrincipalId = `mobile:${clientIdentity.clientId}:${connectionId}`;
          sessionSurfaces.connectClient(
            sessionSurfacePrincipalId,
            `mobile:${clientIdentity.clientId}`,
          );
          if (clientIdentity) {
            // This is control authority, not observational presence: register
            // it before auth-ok so an older live socket cannot later reclaim a
            // desktop lease from the newest authenticated generation.
            options.desktopSource?.connected(clientIdentity.clientId, connectionId);
          }
          authed = true;
          if (clientIdentity) {
            try {
              options.onClientPresence?.(clientIdentity, 'connected', connectionId);
            } catch {
              // Presence is observational and cannot veto authentication.
            }
          }
          try {
            hooks?.onAuthenticated?.();
          } catch {
            // The bridge handshake remains authoritative if a lifecycle
            // observer has already been disposed.
          }
          const capabilities = [
            ...(options.quickCommandSource ? [REMOTE_CAPABILITY_QUICK_COMMANDS_READ] : []),
            ...(negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_DESKTOP_CONTROL
              && clientIdentity
              && options.desktopSource
              && (options.desktopSource.isAvailable?.() ?? true)
              && hooks?.localAddress
              && hooks.peerAddress
              ? [REMOTE_CAPABILITY_DESKTOP_CONTROL]
              : []),
          ];
          send({
            kind: 'auth-ok',
            protocolVersion: negotiatedProtocol,
            hostVersion: options.hostVersion,
            ...(options.buildSha ? { hostBuildSha: options.buildSha } : {}),
            ...(capabilities.length > 0 ? { capabilities } : {}),
            // Handing the bearer over is what turns a scan into a pairing. It
            // travels the channel the code just authenticated, which is the
            // same channel the bearer itself uses on every later connect.
            ...(byPairingCode ? { issuedToken: token } : {}),
          });
          if (options.agentSource && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_LIVE) {
            send({ kind: 'agent-snapshot', snapshot: options.agentSource.getSnapshot() });
          }
          if (
            options.agentCoordinationSource
            && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION
          ) {
            send({
              kind: 'agent-coordination-snapshot',
              snapshot: remoteCoordinationSnapshot(options.agentCoordinationSource.getSnapshot()),
            });
          }
          if (
            options.agentOrchestrationSource
            && negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION
          ) {
            send({
              kind: 'agent-orchestration-snapshot',
              snapshot: options.agentOrchestrationSource.getSnapshot(),
            });
          }
          if (options.daemonSource && negotiatedProtocol >= DAEMON_PROTOCOL_VERSION) {
            const availability = remoteDaemonAvailability(options.daemonSource);
            send({ kind: 'daemon-availability', availability });
            if (availability.state === 'ready') {
              try {
                send({ kind: 'daemon-snapshot', snapshot: options.daemonSource.getSnapshot() });
              } catch {
                send({ kind: 'daemon-snapshot', snapshot: null, unavailable: true });
              }
            }
          }
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
      case 'desktop-control-start': {
        const { requestId } = msg;
        if (
          negotiatedProtocol < REMOTE_PROTOCOL_VERSION_DESKTOP_CONTROL
          || !clientIdentity
          || !options.desktopSource
          || !(options.desktopSource.isAvailable?.() ?? true)
          || !hooks?.localAddress
          || !hooks.peerAddress
        ) {
          send({
            kind: 'desktop-control-start-result',
            requestId,
            ok: false,
            reason: 'unavailable',
            errorCode: 'DESKTOP_CONTROL_UNAVAILABLE',
          });
          break;
        }
        void options.desktopSource.start(
          clientIdentity,
          connectionId,
          { localAddress: hooks.localAddress, peerAddress: hooks.peerAddress },
          send,
          msg.viewport,
          msg.qualityPreference,
        ).then((result) => {
          if (!authed) return;
          if (result.ok) {
            send({ kind: 'desktop-control-start-result', requestId, ...result });
          } else {
            send({ kind: 'desktop-control-start-result', requestId, ...result });
          }
        }).catch(() => {
          if (authed) {
            send({
              kind: 'desktop-control-start-result',
              requestId,
              ok: false,
              reason: 'error',
              errorCode: 'DESKTOP_CONTROL_START_FAILED',
            });
          }
        });
        break;
      }

      case 'desktop-signal':
        if (clientIdentity && msg.signal.type !== 'answer') {
          options.desktopSource?.signal(
            clientIdentity.clientId,
            connectionId,
            msg.sessionId,
            msg.signal,
          );
        }
        break;

      case 'desktop-control-stop':
        if (clientIdentity) {
          void options.desktopSource?.stop(clientIdentity.clientId, connectionId, msg.sessionId);
        }
        break;

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
            if (!authed) return;
            send({
              kind: 'run-list',
              runs: runs.map((run) => (
                clientIdentity
                && runInitiators.isInitiatedBy(
                  run.sessionId,
                  run.runId,
                  clientIdentity.clientId,
                )
                  ? { ...run, resumeOwned: true }
                  : run
              )),
            });
          })
          .catch(() => {});
        break;
      }

      case 'session-surface-open': {
        const { requestId, surfaceId, intent } = msg;
        const principalId = sessionSurfacePrincipalId;
        if (!principalId) {
          send({
            kind: 'session-surface-open-result',
            requestId,
            result: { ok: false, reason: 'unavailable' },
          });
          break;
        }
        void sessionSurfaces.openSessionSurface(principalId, surfaceId, intent)
          .then((result) => {
            if (authed) send({ kind: 'session-surface-open-result', requestId, result });
          })
          .catch(() => {
            if (authed) {
              send({
                kind: 'session-surface-open-result',
                requestId,
                result: { ok: false, reason: 'unavailable' },
              });
            }
          });
        break;
      }

      case 'session-surface-prepare-close': {
        const { requestId, entries } = msg;
        const result = sessionSurfacePrincipalId
          ? sessionSurfaces.prepareSessionSurfaceClose(sessionSurfacePrincipalId, entries)
          : { ok: false as const, reason: 'unavailable' as const };
        send({ kind: 'session-surface-prepare-close-result', requestId, result });
        break;
      }

      case 'session-surface-commit-close': {
        const { requestId, closeToken, decisions } = msg;
        const principalId = sessionSurfacePrincipalId;
        if (!principalId) {
          send({
            kind: 'session-surface-commit-close-result',
            requestId,
            result: { ok: false, reason: 'unavailable' },
          });
          break;
        }
        void (async (): Promise<void> => {
          try {
            const result = await sessionSurfaces.commitSessionSurfaceClose(
              principalId,
              closeToken,
              decisions,
            );
            if (authed) {
              send({ kind: 'session-surface-commit-close-result', requestId, result });
            }
          } catch {
            if (authed) {
              send({
                kind: 'session-surface-commit-close-result',
                requestId,
                result: { ok: false, reason: 'unavailable' },
              });
            }
          }
        })();
        break;
      }

      case 'session-surface-release': {
        const { requestId, bindingId } = msg;
        const result = sessionSurfacePrincipalId
          ? sessionSurfaces.releaseSessionSurface(sessionSurfacePrincipalId, bindingId)
          : { ok: false as const, reason: 'state-changed' as const };
        send({ kind: 'session-surface-release-result', requestId, result });
        break;
      }

      case 'session-terminate-guarded': {
        const { requestId, sessionId, expectedActiveRunIds } = msg;
        void (async (): Promise<void> => {
          let result: DestroySessionGuardResult;
          try {
            result = await sessionSurfaces.terminateSessionGuarded(
              sessionId,
              expectedActiveRunIds,
            );
          } catch {
            result = { ok: false, reason: 'unavailable' };
          }
          if (authed) send({ kind: 'session-terminate-result', requestId, result });
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
        // Broker mints the port pair + posts port2 to the interpreter. Its
        // dispatch result distinguishes a real run from a broker-local error
        // port so only an actual mobile run receives durable initiator metadata.
        const dispatch = options.broker.tryRunCommand(
          msg.sessionId,
          runId,
          msg.commandText,
          'mobile',
        );
        const { port: port1 } = dispatch;
        if (!port1) break;
        if (dispatch.posted && clientIdentity) {
          runInitiators.remember(sessionId, runId, clientIdentity.clientId);
        }
        const record = { sessionId, port: port1, initiatedHere: true };
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
        const record = { sessionId, port: port1, initiatedHere: false };
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
        if (clientIdentity) {
          runInitiators.forgetClient(clientIdentity.clientId);
        }
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
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        send({
          kind: 'agent-snapshot',
          requestId: msg.requestId,
          snapshot: options.agentSource?.getSnapshot() ?? { revision: 0, items: [] },
        });
        break;

      case 'agent-coordination-snapshot-get':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        send({
          kind: 'agent-coordination-snapshot',
          requestId: msg.requestId,
          snapshot: options.agentCoordinationSource
            ? remoteCoordinationSnapshot(options.agentCoordinationSource.getSnapshot())
            : {
            revision: 0,
            activityRevision: 0,
            activities: [],
            projects: [],
            mergeRequests: [],
            },
        });
        break;

      case 'agent-coordination-project-save':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION_WRITE) break;
        void (options.agentCoordinationSource?.saveProject(msg.input) ?? Promise.resolve({
          ok: false,
          error: 'unavailable',
          message: 'Agent coordination is unavailable.',
        } as const)).then((result) => {
          if (authed) {
            send({
              kind: 'agent-coordination-project-save-reply',
              requestId: msg.requestId,
              result,
            });
          }
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-coordination-project-save-reply',
              requestId: msg.requestId,
              result: {
                ok: false,
                error: 'unavailable',
                message: 'Agent coordination request failed.',
              },
            });
          }
        });
        break;

      case 'agent-orchestration-snapshot-get':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION) break;
        send({
          kind: 'agent-orchestration-snapshot',
          requestId: msg.requestId,
          snapshot: options.agentOrchestrationSource?.getSnapshot()
            ?? EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
        });
        break;

      case 'daemon-snapshot-get':
        if (negotiatedProtocol < DAEMON_PROTOCOL_VERSION || !options.daemonSource) break;
        if (remoteDaemonAvailability(options.daemonSource).state !== 'ready') {
          send({
            kind: 'daemon-snapshot',
            requestId: msg.requestId,
            snapshot: null,
            unavailable: true,
          });
          break;
        }
        try {
          send({
            kind: 'daemon-snapshot',
            requestId: msg.requestId,
            snapshot: options.daemonSource.getSnapshot(),
          });
        } catch {
          send({
            kind: 'daemon-snapshot',
            requestId: msg.requestId,
            snapshot: null,
            unavailable: true,
          });
        }
        break;

      case 'daemon-transcript-get':
        if (negotiatedProtocol < DAEMON_PROTOCOL_VERSION || !options.daemonSource) break;
        if (remoteDaemonAvailability(options.daemonSource).state !== 'ready') {
          send({
            kind: 'daemon-transcript',
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            items: [],
            unavailable: true,
          });
          break;
        }
        try {
          send({
            kind: 'daemon-transcript',
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            items: options.daemonSource.readTranscript?.(
              msg.sessionId,
              msg.afterSequence,
              msg.limit,
            ) ?? [],
          });
        } catch {
          send({
            kind: 'daemon-transcript',
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            items: [],
            unavailable: true,
          });
        }
        break;

      case 'daemon-events-subscribe': {
        if (negotiatedProtocol < DAEMON_PROTOCOL_VERSION || !options.daemonSource) break;
        const availability = remoteDaemonAvailability(options.daemonSource);
        if (availability.state !== 'ready') {
          daemonEventsSubscribed = false;
          send({ kind: 'daemon-availability', availability });
          break;
        }
        daemonEventsSubscribed = true;
        try {
          const snapshot = options.daemonSource.getSnapshot();
          if (msg.afterSequence !== snapshot.eventSequence) {
            send({ kind: 'daemon-snapshot', snapshot });
          }
        } catch {
          daemonEventsSubscribed = false;
          send({ kind: 'daemon-snapshot', snapshot: null, unavailable: true });
        }
        break;
      }

      case 'daemon-events-unsubscribe':
        daemonEventsSubscribed = false;
        break;

      case 'daemon-command': {
        if (
          negotiatedProtocol < DAEMON_PROTOCOL_VERSION
          || !options.daemonSource
          || !clientIdentity
        ) break;
        const { requestId } = msg;
        let command: DaemonCommand;
        try {
          command = parseDaemonCommand({
            ...msg.command,
            principal: { kind: 'android', id: clientIdentity.clientId },
          });
        } catch {
          break;
        }
        const availability = remoteDaemonAvailability(options.daemonSource);
        if (availability.state !== 'ready') {
          send({
            kind: 'daemon-command-reply',
            requestId,
            receipt: {
              ok: false,
              status: 'rejected',
              commandId: command.commandId,
              revision: 0,
              error: {
                code: 'internal-error',
                message: 'Structured Agent authority is unavailable in terminal-only safe mode.',
                retryable: false,
                details: { availability },
              },
            },
          });
          break;
        }
        void options.daemonSource.execute(command).then((receipt) => {
          if (authed) send({ kind: 'daemon-command-reply', requestId, receipt });
        }).catch((error: unknown) => {
          if (!authed) return;
          send({
            kind: 'daemon-command-reply',
            requestId,
            receipt: {
              ok: false,
              status: 'rejected',
              commandId: command.commandId,
              revision: options.daemonSource ? daemonRevision(options.daemonSource) : 0,
              error: {
                code: 'internal-error',
                message: error instanceof Error ? error.message : 'Daemon command failed.',
                retryable: false,
              },
            },
          });
        });
        break;
      }

      case 'agent-collaboration-policy-save':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION) break;
        void (options.agentOrchestrationSource?.savePolicy(msg.input) ?? Promise.resolve({
          ok: false,
          error: 'unavailable',
          message: 'Agent orchestration is unavailable.',
        } as const)).then((result) => {
          if (authed) {
            send({
              kind: 'agent-collaboration-policy-save-reply',
              requestId: msg.requestId,
              result,
            });
          }
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-collaboration-policy-save-reply',
              requestId: msg.requestId,
              result: {
                ok: false,
                error: 'unavailable',
                message: 'Agent orchestration request failed.',
              },
            });
          }
        });
        break;

      case 'agent-orchestration-action':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION) break;
        if (msg.action === 'stop-run') {
          void (options.agentOrchestrationSource?.stopRun(msg.runId) ?? Promise.resolve({
            ok: false,
            error: 'unavailable',
            message: 'Agent orchestration is unavailable.',
          } as const)).then((result) => {
            if (authed) send({
              kind: 'agent-orchestration-action-reply',
              requestId: msg.requestId,
              action: 'stop-run',
              result,
            });
          });
          break;
        }
        {
          const taskId = msg.taskId;
          if (!taskId) break;
          const action: 'cancel-worker' | 'archive-worker' = msg.action === 'cancel-worker'
            ? 'cancel-worker'
            : 'archive-worker';
          const operation = action === 'cancel-worker'
            ? options.agentOrchestrationSource?.cancelWorker(msg.runId, taskId)
            : options.agentOrchestrationSource?.archiveWorker(msg.runId, taskId);
          void (operation ?? Promise.resolve({
            ok: false,
            error: 'unavailable',
            message: 'Agent orchestration is unavailable.',
          } as const)).then((result) => {
            if (authed) send({
              kind: 'agent-orchestration-action-reply',
              requestId: msg.requestId,
              action,
              result,
            });
          });
        }
        break;

      case 'agent-legacy-migration-confirm':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_ORCHESTRATION) break;
        void (options.agentOrchestrationSource?.confirmLegacyMigration()
          ?? Promise.reject(new Error('Agent orchestration is unavailable.'))).then((value) => {
          if (authed) send({
            kind: 'agent-legacy-migration-confirm-reply',
            requestId: msg.requestId,
            result: { ok: true, value },
          });
        }).catch((error: unknown) => {
          if (authed) send({
            kind: 'agent-legacy-migration-confirm-reply',
            requestId: msg.requestId,
            result: {
              ok: false,
              error: 'unavailable',
              message: error instanceof Error ? error.message : 'Legacy Team migration failed.',
            },
          });
        });
        break;

      case 'agent-seen':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        send({
          kind: 'agent-seen-reply',
          requestId: msg.requestId,
          marked: options.agentCoordinationSource?.markSeen(msg.activityId, msg.stateSeq) === true,
        });
        break;

      case 'managed-merge-decision':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_COORDINATION) break;
        void (options.agentCoordinationSource?.decideManagedMerge({
          requestId: msg.mergeRequestId,
          revision: msg.revision,
          decision: msg.decision,
          actor: 'mobile',
          ...(msg.overrideReason ? { overrideReason: msg.overrideReason } : {}),
        }) ?? Promise.resolve({
          ok: false as const,
          error: 'unavailable' as const,
          message: 'Managed merge is unavailable.',
        })).then((result) => send({
          kind: 'managed-merge-decision-reply',
          requestId: msg.requestId,
          result: remoteMergeDecisionResult(result),
        }));
        break;

      case 'agent-followup':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        void (options.agentSource?.sendFollowup(msg.activityId, msg.text) ?? Promise.resolve({
            ok: false,
            error: 'delivery-failed',
          } as const)).then((result) => send({
            kind: 'agent-followup-reply',
            requestId: msg.requestId,
            result,
          }));
        break;

      case 'agent-decision':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        send({
          kind: 'agent-decision-reply',
          requestId: msg.requestId,
          result: options.agentSource?.decideApproval(msg.activityId, msg.approvalId, msg.decision) ?? {
            ok: false,
            error: 'not-found',
          },
        });
        break;

      case 'agent-projects-list':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        void (options.agentHistorySource?.listProjects(
          msg.force === true,
          msg.cursor,
          msg.limit,
          negotiatedProtocol >= REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS ? msg.query : undefined,
        ) ?? Promise.resolve({ items: [], nextCursor: null })).then((result) => {
          if (authed) send({ kind: 'agent-projects-list-reply', requestId: msg.requestId, result });
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-projects-list-reply',
              requestId: msg.requestId,
              result: { items: [], nextCursor: null },
            });
          }
        });
        break;

      case 'agent-project-save':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        void (options.agentHistorySource?.saveProject?.(msg.input)
          ?? Promise.resolve({ ok: false, reason: 'invalid' } as const))
          .then((result) => {
            if (authed) send({ kind: 'agent-project-save-reply', requestId: msg.requestId, result });
          })
          .catch(() => {
            if (authed) {
              send({
                kind: 'agent-project-save-reply',
                requestId: msg.requestId,
                result: { ok: false, reason: 'invalid' },
              });
            }
          });
        break;

      case 'agent-project-remove':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        void (options.agentHistorySource?.removeProject?.(msg.projectId) ?? Promise.resolve(false))
          .then((removed) => {
            if (authed) send({ kind: 'agent-project-remove-reply', requestId: msg.requestId, removed });
          })
          .catch(() => {
            if (authed) send({ kind: 'agent-project-remove-reply', requestId: msg.requestId, removed: false });
          });
        break;

      case 'agent-project-launchers':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        send({
          kind: 'agent-project-launchers-reply',
          requestId: msg.requestId,
          result: options.agentHistorySource?.listLaunchers?.() ?? [],
        });
        break;

      case 'agent-project-prepare-launch':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        void (options.agentHistorySource?.prepareProjectLaunch?.(msg.projectId, msg.launcherId)
          ?? options.agentHistorySource?.prepareLaunch?.(
            { kind: 'project', projectId: msg.projectId },
            msg.launcherId,
          ).then((preparation): AgentProjectLaunchPreparation => preparation.ok
            ? {
                ok: true,
                projectId: msg.projectId,
                launcherId: preparation.launcherId,
                provider: preparation.provider,
                name: preparation.name,
                cwd: preparation.cwd,
                roots: preparation.roots,
                revision: preparation.revision,
              }
            : preparation)
          ?? Promise.resolve({ ok: false, reason: 'unavailable' } as const))
          .then((result) => {
            if (authed) {
              send({
                kind: 'agent-project-prepare-launch-reply',
                requestId: msg.requestId,
                result,
              });
            }
          })
          .catch(() => {
            if (authed) {
              send({
                kind: 'agent-project-prepare-launch-reply',
                requestId: msg.requestId,
                result: { ok: false, reason: 'unavailable' },
              });
            }
          });
        break;

      case 'agent-project-start-launch': {
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_PROJECTS) break;
        const source = options.agentHistorySource;
        if (!source?.resolveLaunch) {
          send({
            kind: 'agent-project-start-launch-reply',
            requestId: msg.requestId,
            result: { ok: false, reason: 'unavailable' },
          });
          break;
        }
        void source.resolveLaunch(
          { kind: 'project', projectId: msg.request.projectId },
          msg.request.launcherId,
          msg.request.revision,
        ).then((resolved) => {
          if (!authed) return;
          if (!resolved.ok) {
            send({
              kind: 'agent-project-start-launch-reply',
              requestId: msg.requestId,
              result: resolved,
            });
            return;
          }
          if (!sessionMatchesPrimaryRoot(msg.request.sessionId, resolved.roots)) {
            send({
              kind: 'agent-project-start-launch-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'session-mismatch' },
            });
            return;
          }
          const installed = installPrivateRun(
            msg.request.sessionId,
            msg.request.runId,
            resolved.commandText,
            resolved.displayCommandText,
            () => send({
              kind: 'agent-project-start-launch-reply',
              requestId: msg.requestId,
              result: { ok: true },
            }),
          );
          if (!installed) {
            send({
              kind: 'agent-project-start-launch-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
            return;
          }
          void source.recordLaunchTargetWork(
            { kind: 'project', projectId: msg.request.projectId },
            resolved.roots,
            Date.now(),
          ).catch(() => undefined);
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-project-start-launch-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
          }
        });
        break;
      }

      case 'agent-launch-prepare':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        void (options.agentHistorySource?.prepareLaunch?.(msg.target, msg.launcherId)
          ?? Promise.resolve({ ok: false, reason: 'unavailable' } as const))
          .then((result) => {
            if (authed) {
              send({
                kind: 'agent-launch-prepare-reply',
                requestId: msg.requestId,
                result,
              });
            }
          })
          .catch(() => {
            if (authed) {
              send({
                kind: 'agent-launch-prepare-reply',
                requestId: msg.requestId,
                result: { ok: false, reason: 'unavailable' },
              });
            }
          });
        break;

      case 'agent-launch-start': {
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LAUNCH_TARGETS) break;
        const source = options.agentHistorySource;
        if (!source?.resolveLaunch) {
          send({
            kind: 'agent-launch-start-reply',
            requestId: msg.requestId,
            result: { ok: false, reason: 'unavailable' },
          });
          break;
        }
        void source.resolveLaunch(
          msg.request.target,
          msg.request.launcherId,
          msg.request.revision,
        ).then((resolved) => {
          if (!authed) return;
          if (!resolved.ok) {
            send({
              kind: 'agent-launch-start-reply',
              requestId: msg.requestId,
              result: resolved,
            });
            return;
          }
          if (!sessionMatchesPrimaryRoot(msg.request.sessionId, resolved.roots)) {
            send({
              kind: 'agent-launch-start-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'session-mismatch' },
            });
            return;
          }
          const installed = installPrivateRun(
            msg.request.sessionId,
            msg.request.runId,
            resolved.commandText,
            resolved.displayCommandText,
            () => send({
              kind: 'agent-launch-start-reply',
              requestId: msg.requestId,
              result: { ok: true },
            }),
          );
          if (!installed) {
            send({
              kind: 'agent-launch-start-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
            return;
          }
          void source.recordLaunchTargetWork(
            msg.request.target,
            resolved.roots,
            Date.now(),
          ).catch(() => undefined);
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-launch-start-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
          }
        });
        break;
      }

      case 'agent-history-sessions':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        void (options.agentHistorySource?.listSessions(
          msg.projectId,
          msg.cursor,
          msg.limit,
          msg.force === true,
        ) ?? Promise.resolve({ items: [], nextCursor: null })).then((result) => {
          if (authed) send({ kind: 'agent-history-sessions-reply', requestId: msg.requestId, result });
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-history-sessions-reply',
              requestId: msg.requestId,
              result: { items: [], nextCursor: null },
            });
          }
        });
        break;

      case 'agent-history-read':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        void (options.agentHistorySource?.readTranscript(
          msg.historyId,
          msg.cursor,
          msg.limit,
        ) ?? Promise.resolve(null)).then((result) => {
          if (authed) send({ kind: 'agent-history-read-reply', requestId: msg.requestId, result });
        }).catch(() => {
          if (authed) send({ kind: 'agent-history-read-reply', requestId: msg.requestId, result: null });
        });
        break;

      case 'agent-history-prepare-resume':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        void (options.agentHistorySource?.prepareResume(msg.historyId) ?? Promise.resolve(null))
          .then((result) => {
            if (authed) {
              send({
                kind: 'agent-history-prepare-resume-reply',
                requestId: msg.requestId,
                result,
              });
            }
          })
          .catch(() => {
            if (authed) {
              send({
                kind: 'agent-history-prepare-resume-reply',
                requestId: msg.requestId,
                result: null,
              });
            }
          });
        break;

      case 'agent-history-start-resume': {
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_HISTORY) break;
        const source = options.agentHistorySource;
        if (!source) {
          send({
            kind: 'agent-history-start-resume-reply',
            requestId: msg.requestId,
            result: { ok: false, reason: 'unavailable' },
          });
          break;
        }
        void source.resolveResume(
          msg.request.historyId,
          msg.request.revision,
          msg.request.rootChoice,
        ).then((resolved) => {
          if (!authed) return;
          if (!resolved.ok) {
            send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: resolved,
            });
            return;
          }
          if (resolved.roots.length === 0) {
            send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'missing-root' },
            });
            return;
          }
          if (!sessionMatchesPrimaryRoot(msg.request.sessionId, resolved.roots)) {
            send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'session-mismatch' },
            });
            return;
          }
          const installed = installPrivateRun(
            msg.request.sessionId,
            msg.request.runId,
            resolved.commandText,
            resolved.displayCommandText,
            () => send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: { ok: true },
            }),
          );
          if (!installed) {
            send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
            return;
          }
          void source.recordResumeWork(msg.request.historyId, Date.now()).catch(() => undefined);
        }).catch(() => {
          if (authed) {
            send({
              kind: 'agent-history-start-resume-reply',
              requestId: msg.requestId,
              result: { ok: false, reason: 'unavailable' },
            });
          }
        });
        break;
      }

      // Echoed from the message loop rather than the socket layer, so what the
      // client measures is the path its real requests take.
      case 'ping':
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        send({ kind: 'pong', probeId: msg.probeId, sentAt: msg.sentAt });
        break;

      case 'git-status': {
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        const { requestId, directory } = msg;
        if (pendingGitRequests.has(requestId)) {
          send({
            kind: 'git-status-reply',
            requestId,
            status: UNAVAILABLE_GIT_DIRECTORY_STATUS,
          });
          break;
        }
        if (pendingGitRequests.size >= MAX_REMOTE_GIT_REQUESTS) {
          send({
            kind: 'git-status-reply',
            requestId,
            status: UNAVAILABLE_GIT_DIRECTORY_STATUS,
          });
          break;
        }
        const controller = new AbortController();
        pendingGitRequests.set(requestId, controller);
        void (async () => {
          let status: GitDirectoryStatus;
          try {
            status = options.gitSource
              ? await options.gitSource.getStatus(directory, controller.signal)
              : UNAVAILABLE_GIT_DIRECTORY_STATUS;
          } catch {
            status = UNAVAILABLE_GIT_DIRECTORY_STATUS;
          }
          if (
            authed
            && !controller.signal.aborted
            && pendingGitRequests.get(requestId) === controller
          ) send({ kind: 'git-status-reply', requestId, status });
          if (pendingGitRequests.get(requestId) === controller) {
            pendingGitRequests.delete(requestId);
          }
        })();
        break;
      }

      case 'git-diff': {
        if (negotiatedProtocol < REMOTE_PROTOCOL_VERSION_AGENT_LIVE) break;
        const { requestId, directory } = msg;
        const failed: GitDiffResult = { ok: false, error: 'git-failed' };
        if (pendingGitRequests.has(requestId)) {
          send({ kind: 'git-diff-reply', requestId, result: failed });
          break;
        }
        if (pendingGitRequests.size >= MAX_REMOTE_GIT_REQUESTS) {
          send({ kind: 'git-diff-reply', requestId, result: failed });
          break;
        }
        const controller = new AbortController();
        pendingGitRequests.set(requestId, controller);
        void (async () => {
          let result: GitDiffResult;
          try {
            result = options.gitSource
              ? await options.gitSource.getDiff(directory, controller.signal)
              : failed;
          } catch {
            result = failed;
          }
          if (
            authed
            && !controller.signal.aborted
            && pendingGitRequests.get(requestId) === controller
          ) send({ kind: 'git-diff-reply', requestId, result });
          if (pendingGitRequests.get(requestId) === controller) {
            pendingGitRequests.delete(requestId);
          }
        })();
        break;
      }

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
        if (pendingUploadBegins.has(requestId)) {
          send({
            kind: 'file-upload-begin-reply',
            requestId,
            ok: false,
            error: 'duplicate file upload request id',
          });
          break;
        }
        if (fileUploads.size + pendingUploadBegins.size >= MAX_REMOTE_FILE_UPLOADS) {
          send({
            kind: 'file-upload-begin-reply',
            requestId,
            ok: false,
            error: 'too many active uploads',
          });
          break;
        }
        // Reserve before beginUpload's first await so a burst cannot open more
        // FileHandles than this connection's budget.
        pendingUploadBegins.add(requestId);
        const beginOperation = (async (): Promise<void> => {
          try {
            const result = await fileSource.beginUpload(msg.dirPath, msg.name, msg.size);
            if (!result.ok) {
              send({ kind: 'file-upload-begin-reply', requestId, ok: false, error: result.error });
              return;
            }
            if (connectionClosed) {
              // beginUpload may finish after close teardown enumerated the
              // tracked ids. Abort this late fd/.ezpart directly instead of
              // leaving it for FileService's idle sweep.
              try {
                await fileSource.abortUpload(result.uploadId);
              } catch {
                // The connection drain still settles and contains source errors.
              }
              return;
            }
            if (fileUploads.has(result.uploadId)) {
              try {
                await fileSource.abortUpload(result.uploadId);
              } catch {
                // Duplicate source identifiers are terminal and contained.
              }
              send({
                kind: 'file-upload-begin-reply',
                requestId,
                ok: false,
                error: 'duplicate upload id',
              });
              return;
            }
            fileUploads.set(result.uploadId, {
              acceptingMessages: true,
              chunkInFlight: false,
              terminalKind: 'none',
              operationTail: Promise.resolve(),
            });
            send({
              kind: 'file-upload-begin-reply',
              requestId,
              ok: true,
              uploadId: result.uploadId,
              finalName: result.finalName,
            });
          } catch {
            send({ kind: 'file-upload-begin-reply', requestId, ok: false, error: 'file upload failed' });
          } finally {
            pendingUploadBegins.delete(requestId);
          }
        })();
        pendingUploadBeginOperations.add(beginOperation);
        void beginOperation.then(() => pendingUploadBeginOperations.delete(beginOperation));
        break;
      }

      case 'file-upload-chunk': {
        const fileSource = options.fileSource;
        if (!fileSource) break;
        const { uploadId, offset } = msg;
        const record = fileUploads.get(uploadId);
        // Ownership is checked before decode and before every abort path: a
        // guessed id from another socket can never mutate a global upload.
        if (!record || !record.acceptingMessages) {
          send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'unknown uploadId' });
          break;
        }
        // Uploads are ACK-paced. Reject before decoding when a chunk is
        // already in source I/O so payloads cannot accumulate in closures.
        if (record.chunkInFlight) {
          queueFileUploadAbort(uploadId, record, () => {
            send({
              kind: 'file-upload-ack',
              uploadId,
              ok: false,
              error: 'upload chunk already in flight',
            });
          });
          break;
        }
        record.chunkInFlight = true;
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8Array(msg.data);
        } catch {
          queueFileUploadAbort(uploadId, record, () => {
            send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'malformed chunk' });
          });
          break;
        }
        // Hard cap regardless of what the client claims — never trust size alone.
        if (bytes.length > FILE_CHUNK_BYTES * 2) {
          queueFileUploadAbort(uploadId, record, () => {
            send({
              kind: 'file-upload-ack',
              uploadId,
              ok: false,
              error: 'chunk exceeds the wire chunk limit',
            });
          });
          break;
        }
        const write = record.operationTail.then(async () => {
          if (
            connectionClosed
            || fileUploads.get(uploadId) !== record
            || record.terminalKind !== 'none'
          ) {
            return;
          }
          let result: Awaited<ReturnType<RemoteFileSource['writeUploadChunk']>>;
          try {
            result = await fileSource.writeUploadChunk(uploadId, offset, bytes);
          } catch {
            result = { ok: false, error: 'file upload failed' };
          }
          if (
            connectionClosed
            || fileUploads.get(uploadId) !== record
            || record.terminalKind !== 'none'
          ) {
            return;
          }
          if (!result.ok) {
            queueFileUploadAbort(uploadId, record, () => {
              send({ kind: 'file-upload-ack', uploadId, ok: false, error: result.error });
            });
            return;
          }
          record.chunkInFlight = false;
          send({ kind: 'file-upload-ack', uploadId, ok: true, receivedBytes: result.receivedBytes });
        });
        record.operationTail = write.then(() => undefined, () => undefined);
        break;
      }

      case 'file-upload-commit': {
        const fileSource = options.fileSource;
        if (!fileSource) break;
        const { uploadId } = msg;
        const record = fileUploads.get(uploadId);
        if (!record || !record.acceptingMessages) {
          send({ kind: 'file-upload-done', uploadId, ok: false, error: 'unknown uploadId' });
          break;
        }
        if (record.chunkInFlight) {
          queueFileUploadAbort(uploadId, record, () => {
            send({
              kind: 'file-upload-done',
              uploadId,
              ok: false,
              error: 'upload chunk is still in flight',
            });
          });
          break;
        }
        // Terminal reservation is synchronous, but chunks already accepted on
        // operationTail finish before the commit.
        record.acceptingMessages = false;
        record.terminalKind = 'commit';
        const commit = record.operationTail.then(async () => {
          if (
            connectionClosed
            || fileUploads.get(uploadId) !== record
            || record.terminalKind !== 'commit'
          ) {
            return;
          }
          let result: Awaited<ReturnType<RemoteFileSource['commitUpload']>>;
          try {
            result = await fileSource.commitUpload(uploadId);
          } catch {
            result = { ok: false, error: 'file upload failed' };
          }
          if (
            connectionClosed
            || fileUploads.get(uploadId) !== record
            || record.terminalKind !== 'commit'
          ) {
            return;
          }
          if (!result.ok) {
            queueFileUploadAbort(uploadId, record, () => {
              send({ kind: 'file-upload-done', uploadId, ok: false, error: result.error });
            });
            return;
          }
          fileUploads.delete(uploadId);
          send({ kind: 'file-upload-done', uploadId, ok: true, finalName: result.finalName });
        });
        record.operationTail = commit.then(() => undefined, () => undefined);
        break;
      }

      case 'file-upload-abort': {
        const fileSource = options.fileSource;
        if (!fileSource) break;
        const record = fileUploads.get(msg.uploadId);
        if (!record || !record.acceptingMessages) break;
        queueFileUploadAbort(msg.uploadId, record);
        break;
      }

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
        openclawControlUnsub = options.openclawSource.subscribeControl((control) => {
          send({ kind: 'openclaw-control', control });
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
              result: {
                accepted: false,
                issue: {
                  code: 'supervisor-failed',
                  detail: err instanceof Error ? err.message : String(err),
                  remediation: 'Retry the requested OpenClaw action.',
                  diagnosticId: `remote-${Date.now().toString(36)}`,
                },
              },
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
  const runInitiators = initiatorsFor(options);
  const connectionOptions = { ...options, runLeases, runInitiators };
  const uploadDrains = new Set<Promise<void>>();
  const wss = new WebSocketServer({
    port: options.port,
    host: options.bindHost ?? '0.0.0.0',
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
  wss.on('connection', (ws, request) => {
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
    let resolveConnectionUploadDrain!: () => void;
    const connectionUploadDrain = new Promise<void>((resolve) => {
      resolveConnectionUploadDrain = resolve;
    });
    // Register before attach/close can race the server's close callback.
    uploadDrains.add(connectionUploadDrain);
    void connectionUploadDrain.then(() => uploadDrains.delete(connectionUploadDrain));
    attachConnection(ws as unknown as RemoteWs, connectionOptions, {
      onAuthenticated: () => clearTimeout(authTimer),
      onUploadDrain: (drain) => {
        void drain.then(resolveConnectionUploadDrain, resolveConnectionUploadDrain);
      },
      localAddress: normalizeSocketAddress(request.socket.localAddress),
      peerAddress: normalizeSocketAddress(request.socket.remoteAddress),
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
          void Promise.all([...uploadDrains]).then(() => {
            runLeases.dispose();
            // `runInitiators` deliberately survives stop(): initiator identity
            // has the RUN's lifetime (registry doc) and the broker-scoped
            // registry serves later bridge generations, so a remote toggle
            // off/on cannot demote an install's own still-active run to
            // viewing-only on resume. Its run-lifecycle subscriptions keep
            // cleanup exact without any bridge-lifetime wipe.
            if (err) console.error('[remote-bridge] error closing WebSocketServer:', err);
            resolve();
          });
        });
      });
      return stopPromise;
    },
  };
}
