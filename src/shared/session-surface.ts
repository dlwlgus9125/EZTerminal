import {
  MAX_GUARDED_DESTROY_RUN_IDS,
  MAX_GUARDED_DESTROY_SESSIONS,
} from './ipc';
import type {
  DestroySessionGuardResult,
  SessionInfo,
} from './ipc';
import {
  isProjectSessionTarget,
  type ProjectSessionTarget,
} from './project-workspace';

export const MAX_SESSION_SURFACE_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSessionSurfaceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_SURFACE_ID_LENGTH;
}

/** One exact UI surface's intent when it binds to an interpreter session. */
export type SessionSurfaceIntent =
  | { readonly kind: 'create'; readonly cwd?: string }
  | { readonly kind: 'create-project'; readonly target: ProjectSessionTarget }
  | { readonly kind: 'adopt'; readonly sessionId: string }
  | { readonly kind: 'restore'; readonly sessionId: string; readonly cwd?: string };

export function isSessionSurfaceIntent(value: unknown): value is SessionSurfaceIntent {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'create-project') return isProjectSessionTarget(value.target);
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false;
  if (value.kind === 'create') return true;
  return (value.kind === 'adopt' || value.kind === 'restore')
    && isSessionSurfaceId(value.sessionId);
}

export type SessionSurfaceRole = 'owner' | 'adopted';

/**
 * Host-issued binding for one mounted view. `surfaceId` is client-minted and
 * idempotent inside one connection/renderer generation; `bindingId` is the
 * unguessable capability required by every later lifecycle mutation.
 */
export interface SessionSurfaceBinding {
  readonly surfaceId: string;
  readonly bindingId: string;
  readonly session: SessionInfo;
  readonly role: SessionSurfaceRole;
}

export type SessionSurfaceFailureReason =
  | 'not-found'
  | 'state-changed'
  | 'unavailable'
  | 'busy'
  | 'forbidden';

export type SessionSurfaceOpenResult =
  | { readonly ok: true; readonly binding: SessionSurfaceBinding }
  | { readonly ok: false; readonly reason: SessionSurfaceFailureReason };

export interface SessionSurfaceCloseEntry {
  readonly bindingId: string;
  readonly expectedActiveRunIds: readonly string[];
}

export function isSessionSurfaceCloseEntries(
  value: unknown,
): value is readonly SessionSurfaceCloseEntry[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_GUARDED_DESTROY_SESSIONS
    && new Set(value.map((entry) => (
      isRecord(entry) ? entry.bindingId : undefined
    ))).size === value.length
    && value.every((entry) => (
      isRecord(entry)
      && isSessionSurfaceId(entry.bindingId)
      && Array.isArray(entry.expectedActiveRunIds)
      && entry.expectedActiveRunIds.length <= MAX_GUARDED_DESTROY_RUN_IDS
      && entry.expectedActiveRunIds.every(isSessionSurfaceId)
    ));
}

export interface PreparedSessionSurfaceCloseItem {
  readonly bindingId: string;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly role: SessionSurfaceRole;
}

export interface PreparedSessionSurfaceClose {
  readonly closeToken: string;
  readonly items: readonly PreparedSessionSurfaceCloseItem[];
}

export type SessionSurfacePrepareCloseResult =
  | { readonly ok: true; readonly prepared: PreparedSessionSurfaceClose }
  | { readonly ok: false; readonly reason: SessionSurfaceFailureReason };

export type SessionSurfaceDisposition = 'terminate' | 'keep';

export interface SessionSurfaceCloseDecision {
  readonly bindingId: string;
  readonly disposition: SessionSurfaceDisposition;
}

export function isSessionSurfaceCloseDecisions(
  value: unknown,
): value is readonly SessionSurfaceCloseDecision[] {
  return Array.isArray(value)
    && value.length <= MAX_GUARDED_DESTROY_SESSIONS
    && new Set(value.map((decision) => (
      isRecord(decision) ? decision.bindingId : undefined
    ))).size === value.length
    && value.every((decision) => (
      isRecord(decision)
      && isSessionSurfaceId(decision.bindingId)
      && (decision.disposition === 'terminate' || decision.disposition === 'keep')
    ));
}

export type SessionSurfaceCommitCloseResult =
  | {
      readonly ok: true;
      readonly keptSessionIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: SessionSurfaceFailureReason };

export type SessionSurfaceReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'state-changed' | 'forbidden' };

/** Transport-neutral surface used by desktop preload and mobile WebSocket. */
export interface SessionSurfaceApi {
  openSessionSurface(
    surfaceId: string,
    intent: SessionSurfaceIntent,
  ): Promise<SessionSurfaceOpenResult>;
  prepareSessionSurfaceClose(
    entries: readonly SessionSurfaceCloseEntry[],
  ): Promise<SessionSurfacePrepareCloseResult>;
  commitSessionSurfaceClose(
    closeToken: string,
    decisions: readonly SessionSurfaceCloseDecision[],
  ): Promise<SessionSurfaceCommitCloseResult>;
  /** Unexpected-unmount cleanup only. It always leaves the session alive. */
  releaseSessionSurface(bindingId: string): Promise<SessionSurfaceReleaseResult>;
  /** Explicit session-manager action; it intentionally bypasses view ownership. */
  terminateSessionGuarded(
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ): Promise<DestroySessionGuardResult>;
}
