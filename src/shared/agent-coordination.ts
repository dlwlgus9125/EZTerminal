import type { AgentActivity, AgentProvider, AgentState } from './agent';

export const AGENT_COORDINATION_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_PARTICIPANTS = 32;
export const MAX_AGENT_VALIDATIONS = 8;
export const MAX_AGENT_PROMPT_BYTES = 32 * 1024;
export const MAX_AGENT_READ_LINES = 200;
export const MAX_AGENT_READ_BYTES = 64 * 1024;
export const MAX_AGENT_AUDIT_RECORDS = 500;

/**
 * Structured Agent prompts become terminal input, so they must never contain
 * terminal control bytes that could close bracketed paste or inject an escape
 * sequence. Newline, carriage return, and tab remain valid prompt content.
 */
export function isSafeAgentPromptText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (new TextEncoder().encode(value).byteLength > MAX_AGENT_PROMPT_BYTES) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return false;
    }
  }
  return true;
}

export interface AgentValidationCommand {
  readonly id: string;
  readonly name: string;
  /** EZTerminal command text, copied into a request at creation time. */
  readonly command: string;
  readonly timeoutMs: number;
}

export interface AgentParticipant {
  readonly participantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly worktreeId?: string;
  readonly alias: string;
  readonly role: string;
  readonly task: string;
  readonly provider: AgentProvider;
  readonly joined: boolean;
  readonly joinedAt: number;
  readonly updatedAt: number;
}

export interface AgentProjectCoordination {
  readonly projectId: string;
  readonly goal: string;
  readonly defaultTargetBranch: string;
  readonly validationCommands: readonly AgentValidationCommand[];
  readonly configRevision: number;
  readonly participants: readonly AgentParticipant[];
  readonly updatedAt: number;
}

export interface AgentProjectCoordinationInput {
  readonly projectId: string;
  readonly goal: string;
  readonly defaultTargetBranch: string;
  readonly validationCommands: readonly AgentValidationCommand[];
  readonly expectedRevision?: number;
}

export interface AgentParticipantInput {
  readonly activityId: string;
  readonly alias: string;
  readonly role: string;
  readonly task: string;
  readonly expectedProjectRevision?: number;
}

export type ManagedMergeState =
  | 'preparing'
  | 'validating'
  | 'approval-required'
  | 'override-required'
  | 'merging'
  | 'merged'
  | 'denied'
  | 'conflict'
  | 'stale'
  | 'failed'
  | 'interrupted'
  | 'already-integrated';

export interface ManagedMergeValidation {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'running' | 'passed' | 'failed' | 'timed-out' | 'cancelled';
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  /** Transient bounded tail. Never written to the coordination store. */
  readonly outputTail?: string;
  readonly outputTruncated?: boolean;
}

export interface ManagedMergeRequest {
  readonly requestId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly participantId: string;
  readonly activityId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceBranch: string;
  readonly sourceHead: string;
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly candidateHead?: string;
  readonly state: ManagedMergeState;
  readonly validationConfigRevision: number;
  readonly validations: readonly ManagedMergeValidation[];
  readonly conflictFiles?: readonly string[];
  readonly warning?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}

export interface AgentProjectRollup {
  readonly projectId: string;
  readonly goal: string;
  readonly defaultTargetBranch: string;
  readonly validationCommands: readonly AgentValidationCommand[];
  readonly configRevision: number;
  readonly counts: Readonly<Record<AgentState, number>>;
  readonly participants: readonly AgentParticipant[];
  readonly pendingMergeCount: number;
}

/** Revisioned desktop/mobile/CLI projection. It contains no terminal text. */
export interface AgentCoordinationSnapshot {
  readonly revision: number;
  readonly activityRevision: number;
  readonly activities: readonly AgentActivity[];
  readonly projects: readonly AgentProjectRollup[];
  readonly mergeRequests: readonly ManagedMergeRequest[];
}

export const EMPTY_AGENT_COORDINATION_SNAPSHOT: AgentCoordinationSnapshot = Object.freeze({
  revision: 0,
  activityRevision: 0,
  activities: Object.freeze([]),
  projects: Object.freeze([]),
  mergeRequests: Object.freeze([]),
});

export type AgentCoordinationMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: 'invalid' | 'not-found' | 'stale' | 'conflict' | 'unavailable'; readonly message: string };

export interface ManagedMergeRequestInput {
  readonly targetBranch: string;
}

export interface ManagedMergeDecisionInput {
  readonly requestId: string;
  readonly revision: number;
  readonly decision: 'approve' | 'deny';
  readonly actor: 'desktop' | 'mobile';
  readonly overrideReason?: string;
}

export interface ManagedMergeGrantInput {
  readonly participantId: string;
  readonly sourceWorkspaceId: string;
  readonly targetBranch: string;
  readonly durationMs: 900000 | 3600000 | 14400000;
}

export interface ManagedMergeAuditRecord {
  readonly auditId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly participantId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceBranch: string;
  readonly sourceHead: string;
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly candidateHead?: string;
  readonly validations: readonly {
    readonly name: string;
    readonly status: ManagedMergeValidation['status'];
    readonly durationMs?: number;
    readonly exitCode?: number;
    readonly digest?: string;
  }[];
  readonly decisionActor?: 'desktop' | 'mobile' | 'grant';
  readonly outcome: ManagedMergeState;
  readonly overrideReason?: string;
  readonly createdAt: number;
  readonly finishedAt: number;
}

/** Remove the transient validation tail before projecting a request remotely or into shared state. */
export function withoutManagedMergeOutput(request: ManagedMergeRequest): ManagedMergeRequest {
  return {
    ...request,
    validations: request.validations.map((validation) => ({
      id: validation.id,
      name: validation.name,
      status: validation.status,
      ...(validation.startedAt === undefined ? {} : { startedAt: validation.startedAt }),
      ...(validation.finishedAt === undefined ? {} : { finishedAt: validation.finishedAt }),
      ...(validation.durationMs === undefined ? {} : { durationMs: validation.durationMs }),
      ...(validation.exitCode === undefined ? {} : { exitCode: validation.exitCode }),
      ...(validation.outputTruncated === undefined ? {} : { outputTruncated: validation.outputTruncated }),
    })),
  };
}

const FORBIDDEN_BRANCH_CHARACTERS = new Set(['~', '^', ':', '?', '*', '\\', '[']);

function hasForbiddenBranchCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || FORBIDDEN_BRANCH_CHARACTERS.has(character)) {
      return true;
    }
  }
  return false;
}

export function isSafeLocalBranch(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value !== '@'
    && !hasForbiddenBranchCharacter(value)
    && !value.includes('..')
    && !value.includes('@{')
    && !value.includes('//')
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && value.split('/').every((component) => (
      component.length > 0
      && !component.startsWith('.')
      && !component.endsWith('.lock')
    ));
}
