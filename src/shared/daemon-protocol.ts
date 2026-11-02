import { z } from 'zod';
import { ApprovalResponseSchema, type ApprovalRequest, type ApprovalResponse } from './approval-request';
import { ChatMessageContextSchema, type ChatMessageContext } from './chat-message';
import { isSafeRef } from './git-status';
import { APP_SENT_REASONS, LIMIT_ACTIONS, type AppSentReason, type LimitAction } from './long-run';
import { REVIEW_LIMITS, type ReviewFailureReason } from './review-findings';
import { SuggestedTaskStartSchema, type TranscriptPayload } from './transcript-payload';
import type { SuggestedTaskStart } from './turn-wrap-up';

export const DAEMON_PROTOCOL_VERSION = 12 as const;

export const DAEMON_HARD_LIMITS = Object.freeze({
  concurrentManagedTurns: 4,
  nodesPerTree: 16,
  treeDepth: 4,
  childCreationsPerWindow: 12,
  childCreationWindowMs: 10 * 60 * 1_000,
  /**
   * Subagents a provider starts on its own (Claude Agent tool, Codex sub-agents)
   * are projections, not work the host schedules: their own, larger bounds.
   */
  providerNativeNodesPerTree: 100,
  providerNativeTreeDepth: 8,
});

export type DaemonPrincipalKind = 'desktop' | 'android' | 'cli' | 'mcp' | 'provider';

export interface DaemonPrincipal {
  readonly kind: DaemonPrincipalKind;
  readonly id: string;
  readonly sessionId?: string;
}

export type PermissionPreset = 'plan' | 'standard' | 'full-access';
export type WorkspaceKind = 'local' | 'worktree';
export type SessionKind = 'agent' | 'terminal' | 'diff' | 'browser' | 'script' | 'service';
export type SessionLifecycleState =
  | 'draft'
  | 'starting'
  | 'running'
  | 'idle'
  | 'needs-attention'
  | 'stopping'
  | 'completed'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'failed'
  | 'archived';
export type ManagedAgentState =
  | 'starting'
  | 'queued'
  | 'working'
  | 'blocked'
  | 'idle'
  | 'done'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'error'
  | 'archived';
export type TurnState =
  | 'queued'
  | 'submitting'
  | 'working'
  | 'blocked'
  | 'completed'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'failed';

export interface RevisionedRecord {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DaemonProject extends RevisionedRecord {
  readonly id: string;
  readonly name: string;
  readonly rootPath?: string;
  readonly source: 'native' | 'legacy-import';
  readonly archivedAt?: string;
}

export interface DaemonWorkspace extends RevisionedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly rootPath: string;
  readonly sourceWorkspaceId?: string;
  readonly archivedAt?: string;
}

export interface DaemonSession extends RevisionedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly kind: SessionKind;
  readonly title: string;
  readonly state: SessionLifecycleState;
  readonly source: 'structured' | 'legacy-pty' | 'legacy-import';
  readonly archivedAt?: string;
}

export interface DaemonAgent extends RevisionedRecord {
  readonly sessionId: string;
  readonly providerId: string;
  readonly providerSessionId?: string;
  readonly model?: string;
  /** Provider reasoning effort chosen in the composer (`agent-effort-v1`). */
  readonly reasoningEffort?: string;
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly currentTurnId?: string;
  readonly queuedTurnCount: number;
  readonly orchestrationEnabled: boolean;
}

export interface DaemonAgentRelation extends RevisionedRecord {
  readonly id: string;
  readonly treeId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly owner: 'managed' | 'provider-native';
  readonly depth: number;
  readonly detachedAt?: string;
}

export interface DaemonTurn extends RevisionedRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly commandId: string;
  /** Stable daemon-assigned FIFO position; preserved across lifecycle updates. */
  readonly enqueueSequence?: number;
  readonly state: TurnState;
  readonly providerTurnId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
}

export type TranscriptItemKind =
  | 'user-message'
  | 'assistant-message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'approval'
  | 'child-summary'
  | 'notice'
  | 'error';

export interface DaemonTranscriptItem {
  readonly context?: ChatMessageContext;
  readonly id: string;
  /** Stable opaque provider message identity shared by deltas and completion. */
  readonly messageId?: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind: TranscriptItemKind;
  readonly text: string;
  readonly isDelta: boolean;
  readonly isSensitive: boolean;
  readonly relatedSessionId?: string;
  /** Structured tool/todo/reasoning/plan metadata (`transcript-payload-v1`); `text` stays authoritative. */
  readonly payload?: TranscriptPayload;
  readonly createdAt: string;
}

export interface DaemonTranscriptHead {
  readonly sessionId: string;
  readonly lastSequence: number;
  readonly itemCount: number;
}

