/** Wire validation, transport types, and the stable virtual-port adapter. */
import { type InterpreterFrame, type RendererControl } from '../../../src/shared/ipc';
import { DOWNLOAD_MAX_FILE_BYTES, FILE_CHUNK_BYTES, TEXT_VIEW_MAX_BYTES } from '../../../src/shared/files';
import {
  IMAGE_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_DIMENSION,
  IMAGE_PREVIEW_MAX_PIXELS,
  type FilePreviewStreamMetadata,
} from '../../../src/shared/file-preview';

import {
  MAX_AGENT_PROVIDER_LABEL_LENGTH,
  type AgentActivitySnapshot,
  type AgentDecision,
  type AgentDecisionResult,
  type AgentFollowupResult,
} from '../../../src/shared/agent';
import {
  type AgentCoordinationMutationResult,
  type AgentCoordinationSnapshot,
  type AgentProjectCoordination,
  type ManagedMergeRequest,
} from '../../../src/shared/agent-coordination';
import {
  AgentOrchestrationSnapshotSchema,
  type AgentOrchestrationMutationResult,
  type AgentOrchestrationSnapshot,
} from '../../../src/shared/agent-orchestration';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonEventContinuity,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../../../src/shared/daemon-protocol';
import type { RemoteDaemonAuthorityAvailability } from '../../../src/shared/daemon-authority';

import { type GitDiffResult, type GitDirectoryStatus } from '../../../src/shared/git-status';
import {
  type BuildInfo,
  type OpenClawChatTicketFailureReason,
  type RemoteClientIdentity,
} from '../../../src/shared/remote-protocol';

import { type QuickCommand } from '../../../src/shared/quick-command';

export type { ConnectionHealthSnapshot, RemoteConnectionState } from './connection-health';

export type DaemonRuntimeSyncStatus = 'loading' | 'ready' | 'recovering' | 'safe-mode' | 'error';

/**
 * Mobile's read model for the daemon runtime. `snapshot` remains available
 * while a reconnect or event-gap recovery is in progress, but callers must
 * treat it as stale unless `status === 'ready'`.
 */
export interface DaemonRuntimeViewState {
  readonly status: DaemonRuntimeSyncStatus;
  readonly snapshot: DaemonSnapshot | null;
  readonly availability?: RemoteDaemonAuthorityAvailability;
  readonly lastContinuity?: DaemonEventContinuity;
  readonly error?: 'connection-lost' | 'invalid-snapshot' | 'event-gap';
}

export type DaemonEventListener = (
  event: DaemonEvent,
  continuity: DaemonEventContinuity,
) => void;

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
export type FileReadResult =
  | {
    readonly ok: true;
    readonly fileSize: number;
    readonly isText: boolean;
    readonly truncated: boolean;
    readonly bytes: Uint8Array;
    readonly preview?: FilePreviewStreamMetadata;
  }
  | { readonly ok: false; readonly error: string; };

export type FileReadMode = 'text' | 'raw' | 'preview';

/** Tracks one in-flight `file-read` request between `file-read-meta` and the
 * last `file-read-chunk` — `buffer` is allocated once `sendBytes` is known
 * (null beforehand, and stays null for a binary file in `'text'` mode, which
 * never streams any chunk). `onProgress` is only used by `downloadFile`. */
