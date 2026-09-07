import { isAgentLaunchModel } from '../shared/agent-history';

import { MAX_GUARDED_DESTROY_RUN_IDS, type RendererControl } from '../shared/ipc';
import {
  MAX_DESKTOP_VIEWPORT_PIXELS,
  MIN_DESKTOP_VIEWPORT_PIXELS,
  type ClientToServerMessage,
  type DesktopNormalizedRegion,
  type DesktopQualityPreference,
  type DesktopVideoViewport,
  type DesktopSessionSignal,
  type RemoteClientIdentity,
} from '../shared/remote-protocol';
import { parseDaemonCommand } from '../shared/daemon-protocol';

import {
  isSessionSurfaceCloseDecisions,
  isSessionSurfaceCloseEntries,
  isSessionSurfaceId,
  isSessionSurfaceIntent,
} from '../shared/session-surface';

import type { AgentLaunchTarget } from '../shared/agent-history';

/** Bounded validation before any authenticated control-plane dispatch. */
export type UnknownRecord = Record<string, unknown>;

export type WorktreeDispatchMessage = {
  readonly kind: 'worktree-request';
  readonly requestId: string;
  readonly request?: unknown;
};

export type FileReadDispatchMessage = {
  readonly kind: 'file-read';
  readonly requestId?: unknown;
  readonly path?: unknown;
  readonly mode?: unknown;
  readonly terminalCapability?: unknown;
};

export type DispatchableClientMessage =
  | Exclude<ClientToServerMessage, { readonly kind: 'worktree-request' | 'file-read'; }>
  | WorktreeDispatchMessage
  | FileReadDispatchMessage;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

export function isRemoteAgentLaunchTarget(value: unknown): value is AgentLaunchTarget {
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

export const MAX_GUARDED_DESTROY_ID_LENGTH = 256;

export const MAX_DESKTOP_SDP_BYTES = 256 * 1024;

export const MAX_DESKTOP_ICE_BYTES = 8 * 1024;

export function isGuardedDestroyId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_GUARDED_DESTROY_ID_LENGTH
  );
}

export function isGuardedDestroyRequest(value: UnknownRecord): boolean {
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

export function isRemoteClientIdentity(value: unknown): value is RemoteClientIdentity {
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

export function isDesktopSignal(value: unknown): value is DesktopSessionSignal {
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

export function isDesktopVideoViewport(value: unknown): value is DesktopVideoViewport {
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

export function isDesktopNormalizedRegion(value: unknown): value is DesktopNormalizedRegion {
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

export function isDesktopQualityPreference(value: unknown): value is DesktopQualityPreference {
  return value === 'balanced' || value === 'clarity' || value === 'responsiveness';
}

export function isRendererControl(value: unknown): value is RendererControl {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'cancel':
    case 'close':
    case 'detach':
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

export function isTerminalFileLocationRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.cwd === 'string' &&
    (value.executionKind === 'local' || value.executionKind === 'ssh') &&
    isOptionalNumber(value.line) &&
    isOptionalNumber(value.column)
  );
}

export function isDispatchableClientMessage(value: unknown): value is DispatchableClientMessage {
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
        && isAgentLaunchModel(value.launcherId, value.model)
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
        && isAgentLaunchModel(request.launcherId, request.model)
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

export const MAX_REMOTE_REQUEST_ID_LENGTH = 128;

export const MAX_REMOTE_AGENT_ID_LENGTH = 256;

export const MAX_REMOTE_AGENT_TEXT_LENGTH = 8_192;