export interface DaemonApproval extends RevisionedRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly providerRequestId: string;
  readonly risk: 'read' | 'write' | 'danger';
  readonly title: string;
  readonly detail?: string;
  /** What is being approved (`approval-request-v1`); title/detail remain the legacy summary. */
  readonly request?: ApprovalRequest;
  readonly state: 'pending' | 'allowed' | 'denied' | 'expired';
  readonly resolvedAt?: string;
}

export type ProviderProtocol = 'codex-app-server' | 'claude-agent-sdk' | 'acp' | 'pi-rpc';

export interface DaemonProvider extends RevisionedRecord {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly argv: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly capabilities: readonly string[];
  /** Present for providers enabled through reviewed structured setup. */
  readonly reviewDigest?: string;
  readonly enabled: boolean;
  readonly health: 'unknown' | 'ready' | 'unavailable' | 'incompatible' | 'error';
  readonly healthDetail?: string;
}

export interface DaemonSchedule extends RevisionedRecord {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly maxRuns?: number;
  readonly runCount: number;
  readonly expiresAt?: string;
  readonly nextRunAt?: string;
}

export interface DaemonHeartbeat extends RevisionedRecord {
  readonly sessionId: string;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly nextRunAt?: string;
}

export interface DaemonRuntimeSettings {
  readonly keepRunning: boolean;
  readonly startAtLogin: boolean;
  readonly orchestrationToolsEnabled: boolean;
  readonly browserEnabled: boolean;
}

export interface DaemonSnapshot {
  /** Additive feature negotiation; absent on older hosts. */
  readonly capabilities?: readonly string[];
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly revision: number;
  readonly eventSequence: number;
  readonly generatedAt: string;
  readonly runtime: DaemonRuntimeSettings;
  readonly projects: readonly DaemonProject[];
  readonly workspaces: readonly DaemonWorkspace[];
  readonly sessions: readonly DaemonSession[];
  readonly agents: readonly DaemonAgent[];
  readonly agentRelations: readonly DaemonAgentRelation[];
  readonly turns: readonly DaemonTurn[];
  readonly transcriptHeads: readonly DaemonTranscriptHead[];
  readonly approvals: readonly DaemonApproval[];
  readonly providers: readonly DaemonProvider[];
  readonly schedules: readonly DaemonSchedule[];
  readonly heartbeats: readonly DaemonHeartbeat[];
  /** Provider usage per live agent session id: plan limits last reported for its AI and its own context. */
  readonly agentUsage?: Readonly<Record<string, import('./agent-usage').AgentUsage>>;
  /** Plan limits last reported per provider id, for a conversation that has not started yet. */
  readonly providerUsage?: Readonly<Record<string, import('./agent-usage').AgentUsage>>;
  /** What waits on the person, computed by the host (src/shared/host-attention.ts); absent on older hosts. */
  readonly attention?: import('./host-attention').HostAttention;
  /** Sessions a /btw side question can be asked in now (attached in this host run); never stored. */
  readonly sideQuestionSessionIds?: readonly string[];
  /** Settings queued for each live session's next request (`agent-settings-v2`); host memory, never stored. */
  readonly pendingAgentSettings?: Readonly<Record<string, DaemonPendingAgentSettings>>;
  /** `review-loop-v1`: which AIs can review on this host now, by provider id; host memory, never stored. */
  readonly reviewSupport?: Readonly<Record<string, DaemonReviewSupport>>;
  /** Turn wrap-up: the AI's guess of the person's next message, by session; host memory, never stored. */
  readonly nextPromptSuggestions?: Readonly<Record<string, import('./turn-wrap-up').NextPromptSuggestion>>;
  /** `long-run-v1`: each conversation's open limit, with its place in the line of sends; held by the host beside the store. */
  readonly usageLimits?: Readonly<Record<string, import('./long-run').OpenUsageLimit>>;
  /** `long-run-v1`: messages on their way into a running turn, by session; they have no row until they land. */
  readonly steers?: Readonly<Record<string, readonly import('./long-run').SteeredMessage[]>>;
  /** `long-run-v1`: which AIs run long-run continuity on this host, by provider id; below the measured version it is false. */
  readonly longRunSupport?: Readonly<Record<string, boolean>>;
  /** `in-app-browser-v1`: which AIs get the browser tools on this host, by provider id; below the measured version it is false. */
  readonly browserSupport?: Readonly<Record<string, boolean>>;
}

/** Whether one AI can review now (`review-loop-v1`). */
export interface DaemonReviewSupport {
  /** As a conversation's own AI, in a read-only fork of that conversation (`reviewer.kind: 'self'`). */
  readonly self: boolean;
  /** As another AI's reviewer, in a read-only conversation of its own (`reviewer.kind: 'other'`). */
  readonly reviewer: boolean;
  /** Why not, when either is false. */
  readonly reason?: ReviewFailureReason;
}