export interface FileReadAssembly {
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
export type UploadBeginResult = { ok: true; uploadId: string; finalName: string; } | { ok: false; error: string; };

export type UploadAckResult = { ok: true; receivedBytes: number; } | { ok: false; error: string; };

export type UploadDoneResult = { ok: true; finalName: string; } | { ok: false; error: string; };

/** Reply shape for `getOpenClawChatTicket()` (openclaw-management M4/M5) —
 * mirrors `OpenClawChatTicketReply` on the wire; `ticket`/`token` are `null`
 * when no ticket could be minted (see remote-protocol.ts's doc). */
export type OpenClawChatFailureReason = OpenClawChatTicketFailureReason;

export type OpenClawChatTicket =
  | { readonly ok: true; readonly ticket: string; readonly proxyPort: number; readonly token: string; }
  | { readonly ok: false; readonly reason: OpenClawChatFailureReason; };

export const OPENCLAW_TICKET_TIMEOUT_MS = 20_000;

export const OPENCLAW_CONFIG_TIMEOUT_MS = 25_000;

export const OPENCLAW_LIFECYCLE_TIMEOUT_MS = 40_000;

export function isOpenClawChatFailureReason(value: unknown): value is OpenClawChatFailureReason {
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
  addEventListener(type: 'message', listener: (event: { data: string; }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type CreateSocket = (url: string) => WsLike;

export const DEFAULT_INITIAL_BACKOFF_MS = 500;

export const DEFAULT_MAX_BACKOFF_MS = 8000;

export const WS_OPEN = 1;

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
export const RTT_PROBE_INTERVAL_MS = 5_000;

/** Anything past this is a suspended tab or a clock jump, not a round trip. */
export const RTT_MAX_PLAUSIBLE_MS = 60_000;

export const LIVENESS_IDLE_MS = 45_000;

export const LIVENESS_PROBE_TIMEOUT_MS = 10_000;

export const LIVENESS_CHECK_INTERVAL_MS = 15_000;

export const RESUME_RETRY_INITIAL_MS = 250;

export const RESUME_RETRY_MAX_MS = 4000;

export const RESUME_RETRY_MAX_ATTEMPTS = 5;

export const MAX_GUARDED_DESTROY_ID_LENGTH = 256;

export const MAX_REMOTE_AGENT_ITEMS = 2_048;

export const MAX_REMOTE_AGENT_ID_LENGTH = 256;

export const MAX_REMOTE_AGENT_CWD_LENGTH = 8_192;

export const MAX_REMOTE_AGENT_TOOL_LENGTH = 256;

export const MAX_REMOTE_AGENT_COMMAND_LENGTH = 64 * 1_024;

export const MAX_REMOTE_AGENT_FOLLOWUP_LENGTH = 8_192;

export const MAX_REMOTE_GIT_CHANGES = 2_000;

export const MAX_REMOTE_GIT_OMISSIONS = 2_000;

export const MAX_REMOTE_GIT_PATH_LENGTH = 8_192;

export const MAX_REMOTE_GIT_BRANCH_LENGTH = 1_024;

export const MAX_REMOTE_GIT_DIFF_LENGTH = 200_000;

export const MAX_FILE_CHUNK_BASE64_CHARS = Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 4;

export function maxFileReadBytes(mode: FileReadMode): number {
  if (mode === 'text') return TEXT_VIEW_MAX_BYTES;
  if (mode === 'preview') return IMAGE_PREVIEW_MAX_BYTES;
  return DOWNLOAD_MAX_FILE_BYTES;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const DAEMON_SNAPSHOT_ARRAY_KEYS = [
  'projects',
  'workspaces',
  'sessions',
  'agents',
  'agentRelations',
  'turns',
  'transcriptHeads',
  'approvals',
  'providers',
  'schedules',
  'heartbeats',
] as const;

export const DAEMON_EVENT_KINDS = new Set([
  'entity.upserted',
  'entity.archived',
  'transcript.appended',
  'command.changed',
  'approval.changed',
  'runtime.changed',
  'runtime.recovery',
]);

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function hasDaemonEntityIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const id = typeof value.id === 'string' ? value.id : value.sessionId;
  return typeof id === 'string' && id.length > 0;
}

/** Reject malformed remote state before it can become the UI's authority. */
export function isDaemonSnapshot(value: unknown): value is DaemonSnapshot {
  if (
    !isRecord(value)
    || value.protocolVersion !== DAEMON_PROTOCOL_VERSION
    || !isNonNegativeSafeInteger(value.revision)
    || !isNonNegativeSafeInteger(value.eventSequence)
    || typeof value.generatedAt !== 'string'
    || !isRecord(value.runtime)
    || typeof value.runtime.keepRunning !== 'boolean'
    || typeof value.runtime.startAtLogin !== 'boolean'
    || typeof value.runtime.orchestrationToolsEnabled !== 'boolean'
    || typeof value.runtime.browserEnabled !== 'boolean'
  ) return false;
  for (const key of DAEMON_SNAPSHOT_ARRAY_KEYS) {
    const collection = value[key];
    if (!Array.isArray(collection) || !collection.every(hasDaemonEntityIdentity)) return false;
  }
  return true;
}

export function isDaemonEvent(value: unknown): value is DaemonEvent {
  return isRecord(value)
    && value.protocolVersion === DAEMON_PROTOCOL_VERSION
    && typeof value.eventId === 'string'
    && value.eventId.length > 0
    && isNonNegativeSafeInteger(value.sequence)
    && isNonNegativeSafeInteger(value.revision)
    && typeof value.occurredAt === 'string'
    && typeof value.kind === 'string'
    && DAEMON_EVENT_KINDS.has(value.kind)
    && isRecord(value.payload);
}

export function isDaemonCommandReceipt(
  value: unknown,
  expectedCommandId: string,
): value is DaemonCommandReceipt {
  if (
    !isRecord(value)
    || value.commandId !== expectedCommandId
    || typeof value.ok !== 'boolean'
    || !isNonNegativeSafeInteger(value.revision)
    || typeof value.status !== 'string'
  ) return false;
  if (value.ok) {
    return (value.status === 'applied' || value.status === 'queued' || value.status === 'replayed')
      && isNonNegativeSafeInteger(value.eventSequence);
  }
  return (value.status === 'rejected' || value.status === 'delivery-uncertain')
    && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean';
}

export const DAEMON_TRANSCRIPT_KINDS = new Set([
  'user-message',
  'assistant-message',
  'reasoning',
  'tool-call',
  'tool-result',
  'approval',
  'child-summary',
  'notice',
  'error',
]);

export function isDaemonTranscriptItem(value: unknown, sessionId: string): value is DaemonTranscriptItem {
  return isRecord(value)
    && isBoundedString(value.id, 256)
    && value.sessionId === sessionId
    && isNonNegativeSafeInteger(value.sequence)
    && typeof value.kind === 'string'
    && DAEMON_TRANSCRIPT_KINDS.has(value.kind)
    && typeof value.text === 'string'
    && value.text.length <= 1_048_576
    && typeof value.isDelta === 'boolean'
    && typeof value.isSensitive === 'boolean'
    && (value.turnId === undefined || isBoundedString(value.turnId, 256))
    && (value.relatedSessionId === undefined || isBoundedString(value.relatedSessionId, 256))
    && typeof value.createdAt === 'string';
}

export function isFilePreviewStreamMetadata(value: unknown): value is FilePreviewStreamMetadata {
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

export function isFileReadMetaConsistent(
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

export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
  );
}

export function isRemoteDaemonAuthorityAvailability(
  value: unknown,
): value is RemoteDaemonAuthorityAvailability {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.supportedSchemaVersion)
    || (value.supportedSchemaVersion as number) < 0
    || 'recoveryPath' in value
  ) return false;
  if (value.state === 'ready') {
    return Number.isSafeInteger(value.currentSchemaVersion)
      && (value.currentSchemaVersion as number) >= 0;
  }
  return value.state === 'legacy-only-safe-mode'
    && [
      'backup-failed',
      'database-corrupt',
      'future-schema',
      'initialization-failed',
      'migration-failed',
      'quarantine-failed',
      'unsafe-path',
    ].includes(value.initializationCode as string)
    && ['preserved', 'quarantined', 'partial-quarantine'].includes(
      value.databaseDisposition as string,
    )
    && (value.currentSchemaVersion === undefined
      || (Number.isSafeInteger(value.currentSchemaVersion)
        && (value.currentSchemaVersion as number) >= 0));
}

/**
 * `JSON.parse` does not make a wire payload trustworthy. Keep malformed or
 * unbounded desktop snapshots out of React state instead of relying on a
 * compile-time cast that disappears at runtime.
 */
export function isAgentActivitySnapshot(value: unknown): value is AgentActivitySnapshot {
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

export function isManagedMergeRequest(value: unknown): value is ManagedMergeRequest {
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

export function isAgentCoordinationSnapshot(value: unknown): value is AgentCoordinationSnapshot {
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

export function isManagedMergeMutationResult(
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

export function isAgentProjectCoordination(value: unknown): value is AgentProjectCoordination {
  return isRecord(value)
    && isBoundedString(value.projectId, MAX_REMOTE_AGENT_ID_LENGTH)
    && isBoundedString(value.goal, 2_000)
    && isBoundedString(value.defaultTargetBranch, 200)
    && Array.isArray(value.validationCommands)
    && value.validationCommands.length <= 8
    && value.validationCommands.every((command) => (
      isRecord(command)
      && isBoundedString(command.id, MAX_REMOTE_AGENT_ID_LENGTH)
      && isBoundedString(command.name, 120)
      && isBoundedString(command.command, 8_192)
      && typeof command.timeoutMs === 'number'
      && Number.isFinite(command.timeoutMs)
      && command.timeoutMs >= 1_000
      && command.timeoutMs <= 30 * 60_000
    ))
    && Number.isSafeInteger(value.configRevision)
    && (value.configRevision as number) >= 1
    && Array.isArray(value.participants)
    && value.participants.length <= 32
    && value.participants.every(isAgentParticipantWire)
    && isFiniteTimestamp(value.updatedAt);
}

export function isAgentProjectCoordinationMutationResult(
  value: unknown,
): value is AgentCoordinationMutationResult<AgentProjectCoordination> {
  return isRecord(value) && (
    (value.ok === true && isAgentProjectCoordination(value.value))
    || (
      value.ok === false
      && ['invalid', 'not-found', 'stale', 'conflict', 'unavailable'].includes(String(value.error))
      && isBoundedString(value.message, 1_000, true)
    )
  );
}

export function parseAgentOrchestrationSnapshot(value: unknown): AgentOrchestrationSnapshot | null {
  const parsed = AgentOrchestrationSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface OrchestrationValueSchema<T> {
  safeParse(value: unknown): { success: true; data: T; } | { success: false; };
}

export function parseAgentOrchestrationMutation<T>(
  value: unknown,
  schema: OrchestrationValueSchema<T>,
): AgentOrchestrationMutationResult<T> | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const parsed = schema.safeParse(value.value);
    return parsed.success ? { ok: true, value: parsed.data } : null;
  }
  if (
    value.ok === false
    && ['invalid', 'not-found', 'stale', 'conflict', 'unavailable', 'forbidden'].includes(String(value.error))
    && isBoundedString(value.message, 1_000, true)
  ) {
    return value as AgentOrchestrationMutationResult<T>;
  }
  return null;
}

export function isAgentParticipantWire(value: unknown): boolean {
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

export function isAgentStateCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['starting', 'working', 'blocked', 'done', 'idle', 'error', 'unknown'].every((state) => (
    Number.isSafeInteger(value[state]) && (value[state] as number) >= 0
  ));
}

export function isAgentFollowupResult(value: unknown): value is AgentFollowupResult {
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

export function isAgentDecisionResult(value: unknown): value is AgentDecisionResult {
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

export function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (
    Number.isSafeInteger(value)
    && (value as number) >= 0
  );
}

export function isSafeRelativeGitPath(value: unknown): value is string {
  if (
    !isBoundedString(value, MAX_REMOTE_GIT_PATH_LENGTH)
    || value.includes('\0')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
  ) return false;
  return value.split(/[\\/]/u).every((segment) => segment !== '..');
}

export function isGitDirectoryStatus(value: unknown): value is GitDirectoryStatus {
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

export function isGitDiffResult(value: unknown): value is GitDiffResult {
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

export function isGuardedDestroyId(value: unknown): value is string {
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
  | { readonly ok: true; readonly commands: readonly QuickCommand[]; }
  | { readonly ok: false; readonly error: 'unsupported' | 'offline' | 'unavailable'; };

/**
 * How long a single connection attempt may sit un-authenticated before it is
 * abandoned and retried. Covers BOTH "the socket never opened" (unreachable
 * host — the browser's own TCP timeout can be tens of seconds) AND the nastier
 * "socket opened but `auth-ok` never came and `close` never fired" half-open
 * case (e.g. a VPN link that is mid-handshake), which otherwise stalls the
 * reconnect loop forever because reconnects are only scheduled on `close`.
 */
export const DEFAULT_AUTH_TIMEOUT_MS = 6000;

/** An approval may already have executed when its reply is lost. Keep the
 * exact idempotency key alive across a short reconnect window instead of
 * reporting a false failure. */
export const AGENT_DECISION_RETRY_WINDOW_MS = 60_000;

export interface PendingAgentDecision {
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

export interface RunPortRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly port: FakeMessagePort;
  /** True only for this transport's initiating run, never an attach mirror. */
  readonly initiatedHere: boolean;
}

export interface ResumeRetryState {
  readonly generation: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}