/** Who reviews (`review.start`, `review-loop-v1`). */
export type DaemonReviewer =
  /** The conversation's AI in a read-only fork that keeps the conversation (its prompt cache too). */
  | { readonly kind: 'self' }
  /**
   * Another AI in a read-only conversation of its own. Without a model or effort the host uses the
   * 단계 연결 review agent when it is this AI, else the AI's own defaults.
   */
  | {
      readonly kind: 'other';
      readonly providerId: string;
      readonly reviewerSessionId: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
    };

/** What a review reads. Without `baseRef` the host compares with the worktree's base branch. */
export type DaemonReviewTarget =
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'base-branch'; readonly baseRef?: string };

/** Reviewer conversations are host-owned and read-only; their ids carry this prefix. */
export const REVIEWER_SESSION_PREFIX = 'review-';

/** A card of turn wrap-up: the task `suggest_task` left in that turn. */
export interface DaemonWrapUpTaskRef {
  readonly turnId: string;
  readonly taskId: string;
}

/** Hosts that queue a person's settings changes for the next request and take one-request efforts. */
export const AGENT_SETTINGS_CAPABILITY = 'agent-settings-v2';

/**
 * What a session's next request will use beyond its agent record: changes made while a turn ran, a
 * one-request effort, or the linked phase agent (Settings › AI › 단계 연결). The record keeps what the
 * running request uses, so children and forks never inherit a change the person queued for later.
 */
export interface DaemonPendingAgentSettings {
  readonly model?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly reasoningEffort?: string;
  /** 'once': the effort applies to the next request only; the one after sends the record's effort again. */
  readonly effortScope?: 'once' | 'keep';
  /** A one-request effort the turn `runningTurnId` runs with (the record keeps the lasting one). */
  readonly runningEffort?: string;
  readonly runningTurnId?: string;
}

export const DAEMON_COMMAND_TYPES = [
  'project.create',
  'project.update',
  'project.archive',
  'workspace.create',
  'workspace.update',
  'workspace.archive',
  'session.create',
  'session.update',
  'session.archive',
  'agent.create',
  'agent.resume',
  'agent.submit',
  'agent.interrupt-and-submit',
  'agent.interrupt',
  'agent.steer',
  'agent.steer-settle',
  'agent.queue',
  'agent.set-settings',
  'agent.cancel',
  'agent.archive',
  'agent.detach',
  'agent.release',
  'long-run.limit-action',
  'review.start',
  'review.fix',
  'review.resolve',
  'review.cancel',
  'wrap-up.recap-retry',
  'wrap-up.task-outcome',
  'permission.resolve',
  'provider.enable',
  'provider.disable',
  'provider.update',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'schedule.run-now',
  'heartbeat.configure',
  'heartbeat.trigger',
  'browser.open',
  'browser.action',
  'browser.close',
  'browser.site',
  'script.run',
  'script.stop',
  'service.start',
  'service.stop',
  'runtime.set-settings',
] as const;

export type DaemonCommandType = (typeof DAEMON_COMMAND_TYPES)[number];

export interface ProviderEnableInput {
  readonly providerId: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly argv: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly capabilities: readonly string[];
  readonly reviewDigest: string;
}

export interface DaemonCommandPayloads {
  readonly 'project.create': { readonly projectId: string; readonly name: string; readonly rootPath?: string };
  readonly 'project.update': { readonly projectId: string; readonly name?: string; readonly rootPath?: string };
  readonly 'project.archive': { readonly projectId: string };
  readonly 'workspace.create': {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly name: string;
    readonly kind: WorkspaceKind;
    readonly rootPath: string;
    readonly sourceWorkspaceId?: string;
  };
  readonly 'workspace.update': { readonly workspaceId: string; readonly name?: string; readonly rootPath?: string };
  readonly 'workspace.archive': { readonly workspaceId: string };
  readonly 'session.create': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly kind: Exclude<SessionKind, 'agent'>;
    readonly title: string;
  };
  readonly 'session.update': { readonly sessionId: string; readonly title?: string };
  readonly 'session.archive': { readonly sessionId: string };
  readonly 'agent.create': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly providerId: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly initialPrompt?: string;
    readonly parentSessionId?: string;
    readonly reasoningEffort?: string;
    /** A managed child sends its first finished result back to the parent as a new message. */
    readonly reportBack?: boolean;
    /** Turn wrap-up: this child carries out a card of `parentSessionId`; a person's start only. */
    readonly wrapUpTask?: DaemonWrapUpTaskRef & {
      /** Started by one press: it runs at 승인 후 실행 whatever the conversation or this command asks. */
      readonly oneClick?: boolean;
      /** The new worktree's branch, for the card. */
      readonly branch?: string;
    };
  };
  readonly 'agent.resume': {
    readonly sessionId: string;
    readonly sourceSessionId: string;
    readonly workspaceId: string;
    readonly providerId: string;
    readonly providerSessionId: string;
    readonly title: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly reasoningEffort?: string;
    readonly parentSessionId?: string;
  };
  readonly 'agent.submit': {
    readonly sessionId: string;
    readonly prompt: string;
    readonly context?: ChatMessageContext;
    /** The host sends a delegated child's result to its parent (`report-back-runtime` only). */
    readonly reportOf?: string;
    /** Turn wrap-up: this message carries out a card of this conversation (여기서 하기); a person's send only. */
    readonly wrapUpTask?: DaemonWrapUpTaskRef;
    /** The "Continue." the host sends for a limit card (`long-run-runtime` only). */
    readonly longRunResume?: { readonly stopId: string; readonly reason: AppSentReason };
    /** The automatic screen check. The host's to send, like `longRunResume`. */
    readonly browserCheck?: { readonly origin: string; readonly providerId: string };
    /** Long-run: meant for the running turn, but what it carries cannot go in, so it queued. */
    readonly notSteered?: true;
  };
  readonly 'agent.interrupt-and-submit': { readonly sessionId: string; readonly prompt: string; readonly context?: ChatMessageContext };
  readonly 'agent.interrupt': { readonly sessionId: string };
  /** Long-run: plain text for the running turn `turnId`. It stops nothing; when it cannot go in, it queues. */
  readonly 'agent.steer': { readonly sessionId: string; readonly turnId: string; readonly prompt: string };
  /** What a person does with a steer that did not land: `queue` only from `failed`, `box` takes the text back. */
  readonly 'agent.steer-settle': { readonly sessionId: string; readonly steerId: string; readonly action: 'queue' | 'box' };
  /** A person's answer on a limit card. */
  readonly 'long-run.limit-action': { readonly sessionId: string; readonly stopId: string; readonly action: LimitAction };
  readonly 'agent.queue': {
    readonly sessionId: string;
    readonly turnId: string;
    readonly turnRevision: number;
    readonly action: 'remove' | 'take' | 'run-next';
  };
  readonly 'agent.set-settings': {
    readonly sessionId: string;
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
    /** Sent only to hosts advertising `agent-effort-v1`. */
    readonly reasoningEffort?: string;
    /**
     * Sent only to hosts advertising `agent-settings-v2`. 'once' (effort only): the next request alone.
     * While a turn runs, a person's changes wait for the next request instead of being refused.
     */
    readonly scope?: 'once' | 'keep';
    /** `agent-settings-v2`: drops what waits for the next request. */
    readonly clearPending?: true;
  };
  /** Cooperatively interrupts only the active turn; queued turns and provider Session remain resumable. */
  readonly 'agent.cancel': { readonly sessionId: string };
  readonly 'agent.archive': { readonly sessionId: string };
  readonly 'agent.detach': { readonly sessionId: string };
  /** Stops the live provider of an idle conversation (Desktop, after `/clear`); nothing stored changes and the next message reattaches it. */
  readonly 'agent.release': { readonly sessionId: string };
  /**
   * `review-loop-v1`: a person asks for a review of the conversation's changes. `reviewId` is the
   * client's (a retry with the same command replays). The card is the conversation's `review` rows.
   */
  readonly 'review.start': {
    readonly sessionId: string;
    readonly reviewId: string;
    readonly reviewer: DaemonReviewer;
    readonly target: DaemonReviewTarget;
    readonly focus?: string;
  };
  /** Sends the findings to the conversation as a person's message (queued behind a running turn). */
  readonly 'review.fix': {
    readonly sessionId: string;
    readonly reviewId: string;
    readonly findingIds: readonly string[];
    readonly note?: string;
  };
  /** Dismisses or reopens findings on the card; nothing reaches the AI. */
  readonly 'review.resolve': {
    readonly sessionId: string;
    readonly reviewId: string;
    readonly findingIds: readonly string[];
    readonly state: 'dismissed' | 'open';
  };
  /** Stops a review that waits or runs. */
  readonly 'review.cancel': { readonly sessionId: string; readonly reviewId: string };
  /** Turn wrap-up: a person asks again for a turn's failed recap (다시 만들기). */
  readonly 'wrap-up.recap-retry': { readonly sessionId: string; readonly turnId: string };
  /** What became of a card. `started` is not here: the start itself records that, in its own commit. */
  readonly 'wrap-up.task-outcome': DaemonWrapUpTaskRef & {
    readonly sessionId: string;
    readonly outcome: 'dismissed' | 'open' | 'start-failed';
    /** `start-failed`: the host's words, and what was asked for, so 다시 시도 repeats exactly that. */
    readonly reason?: string;
    readonly start?: SuggestedTaskStart;
    /** `start-failed`: the branch name exists, so a retry needs another. */
    readonly branchTaken?: boolean;
  };
  readonly 'permission.resolve': {
    readonly approvalId: string;
    readonly decision: 'allow' | 'deny';
    /** Sent only to hosts advertising `approval-response-v1`. */
    readonly response?: ApprovalResponse;
  };
  readonly 'provider.enable': ProviderEnableInput;
  readonly 'provider.disable': { readonly providerId: string };
  readonly 'provider.update': ProviderEnableInput;
  readonly 'schedule.create': {
    readonly scheduleId: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly providerId: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly prompt: string;
    readonly cron: string;
    readonly timezone: string;
    readonly maxRuns?: number;
    readonly expiresAt?: string;
    readonly enabled: boolean;
  };
  readonly 'schedule.update': {
    readonly scheduleId: string;
    readonly name?: string;
    readonly prompt?: string;
    readonly cron?: string;
    readonly timezone?: string;
    readonly maxRuns?: number;
    readonly expiresAt?: string;
    readonly enabled?: boolean;
  };
  readonly 'schedule.delete': { readonly scheduleId: string };
  readonly 'schedule.run-now': { readonly scheduleId: string };
  readonly 'heartbeat.configure': {
    readonly sessionId: string;
    readonly prompt: string;
    readonly cron: string;
    readonly timezone: string;
    readonly enabled: boolean;
  };
  readonly 'heartbeat.trigger': { readonly sessionId: string };
  readonly 'browser.open': { readonly sessionId: string; readonly workspaceId: string; readonly url: string };
  /** What the person does in the pane. `sessionId` is the conversation: the pane has no session row of its own. */
  readonly 'browser.action': {
    readonly sessionId: string;
    readonly action: 'navigate' | 'reload' | 'back' | 'forward' | 'stop' | 'pick' | 'cancel-pick';
    /** The address, for `navigate`. */
    readonly target?: string;
  };
  readonly 'browser.close': { readonly sessionId: string };
  /** A person allows or revokes one exact origin for one project. No tool, model or page reaches this. */
  readonly 'browser.site': { readonly projectId: string; readonly origin: string; readonly action: 'allow' | 'revoke' };
  readonly 'script.run': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
  };
  readonly 'script.stop': { readonly sessionId: string };
  readonly 'service.start': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
    readonly restartPolicy: 'never' | 'on-failure' | 'always';
  };
  readonly 'service.stop': { readonly sessionId: string };
  readonly 'runtime.set-settings': Partial<DaemonRuntimeSettings>;
}

export interface DaemonCommandEnvelope<T extends DaemonCommandType> {
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly issuedAt: string;
  readonly principal: DaemonPrincipal;
  readonly type: T;
  readonly payload: DaemonCommandPayloads[T];
}

export type DaemonCommand = {
  readonly [T in DaemonCommandType]: DaemonCommandEnvelope<T>;
}[DaemonCommandType];

export type DaemonCommandErrorCode =
  | 'invalid-command'
  | 'unauthorized'
  | 'not-found'
  | 'revision-conflict'
  | 'invalid-state'
  | 'provider-unavailable'
  | 'provider-incompatible'
  | 'tree-depth-limit'
  | 'tree-node-limit'
  | 'child-rate-limit'
  | 'background-turn-timeout'
  | 'automation-requires-daemon'
  | 'delivery-uncertain'
  | 'internal-error';

export interface DaemonCommandError {
  readonly code: DaemonCommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentRevision?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DaemonCommandReceipt =
  | {
      readonly ok: true;
      readonly status: 'applied' | 'queued' | 'replayed';
      readonly commandId: string;
      readonly revision: number;
      readonly eventSequence: number;
    }
  | {
      readonly ok: false;
      readonly status: 'rejected' | 'delivery-uncertain';
      readonly commandId: string;
      readonly revision: number;
      readonly error: DaemonCommandError;
    };

export interface DaemonEventPayloads {
  readonly 'entity.upserted': {
    /** `attention`: what waits on the person changed without another entity (a flow approval, a terminal agent). */
    readonly entityType: 'project' | 'workspace' | 'session' | 'agent' | 'relation' | 'turn' | 'approval' | 'provider' | 'schedule' | 'schedule-run' | 'heartbeat' | 'attention';
    readonly entityId: string;
  };
  readonly 'entity.archived': { readonly entityType: 'project' | 'workspace' | 'session'; readonly entityId: string };
  readonly 'transcript.appended': { readonly sessionId: string; readonly fromSequence: number; readonly toSequence: number };
  readonly 'command.changed': { readonly commandId: string; readonly state: 'pending' | 'sent' | 'applied' | 'delivery-uncertain' | 'failed' };
  readonly 'approval.changed': { readonly approvalId: string; readonly sessionId: string };
  readonly 'runtime.changed': { readonly settings: DaemonRuntimeSettings };
  readonly 'runtime.recovery': { readonly mode: 'normal' | 'legacy-read-only'; readonly detail?: string };
}

export type DaemonEventKind = keyof DaemonEventPayloads;

export interface DaemonEventEnvelope<T extends DaemonEventKind> {
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly occurredAt: string;
  readonly kind: T;
  readonly payload: DaemonEventPayloads[T];
}

export type DaemonEvent = {
  readonly [T in DaemonEventKind]: DaemonEventEnvelope<T>;
}[DaemonEventKind];

export type DaemonEventContinuity = 'next' | 'duplicate' | 'gap' | 'revision-regression';

export function classifyDaemonEvent(
  cursor: Pick<DaemonSnapshot, 'revision' | 'eventSequence'>,
  event: DaemonEvent,
): DaemonEventContinuity {
  if (event.revision < cursor.revision) {
    return 'revision-regression';
  }
  if (event.sequence <= cursor.eventSequence) {
    return 'duplicate';
  }
  if (event.sequence !== cursor.eventSequence + 1) {
    return 'gap';
  }
  return 'next';
}

const NonEmptyStringSchema = z.string().trim().min(1);
const IdentifierSchema = NonEmptyStringSchema.max(256);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const AgentMessageFields = z.object({
  sessionId: IdentifierSchema,
  prompt: NonEmptyStringSchema.max(100_000),
  context: ChatMessageContextSchema.optional(),
  reportOf: IdentifierSchema.optional(),
});
const messageFits = (value: unknown): boolean => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 900 * 1024;
const MESSAGE_TOO_LARGE = 'The complete message must fit within 900 KiB.';
const AgentMessagePayloadSchema = AgentMessageFields.strict().refine(messageFits, MESSAGE_TOO_LARGE);
const WrapUpTaskRefFields = { turnId: IdentifierSchema, taskId: IdentifierSchema };
const PositiveIntegerSchema = z.number().int().positive();
const StringArraySchema = z.array(z.string());
const PermissionPresetSchema = z.enum(['plan', 'standard', 'full-access']);
const WorkspaceKindSchema = z.enum(['local', 'worktree']);
const ProviderProtocolSchema = z.enum(['codex-app-server', 'claude-agent-sdk', 'acp', 'pi-rpc']);
const SessionKindWithoutAgentSchema = z.enum(['terminal', 'diff', 'browser', 'script', 'service']);

export const DaemonPrincipalSchema = z.object({
  kind: z.enum(['desktop', 'android', 'cli', 'mcp', 'provider']),
  id: IdentifierSchema,
  sessionId: IdentifierSchema.optional(),
}).strict().superRefine((principal, context) => {
  if ((principal.kind === 'mcp' || principal.kind === 'provider') && principal.sessionId === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: `${principal.kind} principals require a sessionId`,
    });
  }
});

const ProviderEnableSchema = z.object({
  providerId: IdentifierSchema,
  displayName: NonEmptyStringSchema,
  protocol: ProviderProtocolSchema,
  executablePath: NonEmptyStringSchema,
  executableVersion: NonEmptyStringSchema,
  argv: StringArraySchema,
  environmentVariableNames: StringArraySchema,
  capabilities: StringArraySchema,
  reviewDigest: NonEmptyStringSchema,
}).strict();

const SessionIdSchema = z.object({ sessionId: IdentifierSchema }).strict();
const ScheduleIdSchema = z.object({ scheduleId: IdentifierSchema }).strict();

const ReviewerSessionIdSchema = IdentifierSchema.refine(
  (value) => value.startsWith(REVIEWER_SESSION_PREFIX) && value.length > REVIEWER_SESSION_PREFIX.length,
  `A reviewer conversation id starts with ${REVIEWER_SESSION_PREFIX}.`,
);
const ReviewerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }).strict(),
  z.object({
    kind: z.literal('other'),
    providerId: IdentifierSchema,
    reviewerSessionId: ReviewerSessionIdSchema,
    model: NonEmptyStringSchema.optional(),
    reasoningEffort: z.string().min(1).max(32).optional(),
  }).strict(),
]);
const ReviewTargetCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }).strict(),
  z.object({ kind: z.literal('base-branch'), baseRef: z.string().refine(isSafeRef, 'The base branch must be a plain branch name.').optional() }).strict(),
]);
const ReviewFindingIdsSchema = z.array(IdentifierSchema).min(1).max(REVIEW_LIMITS.findings);

const DaemonCommandPayloadSchemas: Record<DaemonCommandType, z.ZodType> = {
  'project.create': z.object({ projectId: IdentifierSchema, name: NonEmptyStringSchema, rootPath: NonEmptyStringSchema.optional() }).strict(),
  'project.update': z.object({ projectId: IdentifierSchema, name: NonEmptyStringSchema.optional(), rootPath: NonEmptyStringSchema.optional() }).strict(),
  'project.archive': z.object({ projectId: IdentifierSchema }).strict(),
  'workspace.create': z.object({
    workspaceId: IdentifierSchema,
    projectId: IdentifierSchema,
    name: NonEmptyStringSchema,
    kind: WorkspaceKindSchema,
    rootPath: NonEmptyStringSchema,
    sourceWorkspaceId: IdentifierSchema.optional(),
  }).strict(),
  'workspace.update': z.object({ workspaceId: IdentifierSchema, name: NonEmptyStringSchema.optional(), rootPath: NonEmptyStringSchema.optional() }).strict(),
  'workspace.archive': z.object({ workspaceId: IdentifierSchema }).strict(),
  'session.create': z.object({ sessionId: IdentifierSchema, workspaceId: IdentifierSchema, kind: SessionKindWithoutAgentSchema, title: NonEmptyStringSchema }).strict(),
  'session.update': z.object({ sessionId: IdentifierSchema, title: NonEmptyStringSchema.optional() }).strict(),
  'session.archive': SessionIdSchema,
  'agent.create': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    title: NonEmptyStringSchema,
    providerId: IdentifierSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    initialPrompt: NonEmptyStringSchema.optional(),
    parentSessionId: IdentifierSchema.optional(),
    reasoningEffort: z.string().min(1).max(32).optional(),
    reportBack: z.boolean().optional(),
    wrapUpTask: z.object({ ...WrapUpTaskRefFields, oneClick: z.boolean().optional(), branch: IdentifierSchema.optional() }).strict().optional(),
  }).strict(),
  'agent.resume': z.object({
    sessionId: IdentifierSchema,
    sourceSessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    providerId: IdentifierSchema,
    providerSessionId: IdentifierSchema,
    title: NonEmptyStringSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    reasoningEffort: z.string().min(1).max(32).optional(),
    parentSessionId: IdentifierSchema.optional(),
  }).strict(),
  'agent.submit': AgentMessageFields.extend({
    wrapUpTask: z.object(WrapUpTaskRefFields).strict().optional(),
    longRunResume: z.object({ stopId: IdentifierSchema, reason: z.enum(APP_SENT_REASONS) }).strict().optional(),
    browserCheck: z.object({ origin: z.string().min(1).max(2_000), providerId: IdentifierSchema }).strict().optional(),
    notSteered: z.literal(true).optional(),
  }).strict().refine(messageFits, MESSAGE_TOO_LARGE),
  'agent.interrupt-and-submit': AgentMessagePayloadSchema,
  'agent.interrupt': SessionIdSchema,
  // D1: only plain text goes into a running turn. A `/` command was never measured there, so it queues.
  'agent.steer': z.object({ sessionId: IdentifierSchema, turnId: IdentifierSchema, prompt: NonEmptyStringSchema.max(100_000) }).strict()
    .refine((value) => !value.prompt.trimStart().startsWith('/'), 'A slash command does not go into a running turn.')
    .refine(messageFits, MESSAGE_TOO_LARGE),
  'agent.steer-settle': z.object({ sessionId: IdentifierSchema, steerId: IdentifierSchema, action: z.enum(['queue', 'box']) }).strict(),
  'long-run.limit-action': z.object({ sessionId: IdentifierSchema, stopId: IdentifierSchema, action: z.enum(LIMIT_ACTIONS) }).strict(),
  'agent.queue': z.object({ sessionId: IdentifierSchema, turnId: IdentifierSchema, turnRevision: z.number().int().nonnegative(), action: z.enum(['remove', 'take', 'run-next']) }).strict(),
  'agent.set-settings': z.object({ sessionId: IdentifierSchema, model: NonEmptyStringSchema.optional(), permissionPreset: PermissionPresetSchema.optional(), reasoningEffort: z.string().min(1).max(32).optional(), scope: z.enum(['once', 'keep']).optional(), clearPending: z.literal(true).optional() }).strict(),
  'agent.cancel': SessionIdSchema,
  'agent.archive': SessionIdSchema,
  'agent.detach': SessionIdSchema,
  'agent.release': SessionIdSchema,
  'review.start': z.object({
    sessionId: IdentifierSchema,
    reviewId: IdentifierSchema,
    reviewer: ReviewerSchema,
    target: ReviewTargetCommandSchema,
    focus: z.string().max(REVIEW_LIMITS.focus).optional(),
  }).strict(),
  'review.fix': z.object({
    sessionId: IdentifierSchema,
    reviewId: IdentifierSchema,
    findingIds: ReviewFindingIdsSchema,
    note: z.string().max(REVIEW_LIMITS.focus).optional(),
  }).strict(),
  'review.resolve': z.object({
    sessionId: IdentifierSchema,
    reviewId: IdentifierSchema,
    findingIds: ReviewFindingIdsSchema,
    state: z.enum(['dismissed', 'open']),
  }).strict(),
  'review.cancel': z.object({ sessionId: IdentifierSchema, reviewId: IdentifierSchema }).strict(),
  'wrap-up.recap-retry': z.object({ sessionId: IdentifierSchema, turnId: IdentifierSchema }).strict(),
  'wrap-up.task-outcome': z.object({
    sessionId: IdentifierSchema,
    ...WrapUpTaskRefFields,
    outcome: z.enum(['dismissed', 'open', 'start-failed']),
    reason: z.string().min(1).max(2_000).optional(),
    start: SuggestedTaskStartSchema.optional(),
    branchTaken: z.boolean().optional(),
  }).strict().refine((value) => (value.outcome === 'start-failed') === (value.reason !== undefined && value.start !== undefined),
    'A failed start says why and what was asked for; nothing else does.'),
  'permission.resolve': z.object({ approvalId: IdentifierSchema, decision: z.enum(['allow', 'deny']), response: ApprovalResponseSchema.optional() }).strict(),
  'provider.enable': ProviderEnableSchema,
  'provider.disable': z.object({ providerId: IdentifierSchema }).strict(),
  'provider.update': ProviderEnableSchema,
  'schedule.create': z.object({
    scheduleId: IdentifierSchema,
    name: NonEmptyStringSchema,
    workspaceId: IdentifierSchema,
    providerId: IdentifierSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    prompt: NonEmptyStringSchema,
    cron: NonEmptyStringSchema,
    timezone: NonEmptyStringSchema,
    maxRuns: PositiveIntegerSchema.optional(),
    expiresAt: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
  }).strict(),
  'schedule.update': z.object({
    scheduleId: IdentifierSchema,
    name: NonEmptyStringSchema.optional(),
    prompt: NonEmptyStringSchema.optional(),
    cron: NonEmptyStringSchema.optional(),
    timezone: NonEmptyStringSchema.optional(),
    maxRuns: PositiveIntegerSchema.optional(),
    expiresAt: NonEmptyStringSchema.optional(),
    enabled: z.boolean().optional(),
  }).strict(),
  'schedule.delete': ScheduleIdSchema,
  'schedule.run-now': ScheduleIdSchema,
  'heartbeat.configure': z.object({
    sessionId: IdentifierSchema,
    prompt: NonEmptyStringSchema,
    cron: NonEmptyStringSchema,
    timezone: NonEmptyStringSchema,
    enabled: z.boolean(),
  }).strict(),
  'heartbeat.trigger': SessionIdSchema,
  'browser.open': z.object({ sessionId: IdentifierSchema, workspaceId: IdentifierSchema, url: z.url() }).strict(),
  'browser.action': z.object({
    sessionId: IdentifierSchema,
    action: z.enum(['navigate', 'reload', 'back', 'forward', 'stop', 'pick', 'cancel-pick']),
    target: NonEmptyStringSchema.optional(),
  }).strict(),
  'browser.close': SessionIdSchema,
  'browser.site': z.object({ projectId: IdentifierSchema, origin: z.url(), action: z.enum(['allow', 'revoke']) }).strict(),
  'script.run': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    command: NonEmptyStringSchema,
    argv: StringArraySchema,
    cwd: NonEmptyStringSchema,
    environmentVariableNames: StringArraySchema,
  }).strict(),
  'script.stop': SessionIdSchema,
  'service.start': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    command: NonEmptyStringSchema,
    argv: StringArraySchema,
    cwd: NonEmptyStringSchema,
    environmentVariableNames: StringArraySchema,
    restartPolicy: z.enum(['never', 'on-failure', 'always']),
  }).strict(),
  'service.stop': SessionIdSchema,
  'runtime.set-settings': z.object({
    keepRunning: z.boolean().optional(),
    startAtLogin: z.boolean().optional(),
    orchestrationToolsEnabled: z.boolean().optional(),
    browserEnabled: z.boolean().optional(),
  }).strict(),
};

const DaemonCommandEnvelopeSchema = z.object({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  commandId: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
  expectedRevision: NonNegativeIntegerSchema,
  issuedAt: NonEmptyStringSchema,
  principal: DaemonPrincipalSchema,
  type: z.enum(DAEMON_COMMAND_TYPES),
  payload: z.unknown(),
}).strict();

export function parseDaemonCommand(value: unknown): DaemonCommand {
  const envelope = DaemonCommandEnvelopeSchema.parse(value);
  const payload = DaemonCommandPayloadSchemas[envelope.type].parse(envelope.payload);
  return { ...envelope, payload } as DaemonCommand;
}

export function safeParseDaemonCommand(value: unknown): z.ZodSafeParseResult<DaemonCommand> {
  try {
    return { success: true, data: parseDaemonCommand(value) };
  } catch (error) {
    return { success: false, error: error as z.ZodError<DaemonCommand> };
  }
}

export function createDaemonCommand<T extends DaemonCommandType>(input: Omit<DaemonCommandEnvelope<T>, 'protocolVersion'>): DaemonCommandEnvelope<T> {
  return {
    ...input,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
  };
}
