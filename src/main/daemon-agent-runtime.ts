import { PROPOSED_PLAN_REQUEST_PREFIX, type ApprovalResponse } from '../shared/approval-request';
import { nativeChildSessionId, routedChildItem, subagentResultItem, subagentStartItems } from './native-subagent-projection';
import { finalAssistantText, latestFinishedTurn, managedChildOriginId, reportBackRequested } from './managed-child-transcript';
import { createHash } from 'node:crypto';
import { validateChatMessageContext, type ChatMessageContext, type ChatReplyReference } from '../shared/chat-message';

import {
  DAEMON_HARD_LIMITS,
  type DaemonAgent,
  type DaemonCommand,
  type DaemonCommandError,
  createDaemonCommand,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonPendingAgentSettings,
  type DaemonPrincipal,
  type DaemonSession,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import type {
  AgentProviderAdapter,
  AgentProviderEvent,
  ProviderSessionContext,
  ProviderSessionHandle,
  ProviderSideQuestionAnswer,
} from './agent-provider-adapter';
import { ProviderSideQuestionError } from './agent-provider-adapter';
import type { SideQuestionExchange } from '../shared/agent-side-question';
import type {
  DaemonCommandExecutionContext,
  DaemonCommandExecutionResult,
  DaemonCommandHandler,
  DaemonSystemTransitionPlanner,
} from './daemon-command-router';
import type {
  DaemonMigrationReceipt,
  DaemonScheduleRun,
  DaemonScheduleRunInput,
  DaemonStoreCommit,
  DaemonStoreMutation,
  DaemonSystemTransition,
  DaemonSystemTransitionReceipt,
  DaemonTranscriptItemInput,
} from './daemon-store';
import {
  MAX_TRANSCRIPT_BATCH_ITEMS,
  MAX_TRANSCRIPT_BATCH_UTF8_BYTES,
} from './daemon-store';
import { AgentProviderRegistry } from './agent-provider-registry';
import { AgentUsageTracker, type PersistedAgentUsage } from './agent-usage-tracker';
import { findActiveDaemonWorkspace } from './daemon-workspace-authority';
import type { ConversationFolderResolver } from './conversation-roots';
import path from 'node:path';
import type { HistoryResumeResult } from '../shared/conversation-history';

type AgentCommandType = Extract<DaemonCommandType,
  | 'agent.create'
  | 'agent.resume'
  | 'agent.submit'
  | 'agent.interrupt-and-submit'
  | 'agent.interrupt'
  | 'agent.queue'
  | 'agent.set-settings'
  | 'agent.cancel'
  | 'agent.archive'
  | 'agent.detach'
  | 'agent.release'
  | 'permission.resolve'
  | 'provider.enable'
  | 'provider.disable'
  | 'provider.update'
>;

export interface DaemonAgentRuntimeOptions {
  /** Host task binding must commit before a prepared turn reaches a provider. */
  readonly beforeProviderDispatch?: (turn: DaemonTurn) => Promise<boolean | void>;
  readonly canDispatchTurn?: (turn: DaemonTurn) => boolean;
  readonly preparedSessionSettings?: (sessionId: string) => Pick<ProviderSessionContext, 'reasoningEffort' | 'environment' | 'managedExecution' | 'toolsDisabled'> | undefined;
  readonly providers: AgentProviderRegistry;
  readonly getSnapshot: () => DaemonSnapshot;
  readonly applySystemCommit: (
    commit: DaemonStoreCommit | DaemonSystemTransitionPlanner,
  ) => Promise<unknown>;
  /** Evaluated under the command FIFO and SQLite write transaction. */
  readonly applySystemTransition: <T>(
    transition: DaemonSystemTransition<T>,
  ) => Promise<DaemonSystemTransitionReceipt<T> | undefined>;
  readonly readTranscript: (
    sessionId: string,
    afterSequence?: number,
    limit?: number,
  ) => readonly DaemonTranscriptItem[];
  readonly findCommand?: (commandId: string) => DaemonCommand | undefined;
  /** Issues a command as the host itself (a delegated child's report to its parent). */
  readonly executeCommand?: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly findMigrationReceipt?: (id: string) => DaemonMigrationReceipt | undefined;
  /**
   * Whether the provider kept a transcript for this subagent: true/false when
   * the parent's own record could be read, undefined when there is no evidence.
   */
  readonly subagentRecordExists?: (input: {
    readonly providerId: string;
    readonly workspaceRoot: string;
    readonly parentProviderSessionId: string;
    readonly childProviderSessionId: string;
  }) => boolean | undefined;
  readonly orchestrationForSession?: (
    sessionId: string,
  ) => ProviderSessionContext['orchestration'] | undefined;
  readonly revokeOrchestrationForSession?: (sessionId: string) => void;
  readonly workflowToolsForSession?: (sessionId: string) => boolean;
  readonly conversationWritable?: (projectId: string, sessionId: string) => Promise<boolean>;
  readonly conversationContext?: (projectId: string, sessionId: string) => Promise<ChatMessageContext['workflow']>;
  /** The folders a conversation works in: its workspace plus the project's other registered folders. */
  readonly conversationFolders?: ConversationFolderResolver;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly shutdownStepTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
  /** Keeps the last reported usage on this computer so a tab shows it as soon as it opens. */
  readonly agentUsageStore?: {
    readonly load: () => Promise<unknown>;
    readonly save: (state: PersistedAgentUsage) => Promise<void>;
  };
  /**
   * The linked agent of a conversation phase (Settings › AI › 단계 연결) for a session of `providerId`:
   * its effort, and its model only when the person turned on '모델도 바꾸기'. Absent: no link.
   */
  readonly phaseSettings?: (providerId: string, phase: 'plan' | 'implement') => { readonly model?: string; readonly reasoningEffort?: string } | undefined;
  /**
   * Remembers which sessions had settings waiting for their next request, so a restart (which drops
   * them: they live in host memory) can say so in those conversations.
   */
  readonly pendingSettingsStore?: {
    readonly load: () => Promise<unknown>;
    readonly save: (sessions: Readonly<Record<string, DaemonPendingAgentSettings>>) => Promise<void>;
  };
}

/** Only the host history resolver may construct an adoption; no renderer command accepts this ID. */
export interface NativeHistoryAdoption {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly providerId: 'codex' | 'claude';
  readonly providerSessionId: string;
  readonly historyId: string;
  readonly rootPath: string;
  readonly title: string;
  readonly sourceUpdatedAt: number;
  readonly model?: string;
  readonly permissionPreset: DaemonAgent['permissionPreset'];
  readonly reasoningEffort?: string;
  readonly transcript: readonly DaemonTranscriptItemInput[];
  readonly requestReceipt?: { readonly id: string; readonly fingerprint: string };
}

interface ChildRelationPlan {
  readonly treeId: string;
  readonly depth: number;
}

const MAX_CHILD_SUMMARY_LENGTH = 2_000;

/** The host's own principal when it sends a delegated child's result to the parent. */
const REPORT_BACK_PRINCIPAL = 'report-back-runtime';
/** Codex's own wording after its "Implement this plan?" prompt. */
const IMPLEMENT_PLAN_PROMPT = 'Implement the plan above.';
/** After a Claude plan approved by ending its turn: the model saw the CLI's decline text, so this says it was approved. */
const APPROVED_PLAN_PROMPT = 'Your plan was approved. Implement it now.';

interface ReportBackPlan {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly prompt: string;
}

function boundedChildSummary(value: string | undefined, limit = MAX_CHILD_SUMMARY_LENGTH): string | undefined {
  const summary = value?.trim().slice(0, limit);
  return summary ? summary : undefined;
}

/** How much of a delegated child's answer its parent hears as a message (the full answer stays in the child). */
const MAX_REPORT_LENGTH = 8_000;

const ACTIVE_TURN_STATES = new Set<DaemonTurn['state']>([
  'submitting',
  'working',
  'blocked',
  'delivery-uncertain',
]);

const TERMINAL_TURN_STATES = new Set<DaemonTurn['state']>([
  'completed',
  'interrupted',
  'failed',
]);

const TERMINAL_AGENT_STATES = new Set<DaemonAgent['state']>([
  'done',
  'interrupted',
  'error',
  'archived',
]);

const TERMINAL_SESSION_STATES = new Set<DaemonSession['state']>([
  'completed',
  'interrupted',
  'failed',
  'archived',
]);

const ACTIVE_AGENT_STATES = new Set<DaemonAgent['state']>([
  'starting',
  'queued',
  'working',
  'blocked',
  'delivery-uncertain',
]);

const EXPLICIT_QUIT_ERROR_CODE = 'explicit-quit';
const EXPLICIT_QUIT_DELIVERY_UNCERTAIN_ERROR_CODE = 'explicit-quit-delivery-uncertain';
const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 750;

function commandError(
  code: DaemonCommandError['code'],
  message: string,
  retryable = false,
): DaemonCommandExecutionResult {
  return { ok: false, error: { code, message, retryable } };
}

/** Receipts of subagents archived by the startup pass; each one restores its session. */
export const PROVIDER_NATIVE_REPAIR_SOURCE = 'provider-native-repair';

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function sessionInput(
  session: DaemonSession,
  state: DaemonSession['state'] = session.state,
  archivedAt = session.archivedAt,
): Omit<DaemonSession, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    id: session.id,
    projectId: session.projectId,
    workspaceId: session.workspaceId,
    kind: session.kind,
    title: session.title,
    state,
    source: session.source,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

/**
 * The effort a provider reports it runs at, recorded only when the user chose none: the session
 * context does not carry the agent's chosen effort (it is applied per message), so the provider's
 * default must not overwrite that choice.
 */
function appliedEffort(agent: DaemonAgent, handle: ProviderSessionHandle): { reasoningEffort?: string } {
  return !agent.reasoningEffort && handle.reasoningEffort ? { reasoningEffort: handle.reasoningEffort } : {};
}

function agentInput(
  agent: DaemonAgent,
  patch: Partial<Omit<DaemonAgent, 'revision' | 'createdAt' | 'updatedAt'>> = {},
): Omit<DaemonAgent, 'revision' | 'createdAt' | 'updatedAt'> {
  const providerSessionId = Object.prototype.hasOwnProperty.call(patch, 'providerSessionId')
    ? patch.providerSessionId
    : agent.providerSessionId;
  const model = Object.prototype.hasOwnProperty.call(patch, 'model')
    ? patch.model
    : agent.model;
  const reasoningEffort = Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')
    ? patch.reasoningEffort
    : agent.reasoningEffort;
  const currentTurnId = Object.prototype.hasOwnProperty.call(patch, 'currentTurnId')
    ? patch.currentTurnId
    : agent.currentTurnId;
  return {
    sessionId: agent.sessionId,
    providerId: patch.providerId ?? agent.providerId,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    permissionPreset: patch.permissionPreset ?? agent.permissionPreset,
    state: patch.state ?? agent.state,
    ...(currentTurnId ? { currentTurnId } : {}),
    queuedTurnCount: patch.queuedTurnCount ?? agent.queuedTurnCount,
    orchestrationEnabled: patch.orchestrationEnabled ?? agent.orchestrationEnabled,
  };
}

function turnInput(
  turn: DaemonTurn,
  patch: Partial<Omit<DaemonTurn, 'revision' | 'createdAt' | 'updatedAt'>> = {},
): Omit<DaemonTurn, 'revision' | 'createdAt' | 'updatedAt'> {
  const optional = <K extends 'providerTurnId' | 'startedAt' | 'finishedAt' | 'errorCode'>(key: K) => (
    Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : turn[key]
  );
  const providerTurnId = optional('providerTurnId');
  const startedAt = optional('startedAt');
  const finishedAt = optional('finishedAt');
  const errorCode = optional('errorCode');
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    commandId: turn.commandId,
    ...(turn.enqueueSequence ? { enqueueSequence: turn.enqueueSequence } : {}),
    state: patch.state ?? turn.state,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function scheduleRunInput(
  run: DaemonScheduleRun,
  patch: Partial<DaemonScheduleRunInput> = {},
): DaemonScheduleRunInput {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    ...(patch.sessionId ?? run.sessionId ? { sessionId: patch.sessionId ?? run.sessionId } : {}),
    state: patch.state ?? run.state,
    scheduledFor: patch.scheduledFor ?? run.scheduledFor,
    ...(patch.startedAt ?? run.startedAt ? { startedAt: patch.startedAt ?? run.startedAt } : {}),
    ...(patch.finishedAt ?? run.finishedAt ? { finishedAt: patch.finishedAt ?? run.finishedAt } : {}),
    ...(patch.summary ?? run.summary ? { summary: patch.summary ?? run.summary } : {}),
    ...(patch.errorCode ?? run.errorCode ? { errorCode: patch.errorCode ?? run.errorCode } : {}),
  };
}

function transcriptInput(item: DaemonTranscriptItem): DaemonTranscriptItemInput {
  return {
    id: item.id,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    sessionId: item.sessionId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    kind: item.kind,
    text: item.text,
    isDelta: item.isDelta,
    isSensitive: item.isSensitive,
    ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}),
    ...(item.context ? { context: item.context } : {}),
    ...(item.payload ? { payload: item.payload } : {}),
    createdAt: item.createdAt,
  };
}

function providerStateToAgent(
  state: Extract<AgentProviderEvent, { kind: 'session-state' }>['state'],
): DaemonAgent['state'] {
  switch (state) {
    case 'starting': return 'starting';
    case 'working': return 'working';
    case 'blocked': return 'blocked';
    case 'idle': return 'idle';
    case 'completed': return 'done';
    // An adapter interruption ends the active turn, not the resumable provider
    // Session. Full lifecycle disposal is owned by Archive or daemon shutdown.
    case 'interrupted': return 'idle';
    case 'failed': return 'error';
  }
}

function providerStateToSession(
  state: Extract<AgentProviderEvent, { kind: 'session-state' }>['state'],
): DaemonSession['state'] {
  switch (state) {
    case 'starting': return 'starting';
    case 'working': return 'running';
    case 'blocked': return 'needs-attention';
    case 'idle': return 'idle';
    case 'completed': return 'completed';
    case 'interrupted': return 'idle';
    case 'failed': return 'failed';
  }
}

/**
 * Authoritative managed-Agent state machine. Command handlers, FIFO queues,
 * tree limits, provider events, approvals, reconciliation and timeouts are
 * hidden behind one router-handler surface.
 */
export class DaemonAgentRuntime {
  private readonly now: () => Date;
  private readonly shutdownStepTimeoutMs: number;
  private readonly lifecycleAbortController = new AbortController();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly providerLifecycleOperations = new Map<string, Promise<void>>();
  private readonly providerLifecycleGenerations = new Map<string, number>();
  private readonly providerHandleOperations = new Map<string, Promise<void>>();
  private readonly attachedProviderSessions = new Set<string>();
  /** Last reported usage per provider and conversation, merged into snapshots by the router. */
  private readonly agentUsageTracker = new AgentUsageTracker(() => this.now().getTime());
  /** What each session's next request will use beyond its record (host memory; the snapshot shows it). */
  private readonly pendingSettings = new Map<string, DaemonPendingAgentSettings>();
  /** Plan turns a person approved by ending them, by turn: their implementation is sent once they completed. */
  private readonly approvedPlanFollowUps = new Map<string, { readonly approvalId: string; readonly sessionId: string; readonly principal: DaemonPrincipal }>();
  private unsubscribeProviders: (() => void) | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private disposed = false;
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: DaemonAgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.shutdownStepTimeoutMs = options.shutdownStepTimeoutMs ?? DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.shutdownStepTimeoutMs) || this.shutdownStepTimeoutMs < 1) {
      throw new Error('shutdownStepTimeoutMs must be a positive integer.');
    }
  }

  handlers(): Partial<Record<AgentCommandType, DaemonCommandHandler>> {
    return {
      'agent.create': (command, context) => this.runCommand(() => this.create(command, context)),
      'agent.resume': (command, context) => this.runCommand(() => this.resume(command, context)),
      'agent.submit': (command, context) => this.runCommand(() => this.submit(command, context, false)),
      'agent.interrupt-and-submit': (command, context) => (
        this.runCommand(() => this.submit(command, context, true))
      ),
      'agent.interrupt': (command, context) => this.runCommand(() => this.interrupt(command, context)),
      'agent.queue': (command, context) => this.runCommand(() => this.manageQueue(command, context)),
      'agent.set-settings': (command, context) => this.runCommand(() => this.setSettings(command, context)),
      'agent.cancel': (command, context) => this.runCommand(() => this.cancel(command, context)),
      'agent.archive': (command, context) => this.runCommand(() => this.archive(command, context)),
      'agent.detach': (command, context) => this.runCommand(() => this.detach(command, context)),
      'agent.release': (command, context) => this.runCommand(() => this.release(command, context)),
      'permission.resolve': (command, context) => this.runCommand(() => this.resolveApproval(command, context)),
      'provider.enable': (command, context) => this.runCommand(() => this.enableProvider(command, context)),
      'provider.update': (command, context) => this.runCommand(() => this.enableProvider(command, context)),
      'provider.disable': (command, context) => this.runCommand(() => this.disableProvider(command, context)),
    };
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.resolve();
    this.startPromise = this.startRuntime();
    return this.startPromise;
  }

  private async startRuntime(): Promise<void> {
    try {
      this.agentUsageTracker.restore(await this.options.agentUsageStore?.load());
    } catch (error) {
      this.report('agent usage load failed', error);
    }
    await this.noticeDroppedPendingSettings();
    this.unsubscribeProviders = this.options.providers.subscribe((providerId, event) => {
      this.eventTail = this.eventTail
        .then(() => this.handleProviderEvent(providerId, event))
        .catch((error) => this.report('provider event failed', error));
    });
    await this.expirePersistedApprovals();
    if (this.disposed) return;
    await this.settleProviderNativeChildren();
    if (this.disposed) return;
    await this.recoverUnattachedClaims();
    if (this.disposed) return;
    await this.rehydratePersistedSessions();
    if (this.disposed) return;
    await this.reconcileUnsettled();
    if (this.disposed) return;
    await this.drainEventTail();
    if (this.disposed) return;
    this.queuePump();
  }

  /**
   * Synchronously closes runtime ingress and cancels launch-capable provider
   * work. Durable shutdown is completed by dispose(), after accepted command
   * FIFO work has observed this signal and released the authority gate.
   */
  beginShutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleAbortController.abort();
    this.unsubscribeProviders?.();
    this.unsubscribeProviders = null;
    this.pumpRequested = false;
  }

  /** Settings waiting for each live session's next request, for the snapshot. */
  pendingAgentSettings(snapshot: Pick<DaemonSnapshot, 'agents'>): Readonly<Record<string, DaemonPendingAgentSettings>> | undefined {
    const entries = snapshot.agents
      .filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state) && this.pendingSettings.has(agent.sessionId))
      .map((agent) => [agent.sessionId, this.pendingSettings.get(agent.sessionId)!] as const);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  /** Replaces what waits for a session's next request; every client refetches the snapshot that shows it. */
  private setPending(sessionId: string, value: DaemonPendingAgentSettings | undefined): void {
    const empty = !value || Object.values(value).every((entry) => entry === undefined);
    if (empty) {
      if (!this.pendingSettings.delete(sessionId)) return;
    } else {
      this.pendingSettings.set(sessionId, Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as DaemonPendingAgentSettings);
    }
    const store = this.options.pendingSettingsStore;
    // Only what still waits for a request is worth a notice after a restart.
    const sessions = Object.fromEntries([...this.pendingSettings].filter(([, entry]) => entry.model || entry.permissionPreset || entry.reasoningEffort));
    if (store) this.runBackground('pending settings save failed', () => store.save(sessions));
    this.runBackground('pending settings publish failed', () => this.transition(() => ({ events: [{
      kind: 'entity.upserted', payload: { entityType: 'agent', entityId: sessionId },
    }] })).then(() => undefined));
  }

  /** Settings that waited for a next request when the app last closed are gone; their conversations say so. */
  private async noticeDroppedPendingSettings(): Promise<void> {
    const store = this.options.pendingSettingsStore;
    if (!store) return;
    let dropped: Record<string, unknown> = {};
    try {
      const raw = await store.load();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) dropped = raw as Record<string, unknown>;
    } catch (error) {
      this.report('pending settings load failed', error);
    }
    const sessionIds = Object.entries(dropped).filter(([, entry]) => {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return Boolean(value.model || value.permissionPreset || value.reasoningEffort);
    }).map(([sessionId]) => sessionId);
    if (!sessionIds.length) {
      if (Object.keys(dropped).length) this.runBackground('pending settings save failed', () => store.save({}));
      return;
    }
    await this.transition((snapshot) => {
      const live = sessionIds.filter((id) => snapshot.agents.some((agent) => agent.sessionId === id && !TERMINAL_AGENT_STATES.has(agent.state)));
      if (!live.length) return undefined;
      return { mutations: this.transcriptMutations(live.map((sessionId) => ({
        id: stableId('pending-settings-dropped', sessionId, this.isoNow()),
        sessionId,
        kind: 'notice' as const,
        text: 'Settings chosen for the next request were cleared when EZTerminal restarted. Choose them again if you still want them.',
        isDelta: false,
        isSensitive: false,
      }))) };
    });
    this.runBackground('pending settings save failed', () => store.save({}));
  }

  /** Usage for a snapshot: each live conversation's AI limits and context, and each AI's limits. */
  agentUsage(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents'>): Pick<DaemonSnapshot, 'agentUsage' | 'providerUsage'> {
    return this.agentUsageTracker.snapshot(snapshot);
  }

  /**
   * Conversations a /btw can be asked in right now: their provider session is attached in this
   * run (a message was sent, or a running turn rehydrated it) and the adapter answers side questions.
   */
  sideQuestionSessionIds(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents'>): readonly string[] {
    return snapshot.agents
      .filter((agent) => this.attachedProviderSessions.has(agent.sessionId) && agent.providerSessionId
        && this.options.providers.supportsSideQuestions(agent.providerId)
        && !snapshot.sessions.find((session) => session.id === agent.sessionId)?.archivedAt)
      .map((agent) => agent.sessionId);
  }

  /**
   * One side question on an attached provider session. Never attaches, resumes or commits
   * anything: the question and answer leave no turn, transcript item, event or store change.
   */
  async askSideQuestion(
    input: { readonly sessionId: string; readonly question: string; readonly history: readonly SideQuestionExchange[] },
    signal: AbortSignal,
  ): Promise<ProviderSideQuestionAnswer> {
    if (this.disposed) throw new ProviderSideQuestionError('not-live');
    const target = () => {
      const snapshot = this.options.getSnapshot();
      const agent = snapshot.agents.find((entry) => entry.sessionId === input.sessionId);
      if (!agent?.providerSessionId || !this.sideQuestionSessionIds({ sessions: snapshot.sessions, agents: [agent] }).length) return undefined;
      const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
      return provider.ok && provider.value.askSideQuestion ? { agent, provider: provider.value, providerSessionId: agent.providerSessionId } : undefined;
    };
    if (signal.aborted) throw new ProviderSideQuestionError('cancelled');
    const first = target();
    if (!first) throw new ProviderSideQuestionError('not-live');
    // Wait out a settings relaunch in progress without joining the queue: a side question delays nothing.
    const pending = this.providerHandleOperations.get(JSON.stringify([first.agent.providerId, first.providerSessionId]));
    if (pending) {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    }
    if (signal.aborted) throw new ProviderSideQuestionError('cancelled');
    const current = target();
    if (!current || current.providerSessionId !== first.providerSessionId) throw new ProviderSideQuestionError('not-live');
    return current.provider.askSideQuestion!({
      sessionId: input.sessionId,
      providerSessionId: current.providerSessionId,
      question: input.question,
      history: input.history,
    }, signal);
  }

  dispose(mode: 'explicit-quit' | 'process-loss' = 'explicit-quit'): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.beginShutdown();
    this.disposePromise = mode === 'process-loss'
      ? this.disposeResources()
      : this.disposeForExplicitQuit();
    return this.disposePromise;
  }

  private async disposeForExplicitQuit(): Promise<void> {
    await this.settleStartupForShutdown();
    const finishedAt = this.isoNow();
    let persistenceFailure: unknown;
    let interruptTargets: readonly {
      readonly sessionId: string;
      readonly providerId: string;
      readonly providerSessionId: string;
    }[] = [];
    try {
      const receipt = await this.options.applySystemTransition((state) => {
        const affectedSessionIds = new Set(
          state.snapshot.turns
            .filter((turn) => !TERMINAL_TURN_STATES.has(turn.state))
            .map((turn) => turn.sessionId),
        );
        const uncertainSessionIds = new Set(
          state.snapshot.turns
            .filter((turn) => turn.state === 'submitting' || turn.state === 'delivery-uncertain')
            .map((turn) => turn.sessionId),
        );
        for (const agent of state.snapshot.agents) {
          if (
            agent.currentTurnId
            || agent.queuedTurnCount > 0
            || ACTIVE_AGENT_STATES.has(agent.state)
          ) affectedSessionIds.add(agent.sessionId);
          if (agent.state === 'delivery-uncertain') uncertainSessionIds.add(agent.sessionId);
        }
        for (const session of state.snapshot.sessions) {
          if (session.state === 'delivery-uncertain') uncertainSessionIds.add(session.id);
        }
        const targets = state.snapshot.agents.flatMap((agent) => (
          affectedSessionIds.has(agent.sessionId) && agent.providerSessionId && agent.currentTurnId
            ? [{
                sessionId: agent.sessionId,
                providerId: agent.providerId,
                providerSessionId: agent.providerSessionId,
              }]
            : []
        ));
        const mutations: DaemonStoreMutation[] = [
          ...state.snapshot.turns
            .filter((turn) => (
              turn.state === 'queued'
              || turn.state === 'working'
              || turn.state === 'blocked'
              || turn.state === 'submitting'
            ))
            .map((turn): DaemonStoreMutation => ({
              kind: 'turn.upsert',
              value: turn.state === 'submitting'
                ? turnInput(turn, {
                    state: 'delivery-uncertain',
                    errorCode: EXPLICIT_QUIT_DELIVERY_UNCERTAIN_ERROR_CODE,
                  })
                : turnInput(turn, {
                    state: 'interrupted',
                    finishedAt,
                    errorCode: EXPLICIT_QUIT_ERROR_CODE,
                  }),
            })),
          ...state.snapshot.approvals
            .filter((approval) => approval.state === 'pending')
            .map((approval): DaemonStoreMutation => ({
              kind: 'approval.upsert',
              value: this.resolvedApprovalInput(approval, 'expired', finishedAt),
            })),
          ...state.snapshot.agents
            .filter((agent) => affectedSessionIds.has(agent.sessionId) && agent.state !== 'archived')
            .map((agent): DaemonStoreMutation => {
              const uncertainTurn = state.snapshot.turns.find((turn) => (
                turn.sessionId === agent.sessionId
                && (turn.state === 'submitting' || turn.state === 'delivery-uncertain')
                && (turn.id === agent.currentTurnId || agent.currentTurnId === undefined)
              ));
              const uncertain = uncertainSessionIds.has(agent.sessionId);
              return {
                kind: 'agent.upsert',
                value: agentInput(agent, {
                  state: uncertain ? 'delivery-uncertain' : 'idle',
                  currentTurnId: uncertainTurn?.id,
                  queuedTurnCount: 0,
                }),
              };
            }),
          ...state.snapshot.sessions
            .filter((session) => (
              affectedSessionIds.has(session.id) && !TERMINAL_SESSION_STATES.has(session.state)
            ))
            .map((session): DaemonStoreMutation => ({
              kind: 'session.upsert',
              value: sessionInput(
                session,
                uncertainSessionIds.has(session.id) ? 'delivery-uncertain' : 'idle',
              ),
            })),
          ...state.scheduleRuns
            .filter((run) => (
              run.state === 'running'
              && run.sessionId !== undefined
              && affectedSessionIds.has(run.sessionId)
            ))
            .map((run): DaemonStoreMutation => ({
              kind: 'schedule-run.upsert',
              value: scheduleRunInput(run, {
                state: 'interrupted',
                finishedAt,
                errorCode: EXPLICIT_QUIT_ERROR_CODE,
              }),
            })),
        ];
        return { commit: { mutations }, value: targets };
      });
      interruptTargets = receipt?.value ?? [];
    } catch (error) {
      this.report('persist explicit Agent shutdown', error);
      persistenceFailure = error;
    }

    await this.runBoundedShutdownStep('drain in-flight Agent work', Promise.allSettled([
      this.eventTail,
      this.pumpPromise ?? Promise.resolve(),
      ...this.backgroundTasks,
    ]));
    await this.runBoundedShutdownStep('interrupt provider Agent work', Promise.allSettled(
      interruptTargets.map(async (target) => {
        const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), target.providerId);
        if (!provider.ok) return;
        try {
          await provider.value.interrupt(target.sessionId, target.providerSessionId);
        } catch (error) {
          this.report(`interrupt Agent ${target.sessionId} during explicit shutdown`, error);
        }
      }),
    ));
    await this.runBoundedShutdownStep('dispose Agent providers', this.options.providers.dispose());
    if (persistenceFailure !== undefined) throw persistenceFailure;
  }

  private async disposeResources(): Promise<void> {
    await this.settleStartupForShutdown();
    await this.runBoundedShutdownStep('drain in-flight Agent work', Promise.allSettled([
      this.eventTail,
      this.pumpPromise ?? Promise.resolve(),
      ...this.backgroundTasks,
    ]));
    await this.runBoundedShutdownStep('dispose Agent providers', this.options.providers.dispose());
  }

  /** Wait until all currently reachable provider events and dispatch work settle. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const eventTail = this.eventTail;
      const pump = this.pumpPromise;
      const background = [...this.backgroundTasks];
      await Promise.allSettled([eventTail, pump ?? Promise.resolve(), ...background]);
      if (
        eventTail === this.eventTail
        && pump === this.pumpPromise
        && background.length === this.backgroundTasks.size
        && background.every((task) => this.backgroundTasks.has(task))
      ) return;
    }
  }

  /** Atomic native ownership claim + transcript import. Existing agent.resume checks stay intact. */
  async adoptNativeHistory(input: NativeHistoryAdoption): Promise<HistoryResumeResult> {
    if (this.disposed || this.lifecycleAbortController.signal.aborted) return { ok: false, reason: 'unavailable', message: 'The Agent runtime is stopping.' };
    const receipt = await this.options.applySystemTransition<HistoryResumeResult>(({ snapshot }) => {
      const fail = (reason: 'not-found' | 'root-mismatch' | 'provider-unavailable' | 'conflict', message: string) => ({
        commit: {}, value: { ok: false as const, reason, message },
      });
      const workspace = findActiveDaemonWorkspace(snapshot, input.workspaceId);
      if (!workspace) return fail('not-found', 'The target workspace is unavailable.');
      const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (key(workspace.rootPath) !== key(input.rootPath)) return fail('root-mismatch', 'Resume in the workspace where this conversation was recorded.');
      const owner = snapshot.agents.find(agent => agent.providerId === input.providerId && agent.providerSessionId === input.providerSessionId);
      if (owner) return { commit: {}, value: { ok: true, sessionId: owner.sessionId, alreadyLinked: true } };
      if (snapshot.sessions.some(session => session.id === input.sessionId)) return fail('conflict', 'This imported conversation already has a different owner.');
      const provider = this.options.providers.enabledAdapter(snapshot, input.providerId);
      if (!provider.ok) return fail('provider-unavailable', provider.message);
      return { value: { ok: true, sessionId: input.sessionId, alreadyLinked: false }, commit: { mutations: [
        { kind: 'session.upsert', value: { id: input.sessionId, projectId: workspace.projectId, workspaceId: workspace.id,
          kind: 'agent', title: input.title, state: 'starting', source: 'structured' } },
        { kind: 'agent.upsert', value: { sessionId: input.sessionId, providerId: input.providerId, providerSessionId: input.providerSessionId,
          ...(input.model ? { model: input.model } : {}), permissionPreset: input.permissionPreset,
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), state: 'starting', queuedTurnCount: 0,
          orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled } },
        ...this.transcriptMutations(input.transcript),
        { kind: 'migration-receipt.record', value: { id: stableId('native-history', input.historyId), source: 'native-history-adoption',
          fingerprint: stableId('native-history-source', input.providerId, input.providerSessionId), detail: {
            historyId: input.historyId, providerId: input.providerId, providerSessionId: input.providerSessionId,
            sessionId: input.sessionId, workspaceId: workspace.id, rootPath: input.rootPath, sourceUpdatedAt: input.sourceUpdatedAt,
          } } },
        ...(input.requestReceipt ? [{ kind: 'migration-receipt.record' as const, value: { ...input.requestReceipt, source: 'history-resume-request', detail: { sessionId: input.sessionId } } }] : []),
      ] } };
    });
    const result = receipt?.value ?? { ok: false as const, reason: 'unavailable' as const, message: 'History adoption could not be committed.' };
    if (result.ok && !result.alreadyLinked) this.runProviderHandleBackground('attach imported history', input.providerId, input.providerSessionId,
      () => this.rehydrateSession(input.sessionId));
    return result;
  }

  private async create(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.create') return commandError('invalid-command', 'Unexpected Agent create command.');
    const { snapshot } = context;
    const workspace = findActiveDaemonWorkspace(snapshot, command.payload.workspaceId);
    if (!workspace) return commandError('not-found', 'Active Workspace was not found.');
    if (snapshot.sessions.some((entry) => entry.id === command.payload.sessionId)) {
      return commandError('invalid-state', 'Session already exists.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, command.payload.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const relation = command.payload.parentSessionId
      ? this.planChildRelation(snapshot, command.payload.parentSessionId, workspace.projectId, command.principal)
      : undefined;
    if (relation && !relation.ok) return relation.result;

    const turnId = stableId('turn', command.commandId);
    const now = this.isoNow();
    const mutations: DaemonStoreMutation[] = [
      { kind: 'session.upsert', value: {
        id: command.payload.sessionId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        kind: 'agent',
        title: command.payload.title,
        state: 'idle',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId: command.payload.sessionId,
        providerId: command.payload.providerId,
        ...(command.payload.model ? { model: command.payload.model } : {}),
        ...(command.payload.reasoningEffort ? { reasoningEffort: command.payload.reasoningEffort } : {}),
        permissionPreset: command.payload.permissionPreset,
        state: command.payload.initialPrompt ? 'queued' : 'idle',
        queuedTurnCount: command.payload.initialPrompt ? 1 : 0,
        orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled && !this.options.preparedSessionSettings?.(command.payload.sessionId),
      } },
    ];
    if (relation?.ok) {
      // The child's first row names where it came from; turn-finished reads it to report back.
      const parent = snapshot.sessions.find((entry) => entry.id === command.payload.parentSessionId);
      mutations.push(...this.transcriptMutations([{
        id: managedChildOriginId(command.payload.sessionId),
        sessionId: command.payload.sessionId,
        kind: 'notice',
        text: `Started from: ${parent?.title ?? command.payload.parentSessionId}`,
        isDelta: false,
        isSensitive: false,
        createdAt: now,
        relatedSessionId: command.payload.parentSessionId!,
        payload: { v: 1, type: 'subagent', role: 'link', parentSessionId: command.payload.parentSessionId!,
          ...(command.payload.reportBack ? { reportBack: true } : {}) },
      }]));
    }
    if (command.payload.initialPrompt) mutations.push(
      { kind: 'turn.upsert', value: {
        id: turnId,
        sessionId: command.payload.sessionId,
        commandId: command.commandId,
        enqueueSequence: command.expectedRevision + 1,
        state: 'queued',
      } },
      ...this.transcriptMutations([this.userTranscript(
        command.payload.sessionId,
        turnId,
        command.commandId,
        command.payload.initialPrompt,
        now,
      )]),
    );
    if (relation?.ok) {
      mutations.push({ kind: 'agent-relation.upsert', value: {
        id: stableId('relation', relation.value.treeId, command.payload.sessionId),
        treeId: relation.value.treeId,
        parentSessionId: command.payload.parentSessionId!,
        childSessionId: command.payload.sessionId,
        owner: 'managed',
        depth: relation.value.depth,
      } });
    }
    return { ok: true, commit: { mutations }, ...(command.payload.initialPrompt ? { afterCommit: () => this.queuePump() } : {}) };
  }

  private async resume(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.resume') return commandError('invalid-command', 'Unexpected Agent resume command.');
    const { snapshot } = context;
    const workspace = findActiveDaemonWorkspace(snapshot, command.payload.workspaceId);
    if (!workspace) return commandError('not-found', 'Active Workspace was not found.');
    if (snapshot.sessions.some((entry) => entry.id === command.payload.sessionId)) {
      return commandError('invalid-state', 'Session already exists.');
    }
    const sourceSession = snapshot.sessions.find((entry) => entry.id === command.payload.sourceSessionId);
    const sourceAgent = snapshot.agents.find((entry) => entry.sessionId === command.payload.sourceSessionId);
    if (!sourceSession || sourceSession.kind !== 'agent' || !sourceAgent) {
      return commandError('not-found', 'Source Agent Session was not found.');
    }
    if (snapshot.agentRelations.some((entry) => (
      entry.childSessionId === sourceSession.id && entry.owner === 'provider-native'
    ))) {
      return commandError('invalid-state', 'Provider-native subagents cannot transfer Provider Session ownership.');
    }
    if (!TERMINAL_SESSION_STATES.has(sourceSession.state) || !TERMINAL_AGENT_STATES.has(sourceAgent.state)) {
      return commandError('invalid-state', 'Only a stopped source Agent Session can be resumed.');
    }
    if (!sourceAgent.providerSessionId) {
      return commandError('invalid-state', 'The source Agent no longer owns a resumable Provider Session.');
    }
    if (
      sourceAgent.providerId !== command.payload.providerId
      || sourceAgent.providerSessionId !== command.payload.providerSessionId
    ) {
      return commandError('invalid-state', 'The Provider Session does not match the source Agent owner.');
    }
    if (workspace.projectId !== sourceSession.projectId) {
      return commandError('invalid-state', 'A resumed Agent must remain in the source Project.');
    }
    if (snapshot.agents.some((entry) => (
      entry.sessionId !== sourceAgent.sessionId
      && entry.providerId === sourceAgent.providerId
      && entry.providerSessionId === sourceAgent.providerSessionId
    ))) {
      return commandError('invalid-state', 'The Provider Session is already claimed by another Agent.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, command.payload.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const providerAdapter = provider.value;
    const providerSessionId = sourceAgent.providerSessionId;
    const relation = command.payload.parentSessionId
      ? this.planChildRelation(snapshot, command.payload.parentSessionId, workspace.projectId, command.principal)
      : undefined;
    if (relation && !relation.ok) return relation.result;
    const mutations: DaemonStoreMutation[] = [
      { kind: 'agent.upsert', value: agentInput(sourceAgent, { providerSessionId: undefined }) },
      { kind: 'session.upsert', value: {
        id: command.payload.sessionId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        kind: 'agent',
        title: command.payload.title,
        state: 'starting',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId: command.payload.sessionId,
        providerId: command.payload.providerId,
        providerSessionId: command.payload.providerSessionId,
        ...(command.payload.model ? { model: command.payload.model } : {}),
        permissionPreset: command.payload.permissionPreset,
        ...(command.payload.reasoningEffort ? { reasoningEffort: command.payload.reasoningEffort } : {}),
        state: 'starting',
        queuedTurnCount: 0,
        orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled,
      } },
    ];
    // A continuation keeps the entire visible conversation, even when the provider excludes
    // old turns from resume responses. Read every bounded page and preserve delta message identity.
    let afterSequence = 0;
    mutations.push({ kind: 'migration-receipt.record', value: { id: stableId('history-continuation', command.payload.sessionId), source: 'history-continuation',
      fingerprint: stableId('history-continuation', sourceSession.id, command.payload.sessionId),
      detail: { sourceSessionId: sourceSession.id, sessionId: command.payload.sessionId, projectId: sourceSession.projectId } } });
    for (;;) {
      const items = this.options.readTranscript(sourceSession.id, afterSequence, 500);
      if (items.length === 0) break;
      mutations.push(...this.transcriptMutations(items.map(item => ({
        id: stableId('history-message', command.payload.sessionId, item.id), sessionId: command.payload.sessionId,
        messageId: item.messageId ?? item.id,
        kind: item.kind, text: item.text, isDelta: item.isDelta, isSensitive: item.isSensitive, createdAt: item.createdAt,
        ...(item.context ? { context: item.context } : {}), ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}),
        ...(item.payload ? { payload: item.payload } : {}),
      }))));
      const next = items.at(-1)!.sequence;
      if (next <= afterSequence) return commandError('invalid-state', 'The source transcript cursor did not advance.');
      afterSequence = next;
    }
    if (relation?.ok) {
      mutations.push({ kind: 'agent-relation.upsert', value: {
        id: stableId('relation', relation.value.treeId, command.payload.sessionId),
        treeId: relation.value.treeId,
        parentSessionId: command.payload.parentSessionId!,
        childSessionId: command.payload.sessionId,
        owner: 'managed',
        depth: relation.value.depth,
      } });
    }
    return {
      ok: true,
      commit: { mutations },
      afterCommit: () => this.runProviderHandleBackground(
        `resume Agent ${command.payload.sessionId}`,
        command.payload.providerId,
        providerSessionId,
        async () => {
          try {
            await providerAdapter.disposeSession(sourceSession.id, providerSessionId);
          } catch (error) {
            this.report(`dispose source Provider Session ${sourceSession.id} before resume`, error);
          }
          await this.rehydrateSession(command.payload.sessionId);
        },
      ),
    };
  }

  private async submit(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
    interruptFirst: boolean,
  ): Promise<DaemonCommandExecutionResult> {
    const expected = interruptFirst ? 'agent.interrupt-and-submit' : 'agent.submit';
    if (command.type !== expected) return commandError('invalid-command', `Unexpected ${expected} command.`);
    if (this.options.preparedSessionSettings?.(command.payload.sessionId)
      && command.principal.id !== 'planning-runtime' && command.principal.id !== 'planning-result-runtime' && command.principal.id !== 'planning-ai-runtime') {
      return commandError('invalid-state', 'This conversation belongs to a frozen execution attempt. Use a new task or the execution retry controls for additional instructions.');
    }
    const snapshot = context.snapshot;
    const session = snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent || session.kind !== 'agent') {
      return commandError('not-found', 'Agent Session was not found.');
    }
    if (this.options.conversationWritable && !await this.options.conversationWritable(session.projectId, session.id)) {
      return commandError('invalid-state', 'This stage or workflow is archived. Restore it or explicitly unlink the conversation before sending.');
    }
    const workspace = findActiveDaemonWorkspace(snapshot, session.workspaceId, session.projectId);
    if (!workspace) {
      return commandError('not-found', 'Active Workspace was not found.');
    }
    const suppliedContext = command.payload.context;
    if (suppliedContext?.workflow) return commandError('invalid-command', 'Stage reference snapshots are resolved by the host, not supplied by a client.');
    let messageContext = suppliedContext;
    try {
      const workflow = await this.options.conversationContext?.(session.projectId, session.id);
      if (workflow) messageContext = { ...suppliedContext, workflow };
    } catch (error) { return commandError('invalid-state', error instanceof Error ? error.message : 'The saved stage references are unavailable.'); }
    const contextError = messageContext && validateChatMessageContext(messageContext);
    if (contextError) return commandError('invalid-command', contextError);
    if (messageContext) {
      const protocol = snapshot.providers.find((entry) => entry.id === agent.providerId)?.protocol;
      if (protocol !== 'codex-app-server' && protocol !== 'claude-agent-sdk') {
        return commandError('invalid-command', 'This provider does not support message attachments or replies.');
      }
      if (messageContext.replyTo && !this.isValidReply(session.id, messageContext.replyTo)) {
        return commandError('invalid-command', 'The quoted message is unavailable or does not match this conversation.');
      }
    }
    if (['archived', 'done', 'interrupted', 'error'].includes(agent.state)) {
      return commandError('invalid-state', 'Agent Session is not available for a new turn.');
    }
    let reportPayload: DaemonTranscriptItemInput['payload'];
    const reportOf = command.type === 'agent.submit' ? command.payload.reportOf : undefined;
    if (reportOf) {
      const child = snapshot.sessions.find((entry) => entry.id === reportOf);
      const managed = snapshot.agentRelations.some((relation) => (
        relation.childSessionId === reportOf && relation.parentSessionId === session.id
        && relation.owner === 'managed' && relation.detachedAt === undefined
      ));
      if (command.principal.id !== REPORT_BACK_PRINCIPAL || !child || !managed || !reportBackRequested(this.options.readTranscript, child.id, session.id)) {
        return commandError('invalid-command', 'Only a delegated child asked to report back can send its result to this conversation.');
      }
      const last = latestFinishedTurn(snapshot.turns, child.id);
      reportPayload = { v: 1, type: 'subagent', role: 'result', childSessionId: child.id, title: child.title, state: last?.state === 'failed' ? 'error' : 'done' };
    }
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const currentTurn = agent.currentTurnId
      ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    const hasActiveCurrentTurn = Boolean(currentTurn && ACTIVE_TURN_STATES.has(currentTurn.state));
    const turnId = stableId('turn', command.commandId);
    const now = this.isoNow();
    const proposals = snapshot.approvals.filter((approval) => (
      approval.sessionId === session.id && approval.state === 'pending' && approval.providerRequestId.startsWith(PROPOSED_PLAN_REQUEST_PREFIX)
    ));
    const mutations: DaemonStoreMutation[] = [{ kind: 'turn.upsert', value: {
      id: turnId,
      sessionId: session.id,
      commandId: command.commandId,
      enqueueSequence: command.expectedRevision + 1,
      state: 'queued',
    } }, ...proposals.map((approval): DaemonStoreMutation => ({
      kind: 'approval.upsert', value: this.resolvedApprovalInput(approval, 'expired', now),
    }))];
    if (interruptFirst && currentTurn && hasActiveCurrentTurn) {
      mutations.push({ kind: 'turn.upsert', value: turnInput(currentTurn, {
        state: 'delivery-uncertain',
        errorCode: 'interrupt-requested',
      }) });
    }
    mutations.push(
      { kind: 'agent.upsert', value: agentInput(agent, {
        state: interruptFirst && hasActiveCurrentTurn ? 'delivery-uncertain' : hasActiveCurrentTurn ? agent.state : 'queued',
        ...(!hasActiveCurrentTurn ? { currentTurnId: undefined } : {}),
        queuedTurnCount: agent.queuedTurnCount + 1,
      }) },
      ...(interruptFirst && hasActiveCurrentTurn
        ? [{ kind: 'session.upsert' as const, value: sessionInput(session, 'delivery-uncertain') }]
        : []),
      ...this.transcriptMutations([{
        ...this.userTranscript(
          session.id,
          turnId,
          command.commandId,
          command.payload.prompt,
          now,
          messageContext,
          messageContext?.replyTo ? this.replyAnchorIsSensitive(session.id, messageContext.replyTo) : false,
        ),
        ...(reportPayload ? { payload: reportPayload } : {}),
      }]),
    );
    return {
      ok: true,
      commit: { mutations },
      afterCommit: () => {
        for (const approval of proposals) {
          if (agent.providerSessionId) this.runBackground(`retire proposed plan ${approval.id}`, async () => { await this.resolveProviderApproval(
            agent.providerId, session.id, agent.providerSessionId!, approval.providerRequestId, 'deny'); });
        }
        if (interruptFirst && currentTurn && hasActiveCurrentTurn && agent.providerSessionId) {
          this.runBackground(
            `interrupt Agent ${session.id}`,
            () => this.requestInterrupt(session.id, currentTurn.id, agent.providerId, agent.providerSessionId!),
          );
        } else {
          this.queuePump();
        }
      },
    };
  }

  /** Runs under the same command/store gate as dispatch, so a taken turn cannot start. */
  private async manageQueue(command: DaemonCommand, context: DaemonCommandExecutionContext): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.queue') return commandError('invalid-command', 'Unexpected queue command.');
    const { sessionId, turnId, turnRevision, action } = command.payload;
    const snapshot = context.snapshot;
    const session = snapshot.sessions.find(item => item.id === sessionId);
    const agent = snapshot.agents.find(item => item.sessionId === sessionId);
    const turn = snapshot.turns.find(item => item.id === turnId && item.sessionId === sessionId);
    if (!session || !agent || !turn) return commandError('not-found', 'The queued request was not found.');
    if (TERMINAL_SESSION_STATES.has(session.state) || TERMINAL_AGENT_STATES.has(agent.state)
      || snapshot.projects.find(item => item.id === session.projectId)?.archivedAt
      || snapshot.workspaces.find(item => item.id === session.workspaceId)?.archivedAt) return commandError('invalid-state', 'This conversation is not writable.');
    if (this.options.conversationWritable && !await this.options.conversationWritable(session.projectId, sessionId)) return commandError('invalid-state', 'This conversation is read-only.');
    if (turn.state !== 'queued' || turn.revision !== turnRevision) return commandError('invalid-state', 'This request has changed or already started. Refresh the queue.');
    const queued = snapshot.turns.filter(item => item.sessionId === sessionId && item.state === 'queued');
    const mutations: DaemonStoreMutation[] = [];
    const current = snapshot.turns.find(item => item.id === agent.currentTurnId && ACTIVE_TURN_STATES.has(item.state));
    let afterInterrupt: (() => void) | undefined;
    if (action === 'run-next') {
      if (agent.state === 'delivery-uncertain') return commandError('invalid-state', 'Resolve the current delivery before interrupting again.');
      const interrupt = this.interruptActiveTurn(snapshot, sessionId);
      if (!interrupt.ok) return interrupt;
      afterInterrupt = interrupt.afterCommit;
      // Rotate existing FIFO positions, keeping every other request in order.
      const ordered = queued.slice().sort((a, b) => (a.enqueueSequence ?? a.revision) - (b.enqueueSequence ?? b.revision));
      const positions = ordered.map(item => item.enqueueSequence ?? item.revision);
      [turn, ...ordered.filter(item => item.id !== turnId)].forEach((item, index) => {
        mutations.push({ kind: 'turn.queue-position', turnId: item.id, sessionId, position: positions[index] });
      });
      mutations.push(...(interrupt.commit?.mutations ?? []));
    } else {
      mutations.push({ kind: 'turn.upsert', value: turnInput(turn, { state: 'interrupted', finishedAt: this.isoNow(), errorCode: action === 'take' ? 'queue-taken' : 'queue-removed' }) });
      mutations.push({ kind: 'agent.upsert', value: agentInput(agent, { queuedTurnCount: queued.length - 1, ...(!current ? { state: queued.length > 1 ? 'queued' : 'idle' } : {}) }) });
    }
    return { ok: true, commit: { mutations }, afterCommit: () => {
      if (afterInterrupt) afterInterrupt(); else this.queuePump();
    } };
  }

  private async interrupt(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.interrupt') return commandError('invalid-command', 'Unexpected Agent interrupt command.');
    return this.interruptActiveTurn(context.snapshot, command.payload.sessionId);
  }

  private async setSettings(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.set-settings') return commandError('invalid-command', 'Unexpected Agent settings command.');
    const payload = command.payload;
    if (this.options.preparedSessionSettings?.(payload.sessionId)) {
      return commandError('invalid-state', 'Prepared execution settings are immutable. Prepare a new run to change the provider, model, or permissions.');
    }
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === payload.sessionId);
    if (!agent) return commandError('not-found', 'Agent Session was not found.');
    if (TERMINAL_AGENT_STATES.has(agent.state)) return commandError('invalid-state', 'Agent Session has ended.');
    const pending = this.pendingSettings.get(agent.sessionId);
    const changesModelOrAccess = payload.model !== undefined || payload.permissionPreset !== undefined;
    if (payload.clearPending) {
      if (changesModelOrAccess || payload.reasoningEffort !== undefined || payload.scope !== undefined) {
        return commandError('invalid-command', 'Clearing queued settings takes no other change.');
      }
      if (!pending) return { ok: true };
      const running = { runningEffort: pending.runningEffort, runningTurnId: pending.runningTurnId };
      return { ok: true, afterCommit: () => this.setPending(agent.sessionId, running) };
    }
    const once = payload.scope === 'once';
    if (once && (payload.reasoningEffort === undefined || changesModelOrAccess)) {
      return commandError('invalid-command', 'Only an effort can apply to the next request alone.');
    }
    const effortOnly = payload.reasoningEffort !== undefined && !changesModelOrAccess;
    // A person's change during a turn waits for the next request; an agent still changes its child between turns.
    const person = command.principal.kind === 'desktop' || command.principal.kind === 'android';
    const turnRunning = Boolean(agent.currentTurnId);
    if (turnRunning && !effortOnly && !person) return commandError('invalid-state', 'Change Agent settings between turns.');
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    // 단계 연결: entering plan mode takes the plan agent's effort, leaving it the implement agent's. An effort the
    // person chose (now or queued) wins over the link.
    const accessNow = pending?.permissionPreset ?? agent.permissionPreset;
    const phase = payload.permissionPreset === undefined || payload.permissionPreset === accessNow ? undefined
      : payload.permissionPreset === 'plan' ? 'plan' as const : accessNow === 'plan' ? 'implement' as const : undefined;
    const linked = phase && !this.options.preparedSessionSettings?.(agent.sessionId) ? this.options.phaseSettings?.(agent.providerId, phase) : undefined;
    const model = payload.model ?? linked?.model;
    const effort = payload.reasoningEffort ?? (pending?.reasoningEffort ? undefined : linked?.reasoningEffort);

    // An effort picked in the input box (sent with a scope) also waits while idle: its scope can still change.
    if (turnRunning || once || (effortOnly && payload.scope !== undefined)) {
      const next: { -readonly [K in keyof DaemonPendingAgentSettings]: DaemonPendingAgentSettings[K] } = { ...pending };
      if (model !== undefined) next.model = model;
      if (payload.permissionPreset !== undefined) next.permissionPreset = payload.permissionPreset;
      if (effort !== undefined) {
        next.reasoningEffort = effort;
        next.effortScope = once ? 'once' : 'keep';
      }
      // A value the record already runs with waits for nothing.
      if (next.model === agent.model) next.model = undefined;
      if (next.permissionPreset === agent.permissionPreset) next.permissionPreset = undefined;
      if (next.reasoningEffort === agent.reasoningEffort) {
        next.reasoningEffort = undefined;
        next.effortScope = undefined;
      }
      return { ok: true, afterCommit: () => this.setPending(agent.sessionId, next) };
    }

    const nextModel = model ?? agent.model;
    const nextPermissionPreset = payload.permissionPreset ?? agent.permissionPreset;
    const nextEffort = effort ?? agent.reasoningEffort;
    const applyToProvider = model !== undefined || payload.permissionPreset !== undefined;
    // What this change sets no longer waits for the next request.
    const remaining = pending ? {
      ...pending,
      ...(model !== undefined ? { model: undefined } : {}),
      ...(payload.permissionPreset !== undefined ? { permissionPreset: undefined } : {}),
      ...(effort !== undefined ? { reasoningEffort: undefined, effortScope: undefined } : {}),
    } : undefined;
    return {
      ok: true,
      commit: { mutations: [{ kind: 'agent.upsert', value: agentInput(agent, {
        ...(nextModel ? { model: nextModel } : {}),
        ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
        permissionPreset: nextPermissionPreset,
      }) }] },
      // In the session's provider queue: a message sent right after waits for the new settings (a
      // Claude switch to Full access may relaunch the provider session).
      afterCommit: () => {
        if (pending) this.setPending(agent.sessionId, remaining);
        if (applyToProvider && agent.providerSessionId && this.attachedProviderSessions.has(agent.sessionId)) {
          this.runProviderHandleBackground(
            `update Agent settings ${agent.sessionId}`,
            agent.providerId,
            agent.providerSessionId,
            () => this.applyProviderSettings(
              agent.sessionId,
              agent.providerId,
              agent.providerSessionId!,
              nextModel,
              nextPermissionPreset,
            ),
          );
        }
      },
    };
  }

  private async cancel(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.cancel') return commandError('invalid-command', 'Unexpected Agent cancel command.');
    const snapshot = context.snapshot;
    const session = snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent || session.kind !== 'agent') {
      return commandError('not-found', 'Agent Session was not found.');
    }
    if (TERMINAL_SESSION_STATES.has(session.state) || TERMINAL_AGENT_STATES.has(agent.state)) {
      return commandError('invalid-state', 'Agent Session is not available for cancellation.');
    }
    const currentTurn = agent.currentTurnId
      ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    const activeCurrentTurn = currentTurn && ACTIVE_TURN_STATES.has(currentTurn.state)
      ? currentTurn
      : undefined;
    const queuedTurns = snapshot.turns.filter((turn) => (
      turn.sessionId === session.id && turn.state === 'queued'
    ));
    if (!activeCurrentTurn && queuedTurns.length === 0 && agent.queuedTurnCount === 0) return { ok: true };

    const now = this.isoNow();
    const queuedMutations = queuedTurns.map((turn): DaemonStoreMutation => ({
      kind: 'turn.upsert',
      value: turnInput(turn, { state: 'interrupted', finishedAt: now, errorCode: 'cancelled' }),
    }));
    if (!activeCurrentTurn || !agent.providerSessionId) {
      return {
        ok: true,
        commit: { mutations: [
          ...queuedMutations,
          ...(activeCurrentTurn ? [{
            kind: 'turn.upsert' as const,
            value: turnInput(activeCurrentTurn, {
              state: 'interrupted',
              finishedAt: now,
              errorCode: 'cancelled',
            }),
          }] : []),
          ...this.expireApprovalMutations(snapshot, session.id, activeCurrentTurn?.id, now),
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: 'idle',
            currentTurnId: undefined,
            queuedTurnCount: 0,
          }) },
          { kind: 'session.upsert', value: sessionInput(session, 'idle') },
        ] },
        afterCommit: () => {
          this.queuePump();
        },
      };
    }

    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) {
      return {
        ok: true,
        commit: { mutations: [
          ...queuedMutations,
          { kind: 'turn.upsert', value: turnInput(activeCurrentTurn, {
            state: 'delivery-uncertain',
            errorCode: 'cancel-provider-unavailable',
          }) },
          ...this.expireApprovalMutations(snapshot, session.id, activeCurrentTurn.id, now),
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: 'delivery-uncertain',
            queuedTurnCount: 0,
          }) },
          { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
        ] },
      };
    }
    return {
      ok: true,
      commit: { mutations: [
        ...queuedMutations,
        { kind: 'turn.upsert', value: turnInput(activeCurrentTurn, {
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
        }) },
        ...this.expireApprovalMutations(snapshot, session.id, activeCurrentTurn.id, now),
        { kind: 'agent.upsert', value: agentInput(agent, {
          state: 'delivery-uncertain',
          queuedTurnCount: 0,
        }) },
        { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
      ] },
      afterCommit: () => this.runBackground(
        `cancel Agent ${session.id}`,
        () => this.requestInterrupt(session.id, activeCurrentTurn.id, agent.providerId, agent.providerSessionId!),
      ),
    };
  }

  /**
   * Interrupt is a turn-scoped cooperative request. Queued turns and the
   * provider Session stay intact; a pre-handle claim can be settled locally
   * because no provider turn can have been submitted yet.
   */
  private interruptActiveTurn(
    snapshot: DaemonSnapshot,
    sessionId: string,
  ): DaemonCommandExecutionResult {
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!session || !agent || session.kind !== 'agent') {
      return commandError('not-found', 'Agent Session was not found.');
    }
    if (TERMINAL_SESSION_STATES.has(session.state) || TERMINAL_AGENT_STATES.has(agent.state)) {
      return commandError('invalid-state', 'Agent Session is not available for interruption.');
    }
    const currentTurn = agent.currentTurnId
      ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    if (!currentTurn || !ACTIVE_TURN_STATES.has(currentTurn.state)) return { ok: true };

    if (!agent.providerSessionId) {
      const now = this.isoNow();
      return {
        ok: true,
        commit: { mutations: [
          { kind: 'turn.upsert', value: turnInput(currentTurn, {
            state: 'interrupted',
            finishedAt: now,
            errorCode: undefined,
          }) },
          ...this.expireApprovalMutations(snapshot, session.id, currentTurn.id, now),
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: agent.queuedTurnCount > 0 ? 'queued' : 'idle',
            currentTurnId: undefined,
          }) },
          { kind: 'session.upsert', value: sessionInput(session, 'idle') },
        ] },
        afterCommit: () => {
          this.queuePump();
        },
      };
    }

    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    return {
      ok: true,
      commit: { mutations: [
        { kind: 'turn.upsert', value: turnInput(currentTurn, {
          state: 'delivery-uncertain',
          errorCode: 'interrupt-requested',
        }) },
        { kind: 'agent.upsert', value: agentInput(agent, { state: 'delivery-uncertain' }) },
        { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
      ] },
      afterCommit: () => this.runBackground(
        `interrupt Agent turn ${session.id}`,
        () => this.requestInterrupt(session.id, currentTurn.id, agent.providerId, agent.providerSessionId!),
      ),
    };
  }

  private async archive(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.archive') return commandError('invalid-command', 'Unexpected Agent archive command.');
    const session = context.snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent) return commandError('not-found', 'Agent Session was not found.');
    const hasUnsettledTurns = context.snapshot.turns.some((turn) => (
      turn.sessionId === session.id && !TERMINAL_TURN_STATES.has(turn.state)
    ));
    if (agent.currentTurnId || agent.queuedTurnCount > 0 || hasUnsettledTurns) {
      return commandError('invalid-state', 'Stop the Agent and clear queued turns before archiving it.');
    }
    const now = this.isoNow();
    const pendingApprovals = context.snapshot.approvals.filter((approval) => (
      approval.sessionId === session.id && approval.state === 'pending'
    ));
    const providerSessionId = agent.providerSessionId;
    const selectedProvider = providerSessionId
      ? this.options.providers.enabledAdapter(context.snapshot, agent.providerId)
      : undefined;
    const providerAdapter = selectedProvider?.ok ? selectedProvider.value : undefined;
    return { ok: true, commit: { mutations: [
      ...pendingApprovals.map((approval): DaemonStoreMutation => ({
        kind: 'approval.upsert',
        value: this.resolvedApprovalInput(approval, 'expired', now),
      })),
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'archived', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'archived', now) },
    ] }, ...(providerSessionId && providerAdapter ? { afterCommit: () => this.runProviderHandleBackground(
      `archive Agent ${session.id}`,
      agent.providerId,
      providerSessionId,
      () => this.disposeProviderSession(providerAdapter, session.id, providerSessionId),
    ) } : {}) };
  }

  /** Work that must finish before a conversation's provider can be released. */
  private releaseBlocked(snapshot: DaemonSnapshot, sessionId: string): boolean {
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent || ACTIVE_AGENT_STATES.has(agent.state) || agent.currentTurnId || agent.queuedTurnCount > 0) return true;
    if (snapshot.turns.some((turn) => turn.sessionId === sessionId && !TERMINAL_TURN_STATES.has(turn.state))) return true;
    if (snapshot.approvals.some((approval) => approval.sessionId === sessionId && approval.state === 'pending')) return true;
    // A provider-native subagent still working lives in the same provider session.
    return snapshot.agentRelations.some((relation) => relation.parentSessionId === sessionId && relation.owner === 'provider-native'
      && !relation.detachedAt && snapshot.agents.some((child) => child.sessionId === relation.childSessionId && ACTIVE_AGENT_STATES.has(child.state)));
  }

  /**
   * `/clear` (Desktop): stops the live provider of an idle conversation another one replaced in its
   * tab. Nothing stored changes; the next message reattaches it, as after a restart.
   */
  private release(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'agent.release') return commandError('invalid-command', 'Unexpected Agent release command.');
    const sessionId = command.payload.sessionId;
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent || !context.snapshot.sessions.some((entry) => entry.id === sessionId)) return commandError('not-found', 'Agent Session was not found.');
    if (this.releaseBlocked(context.snapshot, sessionId)) return commandError('invalid-state', 'Release the Agent only once it is idle.');
    const providerSessionId = agent.providerSessionId;
    const selected = providerSessionId ? this.options.providers.enabledAdapter(context.snapshot, agent.providerId) : undefined;
    const provider = selected?.ok ? selected.value : undefined;
    if (!providerSessionId || !provider || !this.attachedProviderSessions.has(sessionId)) return { ok: true, commit: { mutations: [] } };
    return { ok: true, commit: { mutations: [] }, afterCommit: () => this.runProviderHandleBackground(
      `release Agent ${sessionId}`,
      agent.providerId,
      providerSessionId,
      async () => {
        // A message may have arrived meanwhile; release only what is still idle and attached.
        const current = this.options.getSnapshot();
        if (!this.attachedProviderSessions.has(sessionId) || this.releaseBlocked(current, sessionId)
          || current.agents.find((entry) => entry.sessionId === sessionId)?.providerSessionId !== providerSessionId) return;
        await this.disposeProviderSession(provider, sessionId, providerSessionId);
      },
    ) };
  }

  private detach(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'agent.detach') return commandError('invalid-command', 'Unexpected Agent detach command.');
    const snapshot = context.snapshot;
    const relation = snapshot.agentRelations.find((entry) => (
      entry.childSessionId === command.payload.sessionId && !entry.detachedAt
    ));
    if (!relation) return commandError('not-found', 'Managed Agent relation was not found.');
    if (relation.owner !== 'managed') {
      return commandError('invalid-state', 'Provider-native subagents are provider-owned and read-only.');
    }

    const rootSessionId = relation.childSessionId;
    const activeRelations = snapshot.agentRelations.filter((entry) => entry.detachedAt === undefined);
    const depths = new Map<string, number>([[rootSessionId, 0]]);
    const frontier = [rootSessionId];
    const descendants: { readonly relation: typeof relation; readonly depth: number }[] = [];
    while (frontier.length > 0) {
      const parentSessionId = frontier.shift()!;
      const parentDepth = depths.get(parentSessionId)!;
      for (const descendant of activeRelations) {
        if (descendant.id === relation.id || descendant.parentSessionId !== parentSessionId) continue;
        if (depths.has(descendant.childSessionId)) {
          return commandError('invalid-state', 'Managed Agent relations do not form a detachable tree.');
        }
        const depth = parentDepth + 1;
        depths.set(descendant.childSessionId, depth);
        descendants.push({ relation: descendant, depth });
        frontier.push(descendant.childSessionId);
      }
    }

    // Detached relation records are retained as recent-creation history. Move
    // records created by parents in this subtree too, without traversing into
    // the already-detached child trees.
    const detachedHistory = snapshot.agentRelations.filter((entry) => (
      entry.id !== relation.id
      && entry.detachedAt !== undefined
      && depths.has(entry.parentSessionId)
    ));
    const now = this.isoNow();
    const rebase = [
      ...descendants.map(({ relation: descendant, depth }): DaemonStoreMutation => ({
        kind: 'agent-relation.upsert',
        value: {
          id: descendant.id,
          treeId: rootSessionId,
          parentSessionId: descendant.parentSessionId,
          childSessionId: descendant.childSessionId,
          owner: descendant.owner,
          depth,
        },
      })),
      ...detachedHistory.map((historical): DaemonStoreMutation => ({
        kind: 'agent-relation.upsert',
        value: {
          id: historical.id,
          treeId: rootSessionId,
          parentSessionId: historical.parentSessionId,
          childSessionId: historical.childSessionId,
          owner: historical.owner,
          depth: depths.get(historical.parentSessionId)! + 1,
          detachedAt: historical.detachedAt,
        },
      })),
    ];
    return { ok: true, commit: { mutations: [
      { kind: 'agent-relation.upsert', value: {
        id: relation.id,
        treeId: relation.treeId,
        parentSessionId: relation.parentSessionId,
        childSessionId: relation.childSessionId,
        owner: relation.owner,
        depth: relation.depth,
        detachedAt: now,
      } },
      ...rebase,
    ] } };
  }

  private async resolveApproval(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'permission.resolve') return commandError('invalid-command', 'Unexpected approval command.');
    const approval = context.snapshot.approvals.find((entry) => entry.id === command.payload.approvalId);
    if (!approval || approval.state !== 'pending') return commandError('not-found', 'Pending approval was not found.');
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === approval.sessionId);
    const session = context.snapshot.sessions.find((entry) => entry.id === approval.sessionId);
    if (!agent?.providerSessionId) return commandError('invalid-state', 'Approval Agent is unavailable.');
    if (!session || TERMINAL_SESSION_STATES.has(session.state)) {
      return commandError('invalid-state', 'Approval Session is no longer active.');
    }
    const turn = approval.turnId
      ? context.snapshot.turns.find((entry) => entry.id === approval.turnId)
      : undefined;
    if (
      approval.turnId
      && (!turn || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== approval.turnId)
    ) {
      return commandError('invalid-state', 'Approval no longer belongs to the active turn.');
    }
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const resolvedAt = this.isoNow();
    // Approving a plan leaves plan mode for the mode the user chose; the provider switches with it.
    // Without a chosen mode (older clients) the CLI asks before running, and the preset says so.
    const planMode = command.payload.decision !== 'allow' ? undefined
      : command.payload.response?.kind === 'plan' ? command.payload.response.mode
        : approval.request?.kind === 'plan' ? 'standard' as const : undefined;
    // 단계 연결: an approved plan is implemented by the implement agent of this AI. Codex sends the
    // follow-up as a new request, so it starts with it. Claude would continue the same turn, so when the
    // link changes something its plan turn ends at the approval and the implementation is sent as the
    // next request (the adapter's approvePlanEndingTurn). Settings the person queued win.
    // A prepared (workflow) session keeps the settings its run fixed.
    const implement = command.payload.decision === 'allow' && approval.request?.kind === 'plan' && !this.options.preparedSessionSettings?.(agent.sessionId)
      ? this.options.phaseSettings?.(agent.providerId, 'implement')
      : undefined;
    /** Whether the link queued anything for the next request. */
    const queueImplement = (): boolean => {
      if (!implement) return false;
      const queued = this.pendingSettings.get(agent.sessionId);
      const model = implement.model && !queued?.model && implement.model !== agent.model ? implement.model : undefined;
      const effort = implement.reasoningEffort && !queued?.reasoningEffort && implement.reasoningEffort !== agent.reasoningEffort
        ? implement.reasoningEffort
        : undefined;
      if (!model && !effort) return false;
      this.setPending(agent.sessionId, { ...queued, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort, effortScope: 'keep' as const } : {}) });
      return true;
    };
    const proposedPlan = approval.providerRequestId.startsWith(PROPOSED_PLAN_REQUEST_PREFIX);
    const planTurnId = !proposedPlan && typeof provider.value.approvePlanEndingTurn === 'function' ? approval.turnId : undefined;
    return { ok: true, commit: { mutations: [
      { kind: 'approval.upsert', value: this.resolvedApprovalInput(
        approval,
        command.payload.decision === 'allow' ? 'allowed' : 'denied',
        resolvedAt,
      ) },
      ...(turn && !TERMINAL_TURN_STATES.has(turn.state) ? [{
        kind: 'turn.upsert' as const,
        value: turnInput(turn, { state: 'working' }),
      }] : []),
      // A subagent's request can arrive after the parent's turn: an idle parent stays idle.
      ...(turn || agent.currentTurnId
        ? [
            { kind: 'agent.upsert' as const, value: agentInput(agent, { state: 'working', ...(planMode ? { permissionPreset: planMode } : {}) }) },
            { kind: 'session.upsert' as const, value: sessionInput(session, 'running') },
          ]
        : this.pendingApprovalElsewhere(context.snapshot, approval)
          ? []
          : [
              { kind: 'agent.upsert' as const, value: agentInput(agent, { state: 'idle', ...(planMode ? { permissionPreset: planMode } : {}) }) },
              { kind: 'session.upsert' as const, value: sessionInput(session, 'idle') },
            ]),
    ] }, afterCommit: () => {
      // Only a plan turn whose implementation now starts with other settings ends at the approval.
      const endTurn = queueImplement() && planTurnId !== undefined;
      if (endTurn) this.approvedPlanFollowUps.set(planTurnId, { approvalId: approval.id, sessionId: agent.sessionId, principal: command.principal });
      this.runBackground(
        `resolve approval ${approval.id}`,
        async () => {
          const delivered = await this.resolveProviderApproval(
            agent.providerId,
            agent.sessionId,
            agent.providerSessionId!,
            approval.providerRequestId,
            command.payload.decision,
            command.payload.response,
            endTurn,
          );
          if (endTurn && !delivered) this.approvedPlanFollowUps.delete(planTurnId);
          // A plan Codex proposed: running it asks Codex to implement it; asking for changes sends them, still planning.
          if (proposedPlan) {
            const followUp = command.payload.decision === 'allow' ? IMPLEMENT_PLAN_PROMPT
              : command.payload.response?.kind === 'feedback' ? command.payload.response.message : undefined;
            if (followUp) await this.sendPlanFollowUp(approval.id, agent.sessionId, followUp, command.principal);
          }
        },
      );
    } };
  }

  /** Sends the message that follows a decision on a proposed plan, as the person who decided. */
  private async sendPlanFollowUp(approvalId: string, sessionId: string, prompt: string, principal: DaemonPrincipal): Promise<void> {
    if (!this.options.executeCommand) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.options.getSnapshot();
      const commandId = stableId('plan-follow-up', approvalId, String(snapshot.revision));
      const receipt = await this.options.executeCommand(createDaemonCommand({
        commandId, idempotencyKey: commandId, expectedRevision: snapshot.revision, issuedAt: this.isoNow(),
        principal, type: 'agent.submit', payload: { sessionId, prompt },
      }));
      if (receipt.ok || receipt.error.code !== 'revision-conflict') return;
    }
  }

  private async enableProvider(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'provider.enable' && command.type !== 'provider.update') {
      return commandError('invalid-command', 'Unexpected provider enable command.');
    }
    const authorized = await this.options.providers.authorizeEnable(
      command.payload,
      this.lifecycleAbortController.signal,
    );
    if (!authorized.ok) {
      const code = authorized.code === 'provider-incompatible'
        ? 'provider-incompatible'
        : 'provider-unavailable';
      return commandError(code, authorized.message);
    }
    const wasEnabled = context.snapshot.providers.find((provider) => (
      provider.id === command.payload.providerId
    ))?.enabled === true;
    return {
      ok: true,
      commit: { mutations: [{ kind: 'provider.upsert', value: authorized.value }] },
      afterCommit: () => {
        if (wasEnabled) {
          this.queuePump();
          return;
        }
        const lifecycleGeneration = this.advanceProviderLifecycle(command.payload.providerId);
        this.runProviderLifecycleBackground(
          `rehydrate Provider ${command.payload.providerId} after enable`,
          command.payload.providerId,
          async () => {
            if (!this.isCurrentProviderEnable(command.payload.providerId, lifecycleGeneration)) return;
            await this.rehydrateProviderSessions(command.payload.providerId, lifecycleGeneration);
            if (this.isCurrentProviderEnable(command.payload.providerId, lifecycleGeneration)) {
              this.queuePump();
            }
          },
        );
      },
    };
  }

  private disableProvider(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'provider.disable') return commandError('invalid-command', 'Unexpected provider disable command.');
    const snapshot = context.snapshot;
    const current = snapshot.providers.find((entry) => entry.id === command.payload.providerId);
    if (!current) return commandError('not-found', 'Provider was not found.');
    if (snapshot.agents.some((agent) => (
      agent.providerId === current.id && (
        agent.queuedTurnCount > 0
        || ['starting', 'queued', 'working', 'blocked', 'delivery-uncertain'].includes(agent.state)
        || snapshot.turns.some((turn) => (
          turn.sessionId === agent.sessionId && !TERMINAL_TURN_STATES.has(turn.state)
        ))
      )
    ))) return commandError('invalid-state', 'Stop active Agent Sessions before disabling their provider.');
    const providerSessions = snapshot.agents.flatMap((agent) => (
      agent.providerId === current.id && agent.providerSessionId
        ? [{ sessionId: agent.sessionId, providerSessionId: agent.providerSessionId }]
        : []
    ));
    const orchestrationSessionIds = [
      ...providerSessions.map((target) => target.sessionId),
      ...snapshot.agents
        .filter((agent) => agent.providerId === current.id && !agent.providerSessionId)
        .map((agent) => agent.sessionId),
    ];
    const selectedProvider = this.options.providers.enabledAdapter(snapshot, current.id);
    const providerAdapter = selectedProvider.ok ? selectedProvider.value : undefined;
    return {
      ok: true,
      commit: { mutations: [{ kind: 'provider.upsert', value: {
        id: current.id,
        displayName: current.displayName,
        protocol: current.protocol,
        executablePath: current.executablePath,
        executableVersion: current.executableVersion,
        argv: current.argv,
        environmentVariableNames: current.environmentVariableNames,
        capabilities: current.capabilities,
        enabled: false,
        health: 'unknown',
      } }] },
      afterCommit: () => {
        this.advanceProviderLifecycle(current.id);
        for (const target of providerSessions) this.setProviderAttached(target.sessionId, false);
        for (const sessionId of orchestrationSessionIds) {
          try {
            this.options.revokeOrchestrationForSession?.(sessionId);
          } catch (error) {
            this.report(`revoke Agent orchestration token ${sessionId}`, error);
          }
        }
        if (!providerAdapter) return;
        this.runProviderLifecycleBackground(
          `deactivate Provider ${current.id}`,
          current.id,
          () => providerAdapter.deactivate(),
        );
      },
    };
  }

  private planChildRelation(
    snapshot: DaemonSnapshot,
    parentSessionId: string,
    projectId: string,
    principal: DaemonPrincipal,
  ): { readonly ok: true; readonly value: ChildRelationPlan } | {
    readonly ok: false;
    readonly result: DaemonCommandExecutionResult;
  } {
    // A person handing work off from a chat needs no permission. An agent (MCP) needs the
    // host toggle and its own orchestration flag, which the toggle set when it was created.
    const byPerson = principal.kind === 'desktop' || principal.kind === 'android';
    if (!byPerson && !snapshot.runtime.orchestrationToolsEnabled) {
      return { ok: false, result: commandError(
        'invalid-state',
        'Enable Agent orchestration on this host before creating managed children.',
      ) };
    }
    const parent = snapshot.sessions.find((session) => session.id === parentSessionId);
    const parentAgent = snapshot.agents.find((agent) => agent.sessionId === parentSessionId);
    const providerOwned = snapshot.agentRelations.some((relation) => (
      relation.childSessionId === parentSessionId && relation.owner === 'provider-native'
    ));
    if (
      !parent
      || !parentAgent
      || parent.kind !== 'agent'
      || parent.projectId !== projectId
      || parent.archivedAt !== undefined
      || TERMINAL_SESSION_STATES.has(parent.state)
      || TERMINAL_AGENT_STATES.has(parentAgent.state)
      || (!byPerson && !parentAgent.orchestrationEnabled)
      || providerOwned
    ) {
      return { ok: false, result: commandError(
        'invalid-state',
        'A managed child requires a live, orchestration-enabled managed parent in the same Project.',
      ) };
    }
    const parentRelation = snapshot.agentRelations.find((relation) => (
      relation.childSessionId === parentSessionId && !relation.detachedAt
    ));
    const treeId = parentRelation?.treeId ?? parentSessionId;
    const depth = (parentRelation?.depth ?? 0) + 1;
    if (depth > DAEMON_HARD_LIMITS.treeDepth) {
      return { ok: false, result: commandError('tree-depth-limit', 'Managed Agent tree depth limit reached.') };
    }
    // Provider-native subagents have their own bounds; they do not use up the managed tree.
    const treeRelations = snapshot.agentRelations.filter((relation) => (
      relation.treeId === treeId && !relation.detachedAt && relation.owner === 'managed'
    ));
    const nodeIds = new Set<string>([treeId]);
    for (const relation of treeRelations) {
      nodeIds.add(relation.parentSessionId);
      nodeIds.add(relation.childSessionId);
    }
    if (nodeIds.size >= DAEMON_HARD_LIMITS.nodesPerTree) {
      return { ok: false, result: commandError('tree-node-limit', 'Managed Agent tree node limit reached.') };
    }
    const windowStart = this.now().valueOf() - DAEMON_HARD_LIMITS.childCreationWindowMs;
    const recentChildren = snapshot.agentRelations.filter((relation) => (
      relation.treeId === treeId && relation.owner === 'managed' && Date.parse(relation.createdAt) >= windowStart
    )).length;
    if (recentChildren >= DAEMON_HARD_LIMITS.childCreationsPerWindow) {
      return { ok: false, result: commandError('child-rate-limit', 'Managed Agent child creation rate limit reached.') };
    }
    return { ok: true, value: { treeId, depth } };
  }

  private sessionContext(
    sessionId: string,
    workspaceId: string,
    workspaceRoot: string,
    model: string | undefined,
    permissionPreset: DaemonAgent['permissionPreset'],
    orchestrationEnabled: boolean,
    additionalRoots?: readonly string[],
  ): ProviderSessionContext {
    const orchestration = orchestrationEnabled || this.options.workflowToolsForSession?.(sessionId)
      ? this.options.orchestrationForSession?.(sessionId)
      : undefined;
    const prepared = this.options.preparedSessionSettings?.(sessionId);
    return {
      sessionId,
      workspaceId,
      workspaceRoot,
      ...prepared,
      // A tool-free planning proposal reads no files, so it gets no extra folders either.
      ...(additionalRoots?.length && !prepared?.toolsDisabled ? { additionalRoots } : {}),
      ...(model ? { model } : {}),
      permissionPreset,
      ...(orchestration ? { orchestration } : {}),
    };
  }

  /**
   * The project's other folders this session works in, read fresh for each start, resume and
   * turn so folder edits reach a running conversation. Undefined when the host has no resolver
   * or the lookup failed: the session then keeps the folders it has.
   */
  private async additionalRootsFor(
    snapshot: Pick<DaemonSnapshot, 'projects' | 'workspaces'>,
    session: Pick<DaemonSession, 'id' | 'projectId' | 'workspaceId'>,
  ): Promise<readonly string[] | undefined> {
    const resolve = this.options.conversationFolders;
    if (!resolve) return undefined;
    if (this.options.preparedSessionSettings?.(session.id)?.toolsDisabled) return [];
    try {
      const folders = await resolve(snapshot, { projectId: session.projectId, workspaceId: session.workspaceId });
      return folders?.additional;
    } catch (error) {
      this.options.reportError?.('conversation folders', error);
      return undefined;
    }
  }

  /**
   * A delegated child that was asked to report back sends its first finished result to its
   * parent once, as the parent's next message. Nothing is planned when the child was not asked
   * to, it already reported, or the parent cannot take a turn now; the parent then keeps the
   * usual summary row.
   */
  private reportBackPlan(
    snapshot: DaemonSnapshot,
    parent: DaemonSession,
    child: DaemonSession,
    finishedTurnId: string,
    failed: boolean,
    summary: string,
  ): ReportBackPlan | undefined {
    if (!this.options.executeCommand) return undefined;
    // Once: only the child's first finished turn reports (a finished turn never finishes again).
    if (snapshot.turns.some((turn) => turn.sessionId === child.id && turn.id !== finishedTurnId
      && (turn.state === 'completed' || turn.state === 'failed'))) return undefined;
    if (!reportBackRequested(this.options.readTranscript, child.id, parent.id)) return undefined;
    const agent = snapshot.agents.find((entry) => entry.sessionId === parent.id);
    if (
      !agent
      || parent.archivedAt !== undefined
      || TERMINAL_SESSION_STATES.has(parent.state)
      || TERMINAL_AGENT_STATES.has(agent.state)
      || agent.state === 'delivery-uncertain'
      || !this.options.providers.enabledAdapter(snapshot, agent.providerId).ok
    ) return undefined;
    // The parent did not start the child itself (the person handed the work off), so say so.
    const prompt = failed
      ? `This conversation handed work to a subagent ("${child.title}"). It stopped with an error; its last message follows. Continue from it.\n\n${summary}`
      : `This conversation handed work to a subagent ("${child.title}"). It finished; its answer follows. Continue from it.\n\n${summary}`;
    return { parentSessionId: parent.id, childSessionId: child.id, prompt };
  }

  /** Sends the planned report as the parent's message; the stable command id makes it once. */
  private async sendReportBack(plan: ReportBackPlan, summaryRow: DaemonTranscriptItemInput): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.options.getSnapshot();
      // A rejected command keeps its receipt, so each retry is a new command at the new revision.
      const commandId = stableId('report-back', plan.childSessionId, String(snapshot.revision));
      const receipt = await this.options.executeCommand!(createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: snapshot.revision,
        issuedAt: this.isoNow(),
        principal: { kind: 'cli', id: REPORT_BACK_PRINCIPAL },
        type: 'agent.submit',
        payload: { sessionId: plan.parentSessionId, prompt: plan.prompt, reportOf: plan.childSessionId },
      }));
      if (receipt.ok) return;
      if (receipt.error.code !== 'revision-conflict') break;
    }
    // The parent could not take it as a message: keep the result where it would have been.
    await this.options.applySystemCommit({ mutations: this.transcriptMutations([summaryRow]) });
  }

  private userTranscript(
    sessionId: string,
    turnId: string,
    commandId: string,
    text: string,
    createdAt: string,
    context?: ChatMessageContext,
    isSensitive = false,
  ): DaemonTranscriptItemInput {
    return {
      id: stableId('message', commandId, 'user'),
      sessionId,
      turnId,
      kind: 'user-message',
      text,
      isDelta: false,
      isSensitive,
      createdAt,
      ...(context ? { context } : {}),
    };
  }

  private transcriptMutations(
    items: readonly DaemonTranscriptItemInput[],
  ): DaemonStoreMutation[] {
    return this.transcriptBatches(items).map((batch) => ({
      kind: 'transcript.append',
      items: batch,
    }));
  }

  private queuePump(): void {
    if (this.disposed) return;
    this.pumpRequested = true;
    if (this.pumpPromise) return;
    this.pumpPromise = Promise.resolve()
      .then(async () => {
        while (this.pumpRequested && !this.disposed) {
          this.pumpRequested = false;
          await this.pumpQueuedTurns();
        }
      })
      .catch((error) => this.report('queued turn pump failed', error))
      .finally(() => {
        this.pumpPromise = null;
        if (this.pumpRequested && !this.disposed) this.queuePump();
      });
  }

  /** Wake existing queued work after a host-owned execution gate is released. */
  wakeQueuedTurns(): void { this.queuePump(); }

  private async pumpQueuedTurns(): Promise<void> {
    while (!this.disposed) {
      let claim: {
        turn: DaemonTurn;
        agent: DaemonAgent;
        session: DaemonSession;
        workspaceId: string;
        workspaceRoot: string;
        prompt: string;
        startedAt: string;
      } | undefined;
      let repairedInvalidTurn = false;
      const startedAt = this.isoNow();
      await this.transition((snapshot) => {
        const activeCount = snapshot.turns.filter((turn) => ACTIVE_TURN_STATES.has(turn.state)).length;
        if (activeCount >= DAEMON_HARD_LIMITS.concurrentManagedTurns) return undefined;
        const queued = snapshot.turns
          .filter((turn) => turn.state === 'queued' && this.options.canDispatchTurn?.(turn) !== false)
          .sort((left, right) => (
            (left.enqueueSequence ?? Number.MAX_SAFE_INTEGER) - (right.enqueueSequence ?? Number.MAX_SAFE_INTEGER)
            || left.createdAt.localeCompare(right.createdAt)
            || left.id.localeCompare(right.id)
          ));
        const turn = queued.find((candidate) => {
          const agent = snapshot.agents.find((entry) => entry.sessionId === candidate.sessionId);
          const session = snapshot.sessions.find((entry) => entry.id === candidate.sessionId);
          return Boolean(
            agent
            && session
            && !agent.currentTurnId
            && !TERMINAL_AGENT_STATES.has(agent.state)
            && agent.state !== 'delivery-uncertain'
            && !TERMINAL_SESSION_STATES.has(session.state),
          );
        });
        if (!turn) return undefined;
        const agent = snapshot.agents.find((entry) => entry.sessionId === turn.sessionId)!;
        const session = snapshot.sessions.find((entry) => entry.id === turn.sessionId)!;
        const workspace = findActiveDaemonWorkspace(snapshot, session.workspaceId, session.projectId);
        const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
        const prompt = this.promptForTurn(turn);
        if (!workspace || !provider.ok || !prompt) {
          if (!workspace || !prompt) {
            repairedInvalidTurn = true;
            const remaining = Math.max(0, agent.queuedTurnCount - 1);
            return { mutations: [
              { kind: 'turn.upsert', value: turnInput(turn, {
                state: 'failed',
                finishedAt: startedAt,
                errorCode: 'queue-state-invalid',
              }) },
              { kind: 'agent.upsert', value: agentInput(agent, {
                state: remaining > 0 ? 'queued' : 'idle',
                queuedTurnCount: remaining,
              }) },
            ] };
          }
          return undefined;
        }
        claim = {
          turn,
          agent,
          session,
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          prompt,
          startedAt,
        };
        return { mutations: [
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: 'submitting',
            startedAt,
            finishedAt: undefined,
            errorCode: undefined,
          }) },
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: agent.providerSessionId ? 'working' : 'starting',
            currentTurnId: turn.id,
            queuedTurnCount: Math.max(0, agent.queuedTurnCount - 1),
          }) },
          { kind: 'session.upsert', value: sessionInput(session, agent.providerSessionId ? 'running' : 'starting') },
        ] };
      });
      if (!claim) {
        if (repairedInvalidTurn) continue;
        return;
      }
      if (this.disposed) return;

      const claimed = claim;
      await this.waitForProviderLifecycle(claimed.agent.providerId);
      if (this.disposed) return;
      const dispatchSnapshot = this.options.getSnapshot();
      const currentTurn = dispatchSnapshot.turns.find((turn) => turn.id === claimed.turn.id);
      const currentAgent = dispatchSnapshot.agents.find((agent) => agent.sessionId === claimed.agent.sessionId);
      const currentSession = dispatchSnapshot.sessions.find((session) => session.id === claimed.session.id);
      if (
        !currentTurn
        || currentTurn.state !== 'submitting'
        || !currentAgent
        || currentAgent.currentTurnId !== currentTurn.id
        || !currentSession
        || TERMINAL_AGENT_STATES.has(currentAgent.state)
        || TERMINAL_SESSION_STATES.has(currentSession.state)
      ) continue;
      const selected = {
        ...claimed,
        turn: currentTurn,
        agent: currentAgent,
        session: currentSession,
      };
      const provider = this.options.providers.enabledAdapter(dispatchSnapshot, selected.agent.providerId);
      if (!provider.ok) return;
      if (this.options.conversationWritable && !await this.options.conversationWritable(selected.session.projectId, selected.session.id)) {
        await this.transition(snapshot => {
          const turn = snapshot.turns.find(entry => entry.id === selected.turn.id);
          const agent = snapshot.agents.find(entry => entry.sessionId === selected.session.id);
          const session = snapshot.sessions.find(entry => entry.id === selected.session.id);
          if (!turn || turn.state !== 'submitting' || !agent || !session) return undefined;
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(turn, { state: 'failed', errorCode: 'stage-archived', finishedAt: this.isoNow() }) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: 'idle', currentTurnId: undefined }) },
            { kind: 'session.upsert', value: sessionInput(session, 'idle') },
          ] };
        });
        continue;
      }
      let providerSessionId = selected.agent.providerSessionId;
      let promptSent = false;
      const additionalRoots = await this.additionalRootsFor(dispatchSnapshot, selected.session);
      // Settings queued for this request apply before it is sent; a one-request effort only to the send itself.
      const queued = this.pendingSettings.get(selected.session.id);
      const queuedModel = queued?.model;
      const queuedAccess = queued?.permissionPreset;
      const queuedEffort = queued?.effortScope !== 'once' ? queued?.reasoningEffort : undefined;
      let queuedApplied = !queuedModel && !queuedAccess && !queuedEffort;
      try {
        if (!providerSessionId) {
          const handle = await provider.value.createSession(this.sessionContext(
            selected.session.id,
            selected.workspaceId,
            selected.workspaceRoot,
            queuedModel ?? selected.agent.model,
            queuedAccess ?? selected.agent.permissionPreset,
            selected.agent.orchestrationEnabled,
            additionalRoots,
          ), this.lifecycleAbortController.signal);
          let attached = false;
          await this.transition((snapshot) => {
            const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
            const agent = snapshot.agents.find((entry) => entry.sessionId === selected.session.id);
            if (!turn || !agent || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
              return undefined;
            }
            attached = true;
            return { mutations: [{ kind: 'agent.upsert', value: agentInput(agent, {
              providerSessionId: handle.providerSessionId,
              ...(handle.model ? { model: handle.model } : {}),
              ...(queuedEffort ? { reasoningEffort: queuedEffort } : appliedEffort(agent, handle)),
              permissionPreset: handle.permissionPreset,
              state: 'working',
            }) }] };
          });
          if (!attached) {
            await provider.value.disposeSession(selected.session.id, handle.providerSessionId);
            continue;
          }
          providerSessionId = handle.providerSessionId;
          this.setProviderAttached(selected.session.id, true);
          queuedApplied = true;
        }
        await this.providerHandleOperations.get(JSON.stringify([selected.agent.providerId, providerSessionId]));
        if (!this.attachedProviderSessions.has(selected.session.id)) await this.rehydrateSession(selected.session.id);
        if (!this.attachedProviderSessions.has(selected.session.id)) throw new Error('The original provider session could not be attached. Retry after checking its state.');
        if (this.disposed) return;
        if (!queuedApplied) {
          providerSessionId = await this.applyQueuedSettings(provider.value, selected.agent, providerSessionId, queuedModel, queuedAccess, queuedEffort);
          queuedApplied = true;
        }
        if (queued && (queuedModel || queuedAccess || queuedEffort)) {
          const left = this.pendingSettings.get(selected.session.id);
          this.setPending(selected.session.id, left && {
            ...left,
            ...(left.model === queuedModel ? { model: undefined } : {}),
            ...(left.permissionPreset === queuedAccess ? { permissionPreset: undefined } : {}),
            ...(queuedEffort && left.reasoningEffort === queuedEffort && left.effortScope !== 'once' ? { reasoningEffort: undefined, effortScope: undefined } : {}),
          });
        }
        if (await this.options.beforeProviderDispatch?.(selected.turn) === false) {
          await this.transition((snapshot) => {
            const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
            const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
            const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
            if (!turn || turn.state !== 'submitting' || !agent || agent.currentTurnId !== turn.id || !session) return undefined;
            return { mutations: [
              { kind: 'turn.upsert', value: turnInput(turn, { state: 'queued', startedAt: undefined }) },
              { kind: 'agent.upsert', value: agentInput(agent, { state: 'queued', currentTurnId: undefined, queuedTurnCount: agent.queuedTurnCount + 1 }) },
              { kind: 'session.upsert', value: sessionInput(session, 'idle') },
            ] };
          });
          continue;
        }
        if (this.disposed) return;
        // A one-request effort is spent by this send; the next request sends the record effort again.
        const atSend = this.pendingSettings.get(selected.session.id);
        const onceEffort = atSend?.effortScope === 'once' ? atSend.reasoningEffort : undefined;
        if (atSend && (onceEffort || atSend.runningTurnId)) {
          this.setPending(selected.session.id, {
            ...atSend,
            ...(onceEffort ? { reasoningEffort: undefined, effortScope: undefined } : {}),
            runningEffort: onceEffort,
            runningTurnId: onceEffort ? selected.turn.id : undefined,
          });
        }
        promptSent = true;
        await provider.value.submit({
          sessionId: selected.turn.sessionId,
          providerSessionId,
          turnId: selected.turn.id,
          commandId: selected.turn.commandId,
          prompt: selected.prompt,
          context: this.contextForTurn(selected.turn),
          reasoningEffort: this.options.preparedSessionSettings?.(selected.turn.sessionId)?.reasoningEffort
            ?? onceEffort
            ?? this.options.getSnapshot().agents.find((entry) => entry.sessionId === selected.turn.sessionId)?.reasoningEffort,
          attended: this.attendedTurn(selected.turn),
          ...(additionalRoots ? { additionalRoots } : {}),
        }, this.lifecycleAbortController.signal);
        await this.transition((snapshot) => {
          const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
          const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
          const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
          if (!turn || !agent || !session || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
            return undefined;
          }
          if (turn.state !== 'submitting') return undefined;
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(turn, { state: 'working' }) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: 'working' }) },
            { kind: 'session.upsert', value: sessionInput(session, 'running') },
          ] };
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Provider delivery could not be confirmed.';
        if (!promptSent) {
          // The session could not start or attach, so the prompt never left: fail the turn
          // now (with the provider's reason) instead of waiting out an uncertain delivery.
          const code = typeof (error as { code?: unknown } | null)?.code === 'string'
            ? (error as { code: string }).code
            : 'provider-start-failed';
          await this.transition((snapshot) => {
            const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
            const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
            const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
            if (!turn || !agent || !session || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
              return undefined;
            }
            return { mutations: [
              { kind: 'turn.upsert', value: turnInput(turn, { state: 'failed', errorCode: code, finishedAt: this.isoNow() }) },
              { kind: 'agent.upsert', value: agentInput(agent, { state: 'idle', currentTurnId: undefined }) },
              { kind: 'session.upsert', value: sessionInput(session, 'idle') },
              ...this.transcriptMutations([{
                id: stableId('start-error', selected.turn.id, detail),
                sessionId: selected.turn.sessionId,
                turnId: selected.turn.id,
                kind: 'error',
                text: detail,
                isDelta: false,
                isSensitive: false,
              }]),
            ] };
          });
          continue;
        }
        await this.transition((snapshot) => {
          const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
          const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
          const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
          if (!turn || !agent || !session || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
            return undefined;
          }
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(turn, {
              state: 'delivery-uncertain',
              errorCode: 'delivery-uncertain',
            }) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: 'delivery-uncertain' }) },
            { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
            ...this.transcriptMutations([{
              id: stableId('delivery-error', selected.turn.id, detail),
              sessionId: selected.turn.sessionId,
              turnId: selected.turn.id,
              kind: 'error',
              text: detail,
              isDelta: false,
              isSensitive: false,
            }]),
          ] };
        });
      }
    }
  }

  private async handleProviderEvent(providerId: string, event: AgentProviderEvent): Promise<void> {
    if (this.disposed) return;
    if (event.kind === 'usage') {
      if (!this.agentUsageTracker.observe(providerId, event)) return;
      const store = this.options.agentUsageStore;
      const state = this.agentUsageTracker.serialize();
      if (store) this.runBackground('agent usage save failed', () => store.save(state));
      // The event makes every client refetch the snapshot that carries the new usage.
      await this.transition(() => ({ events: [{
        kind: 'entity.upserted',
        payload: event.sessionId
          ? { entityType: 'agent', entityId: event.sessionId }
          : { entityType: 'provider', entityId: providerId },
      }] }));
      return;
    }
    if (event.kind === 'transcript') {
      if (event.providerChildId) {
        await this.routeSubagentTranscript(providerId, event.item, event.providerChildId);
        return;
      }
      const mutations = this.transcriptMutations([transcriptInput(event.item)]);
      await this.transition((snapshot) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === event.item.sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === event.item.sessionId);
        const turn = event.item.turnId
          ? snapshot.turns.find((entry) => entry.id === event.item.turnId)
          : undefined;
        if (
          !agent
          || !session
          || agent.providerId !== providerId
          || session.state === 'archived'
          || (event.item.turnId !== undefined && turn?.sessionId !== event.item.sessionId)
        ) return undefined;
        return { mutations };
      });
      return;
    }
    if (event.kind === 'session-state') {
      let failedTurnIds: string[] = [];
      await this.transition((snapshot) => {
        const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
        const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
        if (!session || !agent || agent.providerId !== providerId || TERMINAL_SESSION_STATES.has(session.state)) {
          return undefined;
        }
        const currentTurn = agent.currentTurnId
          ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
          : undefined;
        if (event.state === 'failed') {
          const now = this.isoNow();
          failedTurnIds = snapshot.turns.filter((turn) => (
            turn.sessionId === event.sessionId && ACTIVE_TURN_STATES.has(turn.state)
          )).map((turn) => turn.id);
          return { mutations: [
            ...this.terminalTurnMutations(
              snapshot,
              event.sessionId,
              'failed',
              now,
              'provider-session-failed',
            ),
            ...this.expireApprovalMutations(snapshot, event.sessionId, undefined, now),
            { kind: 'agent.upsert', value: agentInput(agent, {
              state: 'error',
              currentTurnId: undefined,
              queuedTurnCount: 0,
            }) },
            { kind: 'session.upsert', value: sessionInput(session, 'failed') },
          ] };
        }
        if (currentTurn && !TERMINAL_TURN_STATES.has(currentTurn.state)) {
          if (event.state === 'idle' || event.state === 'completed' || event.state === 'interrupted') {
            // Session notifications do not carry a turn generation. A delayed
            // predecessor state must not complete the current turn.
            return undefined;
          }
          if (event.state === 'starting' && currentTurn.state !== 'submitting') return undefined;
          if (event.state === 'working' && currentTurn.state === 'blocked') return undefined;
          if (
            this.isInterruptPending(currentTurn)
            && (event.state === 'starting' || event.state === 'working' || event.state === 'blocked')
          ) return undefined;
          const turnState = event.state === 'blocked'
            ? 'blocked'
            : event.state === 'working'
              ? 'working'
              : currentTurn.state;
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(currentTurn, {
              state: turnState,
              ...(turnState === 'working' ? { errorCode: undefined } : {}),
            }) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: providerStateToAgent(event.state) }) },
            { kind: 'session.upsert', value: sessionInput(session, providerStateToSession(event.state)) },
          ] };
        }
        if (
          agent.queuedTurnCount > 0
          && (event.state === 'completed' || event.state === 'interrupted')
        ) return undefined;
        return { mutations: [
          { kind: 'agent.upsert', value: agentInput(agent, { state: providerStateToAgent(event.state) }) },
          { kind: 'session.upsert', value: sessionInput(session, providerStateToSession(event.state)) },
        ] };
      });
      if (failedTurnIds.length > 0) this.queuePump();
      return;
    }
    if (event.kind === 'turn-started') {
      await this.transition((snapshot) => {
        const turn = snapshot.turns.find((entry) => (
          entry.id === event.turnId || entry.commandId === event.commandId
        ));
        const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
        if (
          !turn
          || !agent
          || !session
          || turn.sessionId !== event.sessionId
          || turn.commandId !== event.commandId
          || agent.providerId !== providerId
          || TERMINAL_TURN_STATES.has(turn.state)
          || TERMINAL_SESSION_STATES.has(session.state)
          || (agent.currentTurnId !== undefined && agent.currentTurnId !== turn.id)
        ) return undefined;
        if (this.isInterruptPending(turn)) {
          return { mutations: [{
            kind: 'turn.upsert',
            value: turnInput(turn, {
              ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
              startedAt: turn.startedAt ?? this.isoNow(),
            }),
          }] };
        }
        return { mutations: [
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: 'working',
            ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
            startedAt: turn.startedAt ?? this.isoNow(),
            errorCode: undefined,
          }) },
          { kind: 'agent.upsert', value: agentInput(agent, { state: 'working', currentTurnId: turn.id }) },
          { kind: 'session.upsert', value: sessionInput(session, 'running') },
        ] };
      });
      return;
    }
    if (event.kind === 'turn-finished') {
      let releasedCurrent = false;
      let report: { readonly plan: ReportBackPlan; readonly summaryRow: DaemonTranscriptItemInput } | undefined;
      const resultSummary = boundedChildSummary(event.summary);
      await this.transition((snapshot) => {
        const providerTurnId = event.turnId.startsWith('provider:') ? event.turnId.slice('provider:'.length) : undefined;
        const turn = snapshot.turns.find((entry) => (
          entry.id === event.turnId || (providerTurnId !== undefined && entry.providerTurnId === providerTurnId)
        ));
        const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
        if (
          !turn
          || !agent
          || !session
          || turn.sessionId !== event.sessionId
          || agent.providerId !== providerId
          || TERMINAL_TURN_STATES.has(turn.state)
        ) return undefined;
        const failed = event.outcome === 'failed';
        const interrupted = event.outcome === 'interrupted';
        const now = this.isoNow();
        releasedCurrent = agent.currentTurnId === turn.id;
        const hasQueuedSuccessor = releasedCurrent && agent.queuedTurnCount > 0;
        const parentRelation = snapshot.agentRelations.find((relation) => (
          relation.childSessionId === event.sessionId
          && relation.owner === 'managed'
          && relation.detachedAt === undefined
        ));
        const parent = parentRelation
          ? snapshot.sessions.find((candidate) => candidate.id === parentRelation.parentSessionId)
          : undefined;
        // What the parent hears is the child's last answer; a provider's summary can be a status line.
        const answer = parent ? finalAssistantText(this.options.readTranscript, event.sessionId, turn.id) ?? event.summary : undefined;
        const parentSummary = boundedChildSummary(answer);
        const reportText = boundedChildSummary(answer, MAX_REPORT_LENGTH)
          ?.concat((answer?.trim().length ?? 0) > MAX_REPORT_LENGTH ? '\n\n(…cut here; the full answer is in the subagent conversation.)' : '');
        const reportPlan = parent && reportText && !interrupted
          ? this.reportBackPlan(snapshot, parent, session, turn.id, failed, reportText)
          : undefined;
        const summaryRow = parentSummary && parent && parent.state !== 'archived' ? {
          id: stableId('managed-child-summary', parent.id, event.sessionId, turn.id, parentSummary),
          sessionId: parent.id,
          kind: 'child-summary' as const,
          text: parentSummary,
          isDelta: false,
          isSensitive: false,
          relatedSessionId: event.sessionId,
        } : undefined;
        report = reportPlan && summaryRow ? { plan: reportPlan, summaryRow } : undefined;
        return { mutations: [
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: failed ? 'failed' : interrupted ? 'interrupted' : 'completed',
            finishedAt: now,
            errorCode: event.errorCode,
          }) },
          ...(releasedCurrent ? [
            ...this.expireApprovalMutations(snapshot, event.sessionId, turn.id, now),
            { kind: 'agent.upsert' as const, value: agentInput(agent, {
              state: hasQueuedSuccessor
                ? 'queued'
                : failed ? 'error' : agent.queuedTurnCount > 0 ? 'queued' : 'idle',
              currentTurnId: undefined,
            }) },
            { kind: 'session.upsert' as const, value: sessionInput(
              session,
              hasQueuedSuccessor ? 'idle' : failed ? 'failed' : 'idle',
            ) },
          ] : []),
          ...(resultSummary ? this.transcriptMutations([{
            id: stableId('turn-summary', providerId, event.sessionId, turn.id, event.outcome, resultSummary),
            sessionId: event.sessionId,
            turnId: turn.id,
            kind: 'notice' as const,
            text: resultSummary,
            isDelta: false,
            isSensitive: false,
          }]) : []),
          // A reported result reaches the parent as its next message instead.
          ...(summaryRow && !report ? this.transcriptMutations([summaryRow]) : []),
        ] };
      });
      if (releasedCurrent) this.queuePump();
      if (report) {
        const { plan, summaryRow } = report;
        this.runBackground(`report ${plan.childSessionId} back to ${plan.parentSessionId}`, () => this.sendReportBack(plan, summaryRow));
      }
      // A plan approved by ending its turn is implemented by the next request, unless the turn was stopped or failed.
      const followUp = this.approvedPlanFollowUps.get(event.turnId);
      if (followUp && followUp.sessionId === event.sessionId) {
        this.approvedPlanFollowUps.delete(event.turnId);
        if (event.outcome === 'completed') {
          this.runBackground(
            `implement approved plan ${followUp.approvalId}`,
            () => this.sendPlanFollowUp(followUp.approvalId, followUp.sessionId, APPROVED_PLAN_PROMPT, followUp.principal),
          );
        }
      }
      return;
    }
    if (event.kind === 'approval-requested') {
      let response: 'allow' | 'deny' | undefined;
      let providerSessionId: string | undefined;
      await this.transition((snapshot) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
        if (!agent || !session || !agent.providerSessionId || agent.providerId !== providerId) return undefined;
        providerSessionId = agent.providerSessionId;
        const approvalId = stableId(
          'approval',
          providerId,
          agent.providerSessionId,
          event.sessionId,
          event.providerRequestId,
        );
        const existing = snapshot.approvals.find((entry) => entry.id === approvalId);
        if (existing) {
          if (existing.state === 'allowed') response = 'allow';
          else if (existing.state === 'denied' || existing.state === 'expired') response = 'deny';
          return undefined;
        }
        // A subagent's request lives on this session but not on its turn: a background
        // subagent can ask after the parent's turn ended, and that must not expire it.
        const subagentId = event.providerChildId
          ? nativeChildSessionId(providerId, event.sessionId, event.providerChildId)
          : undefined;
        const subagent = subagentId ? snapshot.sessions.find((entry) => entry.id === subagentId) : undefined;
        const turn = subagentId
          ? undefined
          : event.turnId
            ? snapshot.turns.find((entry) => entry.id === event.turnId)
            : agent.currentTurnId
              ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
              : undefined;
        const request = event.request && subagent
          ? { ...event.request, subagent: { sessionId: subagent.id, title: subagent.title.slice(0, 2_000) } }
          : event.request;
        // Clients that predate the structured request still see which subagent is asking.
        const detail = subagent ? `${subagent.title}: ${event.detail ?? event.title}` : event.detail;
        const stale = TERMINAL_SESSION_STATES.has(session.state)
          || (event.turnId !== undefined && (!turn || TERMINAL_TURN_STATES.has(turn.state)))
          || (turn !== undefined && agent.currentTurnId !== turn.id);
        if (stale) response = 'deny';
        const now = this.isoNow();
        return { mutations: [
          { kind: 'approval.upsert', value: {
            id: approvalId,
            sessionId: event.sessionId,
            ...(turn ? { turnId: turn.id } : {}),
            providerRequestId: event.providerRequestId,
            risk: event.risk,
            title: event.title,
            ...(detail ? { detail } : {}),
            ...(request ? { request } : {}),
            state: stale ? 'expired' : 'pending',
            ...(stale ? { resolvedAt: now } : {}),
          } },
          ...(!stale && turn ? [{
            kind: 'turn.upsert' as const,
            value: turnInput(turn, { state: 'blocked' }),
          }] : []),
          ...(!stale ? [
            { kind: 'agent.upsert' as const, value: agentInput(agent, { state: 'blocked' }) },
            { kind: 'session.upsert' as const, value: sessionInput(session, 'needs-attention') },
          ] : []),
        ] };
      });
      if (response && providerSessionId) {
        try {
          const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
          if (provider.ok) await provider.value.resolveApproval({
            sessionId: event.sessionId,
            providerSessionId,
            providerRequestId: event.providerRequestId,
            decision: response,
          });
        } catch (error) {
          this.report('duplicate or stale provider approval response failed', error);
        }
      }
      return;
    }
    if (event.kind === 'native-subagent') {
      await this.handleNativeSubagent(providerId, event);
      return;
    }
    if (event.kind === 'provider-error') {
      if (!event.sessionId) {
        this.report(`${providerId} provider error: ${event.code}`, new Error(event.message));
        return;
      }
      const sessionId = event.sessionId;
      let terminalTurnIds: string[] = [];
      let releasedCurrent = false;
      await this.transition((snapshot) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === sessionId);
        if (!agent || !session || agent.providerId !== providerId || session.state === 'archived') return undefined;
        if (event.turnScope) {
          const turn = event.turnScope.turnId
            ? snapshot.turns.find((entry) => (
                entry.id === event.turnScope?.turnId
                && entry.sessionId === sessionId
                && (
                  !event.turnScope.providerTurnId
                  || !entry.providerTurnId
                  || entry.providerTurnId === event.turnScope.providerTurnId
                )
              ))
            : snapshot.turns.find((entry) => (
                entry.sessionId === sessionId
                && entry.providerTurnId === event.turnScope?.providerTurnId
              ));
          if (!turn || !ACTIVE_TURN_STATES.has(turn.state)) return undefined;
          const isCurrent = agent.currentTurnId === turn.id;
          const preserveInterruptFence = this.isInterruptPending(turn);
          const now = this.isoNow();
          const transcript = this.transcriptMutations([{
            id: stableId('provider-error', providerId, sessionId, turn.id, event.code, event.message),
            sessionId,
            turnId: turn.id,
            kind: 'error',
            text: event.message,
            isDelta: false,
            isSensitive: false,
          }]);
          if (event.recoverable) {
            return { mutations: [
              ...(!preserveInterruptFence ? [{
                kind: 'turn.upsert' as const,
                value: turnInput(turn, {
                  state: 'delivery-uncertain',
                  errorCode: event.code,
                }),
              }] : []),
              ...(isCurrent && !preserveInterruptFence ? [
                { kind: 'agent.upsert' as const, value: agentInput(agent, { state: 'delivery-uncertain' }) },
                { kind: 'session.upsert' as const, value: sessionInput(session, 'delivery-uncertain') },
              ] : []),
              ...transcript,
            ] };
          }
          terminalTurnIds = [turn.id];
          releasedCurrent = isCurrent;
          const hasQueuedSuccessor = isCurrent && agent.queuedTurnCount > 0;
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(turn, {
              state: 'failed',
              finishedAt: now,
              errorCode: event.code,
            }) },
            ...this.expireApprovalMutations(snapshot, sessionId, turn.id, now, isCurrent),
            ...(isCurrent ? [
              { kind: 'agent.upsert' as const, value: agentInput(agent, {
                state: hasQueuedSuccessor ? 'queued' : 'error',
                currentTurnId: undefined,
              }) },
              { kind: 'session.upsert' as const, value: sessionInput(
                session,
                hasQueuedSuccessor ? 'idle' : 'failed',
              ) },
            ] : []),
            ...transcript,
          ] };
        }
        const turn = agent.currentTurnId
          ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
          : undefined;
        const transcript = this.transcriptMutations([{
          id: stableId('provider-error', providerId, sessionId, event.code, event.message),
          sessionId,
          ...(turn ? { turnId: turn.id } : {}),
          kind: 'error',
          text: event.message,
          isDelta: false,
          isSensitive: false,
        }]);
        if (event.recoverable && turn && this.isInterruptPending(turn)) {
          return { mutations: transcript };
        }
        const now = this.isoNow();
        if (!event.recoverable) {
          terminalTurnIds = snapshot.turns.filter((candidate) => (
            candidate.sessionId === sessionId && ACTIVE_TURN_STATES.has(candidate.state)
          )).map((candidate) => candidate.id);
        }
        return { mutations: [
          ...(event.recoverable && turn && !TERMINAL_TURN_STATES.has(turn.state) ? [{
            kind: 'turn.upsert' as const,
            value: turnInput(turn, {
              state: 'delivery-uncertain',
              errorCode: event.code,
            }),
          }] : []),
          ...(!event.recoverable
            ? this.terminalTurnMutations(snapshot, sessionId, 'failed', now, event.code)
            : []),
          ...(!event.recoverable ? this.expireApprovalMutations(snapshot, sessionId, undefined, now) : []),
          { kind: 'agent.upsert', value: agentInput(agent, event.recoverable ? {
            state: 'delivery-uncertain',
          } : { state: 'error', currentTurnId: undefined, queuedTurnCount: 0 }) },
          { kind: 'session.upsert', value: sessionInput(
            session,
            event.recoverable ? 'delivery-uncertain' : 'failed',
          ) },
          ...transcript,
        ] };
      });
      if (terminalTurnIds.length > 0 && (releasedCurrent || event.turnScope === undefined)) this.queuePump();
    }
  }

  /**
   * A row a provider produced inside one of its subagents goes to that
   * subagent's session. A subagent with no session (over its bounds, or its
   * parent is gone) drops the row; it never falls back into the parent.
   */
  private async routeSubagentTranscript(
    providerId: string,
    item: Extract<AgentProviderEvent, { kind: 'transcript' }>['item'],
    providerChildId: string,
  ): Promise<void> {
    const childId = nativeChildSessionId(providerId, item.sessionId, providerChildId);
    const mutations = this.transcriptMutations([routedChildItem(item, childId)]);
    await this.transition((snapshot) => {
      const child = snapshot.sessions.find((entry) => entry.id === childId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === childId);
      if (!child || !agent || agent.providerId !== providerId || child.state === 'archived') return undefined;
      return { mutations };
    });
  }

  /**
   * A subagent the provider started on its own (Claude Agent tool, Codex
   * sub-agent). It becomes a read-only child session whether or not the host's
   * orchestration tools are on: the person asked to see what it did.
   */
  private async handleNativeSubagent(
    providerId: string,
    event: Extract<AgentProviderEvent, { kind: 'native-subagent' }>,
  ): Promise<void> {
    await this.transition((snapshot) => {
      const root = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      const rootAgent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      const workspace = root
        ? findActiveDaemonWorkspace(snapshot, root.workspaceId, root.projectId)
        : undefined;
      if (
        !root
        || !rootAgent
        || !workspace
        || rootAgent.providerId !== providerId
        || root.archivedAt !== undefined
      ) {
        return undefined;
      }
      const childId = nativeChildSessionId(providerId, event.sessionId, event.providerChildId);
      // A subagent started by another subagent nests under it when that one is shown.
      const nestedParentId = event.parentProviderChildId
        ? nativeChildSessionId(providerId, event.sessionId, event.parentProviderChildId)
        : undefined;
      const parentSessionId = nestedParentId && snapshot.sessions.some((entry) => entry.id === nestedParentId)
        ? nestedParentId
        : event.sessionId;
      const existingSession = snapshot.sessions.find((entry) => entry.id === childId);
      const existingAgent = snapshot.agents.find((entry) => entry.sessionId === childId);
      const existingRelation = snapshot.agentRelations.find((entry) => entry.childSessionId === childId);
      if (
        !existingRelation
        && (TERMINAL_SESSION_STATES.has(root.state) || TERMINAL_AGENT_STATES.has(rootAgent.state))
      ) return undefined;
      const relationPlan = existingRelation
        ? { treeId: existingRelation.treeId, depth: existingRelation.depth }
        : this.planNativeRelation(snapshot, parentSessionId);
      if (!relationPlan) {
        return { mutations: this.transcriptMutations([{
          id: stableId('native-agent-limit', providerId, event.sessionId),
          sessionId: event.sessionId,
          kind: 'error',
          text: 'This conversation reached the subagent display limit; later subagents still run but are not shown.',
          isDelta: false,
          isSensitive: false,
        }]) };
      }
      const now = this.isoNow();
      const relatedParentId = existingRelation?.parentSessionId ?? parentSessionId;
      const parentTurnId = relatedParentId === event.sessionId ? rootAgent.currentTurnId : undefined;
      const finished = event.state === 'done' || event.state === 'error';
      const result = finished && event.summary
        ? subagentResultItem({
            providerId,
            rootSessionId: event.sessionId,
            parentSessionId: relatedParentId,
            childSessionId: childId,
            providerChildId: event.providerChildId,
            ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
            state: event.state === 'done' ? 'done' : 'error',
            summary: event.summary,
            ...(parentTurnId ? { parentTurnId } : {}),
            createdAt: now,
          })
        : undefined;
      const resultMutations = result ? this.transcriptMutations([result]) : [];
      if (existingSession && TERMINAL_SESSION_STATES.has(existingSession.state)) {
        return resultMutations.length > 0 ? { mutations: resultMutations } : undefined;
      }
      const state: DaemonAgent['state'] = event.state === 'done'
        ? 'done'
        : event.state === 'error'
          ? 'error'
          : event.state;
      const sessionState: DaemonSession['state'] = event.state === 'done'
        ? 'completed'
        : event.state === 'error'
          ? 'failed'
          : event.state === 'blocked'
            ? 'needs-attention'
            : event.state === 'starting' ? 'starting' : 'running';
      const mutations: DaemonStoreMutation[] = [
        { kind: 'session.upsert', value: existingSession
          ? sessionInput(existingSession, sessionState)
          : {
              id: childId,
              projectId: root.projectId,
              workspaceId: root.workspaceId,
              kind: 'agent',
              title: event.title,
              state: sessionState,
              source: 'structured',
            } },
        { kind: 'agent.upsert', value: existingAgent
          ? agentInput(existingAgent, { state, providerSessionId: event.providerChildId })
          : {
              sessionId: childId,
              providerId,
              providerSessionId: event.providerChildId,
              model: rootAgent.model,
              permissionPreset: rootAgent.permissionPreset,
              state,
              queuedTurnCount: 0,
              orchestrationEnabled: false,
            } },
      ];
      if (!existingRelation) {
        mutations.push({ kind: 'agent-relation.upsert', value: {
          id: stableId('relation', relationPlan.treeId, childId),
          treeId: relationPlan.treeId,
          parentSessionId,
          childSessionId: childId,
          owner: 'provider-native',
          depth: relationPlan.depth,
        } });
        mutations.push(...this.transcriptMutations(subagentStartItems({
          providerId,
          rootSessionId: event.sessionId,
          parentSessionId,
          childSessionId: childId,
          providerChildId: event.providerChildId,
          title: event.title,
          ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
          ...(event.subagentType ? { subagentType: event.subagentType } : {}),
          ...(event.background !== undefined ? { background: event.background } : {}),
          ...(event.instruction ? { instruction: event.instruction } : {}),
          ...(parentTurnId ? { parentTurnId } : {}),
          createdAt: now,
        })));
      }
      mutations.push(...resultMutations);
      return { mutations };
    });
  }

  /**
   * Startup pass over provider-native subagents. One still running when the host
   * stopped lost its provider process with it: it ends as interrupted. One
   * recorded before only Agent-tool tasks counted as subagents may be a
   * background shell command; with the provider's own record as evidence that
   * no such subagent exists, it is archived (and can be restored from its
   * receipt). Without evidence nothing is archived; the next start retries.
   */
  private async settleProviderNativeChildren(): Promise<void> {
    const exists = this.options.subagentRecordExists;
    try {
      await this.options.applySystemTransition(({ snapshot }) => {
        const now = this.isoNow();
        const mutations: DaemonStoreMutation[] = [];
        for (const relation of snapshot.agentRelations) {
          if (relation.owner !== 'provider-native' || relation.detachedAt) continue;
          const session = snapshot.sessions.find((entry) => entry.id === relation.childSessionId);
          const agent = snapshot.agents.find((entry) => entry.sessionId === relation.childSessionId);
          if (!session || !agent || session.archivedAt || session.state === 'archived') continue;
          if (ACTIVE_AGENT_STATES.has(agent.state)) {
            mutations.push(
              { kind: 'session.upsert', value: sessionInput(session, 'interrupted') },
              { kind: 'agent.upsert', value: agentInput(agent, { state: 'interrupted' }) },
            );
            continue;
          }
          if (agent.providerId !== 'claude' || !exists || !agent.providerSessionId) continue;
          const root = this.providerNativeRoot(snapshot, relation.parentSessionId);
          const rootAgent = root ? snapshot.agents.find((entry) => entry.sessionId === root.id) : undefined;
          const workspace = root ? snapshot.workspaces.find((entry) => entry.id === root.workspaceId) : undefined;
          if (!rootAgent?.providerSessionId || !workspace) continue;
          const items = this.options.readTranscript(session.id, 0, 20);
          const onlyLifecycle = items.every((item) => item.kind === 'notice'
            && /^Subagent (completed\.|stopped without completing\.)$/u.test(item.text.trim()));
          if (!onlyLifecycle) continue;
          const recorded = exists({
            providerId: agent.providerId,
            workspaceRoot: workspace.rootPath,
            parentProviderSessionId: rootAgent.providerSessionId,
            childProviderSessionId: agent.providerSessionId,
          });
          if (recorded !== false) continue;
          mutations.push(
            { kind: 'session.upsert', value: sessionInput(session, 'archived', now) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: 'archived' }) },
            { kind: 'migration-receipt.record', value: {
              id: stableId('provider-native-repair', session.id),
              source: PROVIDER_NATIVE_REPAIR_SOURCE,
              fingerprint: session.id,
              detail: {
                sessionId: session.id,
                previousSessionState: session.state,
                previousAgentState: agent.state,
                providerSessionId: agent.providerSessionId,
                parentProviderSessionId: rootAgent.providerSessionId,
                reason: 'no provider subagent record; a background task was recorded as a subagent',
              },
            } },
          );
        }
        return mutations.length ? { value: undefined, commit: { mutations } } : undefined;
      });
    } catch (error) {
      this.report('provider-native subagent startup pass failed', error);
    }
  }

  /** Undo of the startup archive: back to the states recorded in each receipt. */
  async restoreProviderNativeRepair(): Promise<readonly string[]> {
    const receipt = await this.options.applySystemTransition(({ snapshot }) => {
      const restored: string[] = [];
      const mutations: DaemonStoreMutation[] = [];
      for (const session of snapshot.sessions) {
        if (session.state !== 'archived') continue;
        const repair = this.options.findMigrationReceipt?.(stableId('provider-native-repair', session.id));
        const agent = snapshot.agents.find((entry) => entry.sessionId === session.id);
        if (!repair || !agent) continue;
        const sessionState = repair.detail?.previousSessionState as DaemonSession['state'] | undefined;
        const agentState = repair.detail?.previousAgentState as DaemonAgent['state'] | undefined;
        if (!sessionState || !agentState) continue;
        mutations.push(
          { kind: 'session.upsert', value: sessionInput({ ...session, archivedAt: undefined }, sessionState) },
          { kind: 'agent.upsert', value: agentInput(agent, { state: agentState }) },
        );
        restored.push(session.id);
      }
      return { value: restored, commit: { mutations } };
    });
    return receipt?.value ?? [];
  }

  /** The top of a provider-native chain: the session whose provider ran every subagent below it. */
  private providerNativeRoot(snapshot: DaemonSnapshot, sessionId: string): DaemonSession | undefined {
    let current = sessionId;
    for (let depth = 0; depth <= DAEMON_HARD_LIMITS.providerNativeTreeDepth; depth += 1) {
      const up = snapshot.agentRelations.find((relation) => (
        relation.childSessionId === current && relation.owner === 'provider-native' && !relation.detachedAt
      ));
      if (!up) return snapshot.sessions.find((entry) => entry.id === current);
      current = up.parentSessionId;
    }
    return undefined;
  }

  /** Provider-native subagents count only against their own, larger bounds. */
  private planNativeRelation(snapshot: DaemonSnapshot, parentSessionId: string): ChildRelationPlan | null {
    const parentRelation = snapshot.agentRelations.find((relation) => (
      relation.childSessionId === parentSessionId && !relation.detachedAt
    ));
    const treeId = parentRelation?.treeId ?? parentSessionId;
    const depth = (parentRelation?.depth ?? 0) + 1;
    if (depth > DAEMON_HARD_LIMITS.providerNativeTreeDepth) return null;
    const nativeChildren = snapshot.agentRelations.filter((relation) => (
      relation.treeId === treeId && !relation.detachedAt && relation.owner === 'provider-native'
    )).length;
    if (nativeChildren >= DAEMON_HARD_LIMITS.providerNativeNodesPerTree) return null;
    return { treeId, depth };
  }

  /** Another pending approval keeps the session waiting after this one resolves. */
  private pendingApprovalElsewhere(snapshot: DaemonSnapshot, approval: DaemonSnapshot['approvals'][number]): boolean {
    return snapshot.approvals.some((entry) => (
      entry.sessionId === approval.sessionId && entry.id !== approval.id && entry.state === 'pending'
    ));
  }

  private async runCommand(
    action: () => DaemonCommandExecutionResult | Promise<DaemonCommandExecutionResult>,
  ): Promise<DaemonCommandExecutionResult> {
    if (this.disposed) {
      return commandError('invalid-state', 'The Agent runtime is shutting down.');
    }
    const result = await action();
    return this.disposed
      ? commandError('invalid-state', 'The Agent runtime is shutting down.')
      : result;
  }

  /**
   * The only writer of `attachedProviderSessions`. The snapshot's `sideQuestionSessionIds` derives
   * from it, so a real change for a provider with side questions emits one event (clients refetch).
   */
  private setProviderAttached(sessionId: string, attached: boolean): void {
    if (this.attachedProviderSessions.has(sessionId) === attached) return;
    if (attached) this.attachedProviderSessions.add(sessionId);
    else this.attachedProviderSessions.delete(sessionId);
    const providerId = this.options.getSnapshot().agents.find((agent) => agent.sessionId === sessionId)?.providerId;
    if (!providerId || !this.options.providers.supportsSideQuestions(providerId)) return;
    // Callers include afterCommit hooks, which run inside a command: never await a commit here.
    this.runBackground('side question availability', async () => {
      await this.transition(() => ({ events: [{ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: sessionId } }] }));
    });
  }

  private transition(planner: DaemonSystemTransitionPlanner): Promise<unknown> {
    return this.options.applySystemCommit((snapshot) => (
      this.disposed ? undefined : planner(snapshot)
    ));
  }

  private runBackground(context: string, task: () => Promise<void>): void {
    if (this.disposed) return;
    const running = Promise.resolve()
      .then(task)
      .catch((error) => this.report(context, error))
      .finally(() => this.backgroundTasks.delete(running));
    this.backgroundTasks.add(running);
  }

  private runProviderHandleBackground(
    context: string,
    providerId: string,
    providerSessionId: string,
    task: () => Promise<void>,
  ): void {
    if (this.disposed) return;
    const key = JSON.stringify([providerId, providerSessionId]);
    const predecessor = this.providerHandleOperations.get(key) ?? Promise.resolve();
    const operation = this.enqueueProviderLifecycleOperation(providerId, async () => {
      await predecessor.catch(() => undefined);
      await task();
    });
    const tail = operation.finally(() => {
      if (this.providerHandleOperations.get(key) === tail) {
        this.providerHandleOperations.delete(key);
      }
    });
    this.providerHandleOperations.set(key, tail);
    this.runBackground(context, () => tail);
  }

  private runProviderLifecycleBackground(
    context: string,
    providerId: string,
    task: () => Promise<void>,
  ): void {
    if (this.disposed) return;
    const operation = this.enqueueProviderLifecycleOperation(providerId, task);
    this.runBackground(context, () => operation);
  }

  private advanceProviderLifecycle(providerId: string): number {
    const generation = (this.providerLifecycleGenerations.get(providerId) ?? 0) + 1;
    this.providerLifecycleGenerations.set(providerId, generation);
    return generation;
  }

  private isCurrentProviderEnable(providerId: string, generation: number): boolean {
    if (this.disposed || this.providerLifecycleGenerations.get(providerId) !== generation) return false;
    const provider = this.options.getSnapshot().providers.find((entry) => entry.id === providerId);
    return provider?.enabled === true && provider.health === 'ready';
  }

  private isInterruptPending(turn: DaemonTurn): boolean {
    return turn.state === 'delivery-uncertain'
      && (
        turn.errorCode?.startsWith('interrupt-') === true
        || turn.errorCode === 'turn-interrupt-failed'
        || turn.errorCode === 'cancel-provider-unavailable'
      );
  }

  private enqueueProviderLifecycleOperation(
    providerId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const predecessor = this.providerLifecycleOperations.get(providerId) ?? Promise.resolve();
    const operation = predecessor.catch(() => undefined).then(task);
    const tail = operation.finally(() => {
      if (this.providerLifecycleOperations.get(providerId) === tail) {
        this.providerLifecycleOperations.delete(providerId);
      }
    });
    this.providerLifecycleOperations.set(providerId, tail);
    return tail;
  }

  private async waitForProviderLifecycle(providerId: string): Promise<void> {
    await this.providerLifecycleOperations.get(providerId)?.catch(() => undefined);
  }

  private async drainEventTail(): Promise<void> {
    for (;;) {
      const tail = this.eventTail;
      await tail;
      if (tail === this.eventTail) return;
    }
  }

  private async settleStartupForShutdown(): Promise<void> {
    if (!this.startPromise) return;
    try {
      await this.startPromise;
    } catch (error) {
      this.report('settle Agent startup during shutdown', error);
    }
  }

  private async runBoundedShutdownStep(context: string, operation: Promise<unknown>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.resolve(operation).then(
      () => 'settled' as const,
      (error) => {
        this.report(context, error);
        return 'settled' as const;
      },
    );
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timeout = setTimeout(() => resolve('timed-out'), this.shutdownStepTimeoutMs);
    });
    const outcome = await Promise.race([settled, timedOut]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (outcome === 'timed-out') {
      this.report(context, new Error(`${context} exceeded ${String(this.shutdownStepTimeoutMs)}ms.`));
    }
  }

  private resolvedApprovalInput(
    approval: DaemonSnapshot['approvals'][number],
    state: 'allowed' | 'denied' | 'expired',
    resolvedAt: string,
  ): Omit<DaemonSnapshot['approvals'][number], 'revision' | 'createdAt' | 'updatedAt'> {
    return {
      id: approval.id,
      sessionId: approval.sessionId,
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      providerRequestId: approval.providerRequestId,
      risk: approval.risk,
      title: approval.title,
      ...(approval.detail ? { detail: approval.detail } : {}),
      state,
      resolvedAt,
    };
  }

  private expireApprovalMutations(
    snapshot: DaemonSnapshot,
    sessionId: string,
    turnId: string | undefined,
    resolvedAt: string,
    includeUnscoped = true,
  ): DaemonStoreMutation[] {
    return snapshot.approvals
      .filter((approval) => (
        approval.sessionId === sessionId
        && approval.state === 'pending'
        && (
          turnId === undefined
          || approval.turnId === turnId
          || (includeUnscoped && approval.turnId === undefined)
        )
      ))
      .map((approval): DaemonStoreMutation => ({
        kind: 'approval.upsert',
        value: this.resolvedApprovalInput(approval, 'expired', resolvedAt),
      }));
  }

  private terminalTurnMutations(
    snapshot: DaemonSnapshot,
    sessionId: string,
    state: 'interrupted' | 'failed',
    finishedAt: string,
    errorCode: string | undefined,
  ): DaemonStoreMutation[] {
    return snapshot.turns
      .filter((turn) => turn.sessionId === sessionId && !TERMINAL_TURN_STATES.has(turn.state))
      .map((turn): DaemonStoreMutation => ({
        kind: 'turn.upsert',
        value: turnInput(turn, { state, finishedAt, errorCode }),
      }));
  }

  private async expirePersistedApprovals(): Promise<void> {
    const now = this.isoNow();
    await this.transition((snapshot) => {
      const pending = snapshot.approvals.filter((approval) => approval.state === 'pending');
      if (pending.length === 0) return undefined;
      return { mutations: pending.map((approval): DaemonStoreMutation => ({
        kind: 'approval.upsert',
        value: this.resolvedApprovalInput(approval, 'expired', now),
      })) };
    });
  }

  /**
   * A provider turn cannot be submitted until its provider Session id is
   * durable. Therefore a submitting claim without that id is safe to put back
   * on the queue after restart; at most an empty provider Session was orphaned
   * while createSession was in flight. Delivery-uncertain claims remain held.
   */
  private async recoverUnattachedClaims(): Promise<void> {
    await this.transition((snapshot) => {
      const mutations: DaemonStoreMutation[] = [];
      for (const turn of snapshot.turns) {
        if (turn.state !== 'submitting') continue;
        const agent = snapshot.agents.find((entry) => entry.sessionId === turn.sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === turn.sessionId);
        if (
          !agent
          || !session
          || agent.providerSessionId
          || agent.currentTurnId !== turn.id
          || TERMINAL_AGENT_STATES.has(agent.state)
          || TERMINAL_SESSION_STATES.has(session.state)
        ) continue;
        const queuedTurnCount = snapshot.turns.filter((candidate) => (
          candidate.sessionId === turn.sessionId
          && candidate.state === 'queued'
          && candidate.id !== turn.id
        )).length + 1;
        mutations.push(
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: 'queued',
            startedAt: undefined,
            finishedAt: undefined,
            errorCode: undefined,
          }) },
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: 'queued',
            currentTurnId: undefined,
            queuedTurnCount,
          }) },
          { kind: 'session.upsert', value: sessionInput(session, 'idle') },
        );
      }
      return mutations.length > 0 ? { mutations } : undefined;
    });
  }

  private contextForTurn(turn: DaemonTurn): ChatMessageContext | undefined {
    let afterSequence = 0;
    for (;;) {
      const page = this.options.readTranscript(turn.sessionId, afterSequence, 2_000);
      const message = page.find((item) => item.turnId === turn.id && item.kind === 'user-message');
      if (message) return message.context;
      if (page.length < 2_000) {
        const command = this.options.findCommand?.(turn.commandId);
        return (command?.type === 'agent.submit' || command?.type === 'agent.interrupt-and-submit') && command.payload.sessionId === turn.sessionId ? command.payload.context : undefined;
      }
      const next = page.at(-1)?.sequence;
      if (next === undefined || next <= afterSequence) return undefined;
      afterSequence = next;
    }
  }

  /**
   * Whether a person sent this turn from a conversation. A delegated child's
   * first turn carries the person's principal but runs on its own.
   */
  private attendedTurn(turn: DaemonTurn): boolean {
    if (this.options.preparedSessionSettings?.(turn.sessionId)) return false;
    const command = this.options.findCommand?.(turn.commandId);
    if (!command) return false;
    // A child's report arrives in its parent's conversation: a person watches it unless that parent is itself a child.
    if (command.principal.id === REPORT_BACK_PRINCIPAL) {
      return !this.options.getSnapshot().agentRelations.some((relation) => relation.childSessionId === turn.sessionId && relation.detachedAt === undefined);
    }
    if (command.principal.kind !== 'desktop' && command.principal.kind !== 'android') return false;
    return !(command.type === 'agent.create' && command.payload.parentSessionId);
  }

  /** A reply that quotes a sensitive message carries that text, so it inherits the flag. */
  private replyAnchorIsSensitive(sessionId: string, reply: ChatReplyReference): boolean {
    let afterSequence = 0;
    for (;;) {
      const page = this.options.readTranscript(sessionId, afterSequence, 2_000);
      const anchor = page.find((item) => item.id === reply.messageId || item.messageId === reply.messageId
        || item.id === stableId('history-message', sessionId, reply.messageId));
      if (anchor) return anchor.isSensitive;
      const next = page.at(-1)?.sequence;
      if (page.length < 2_000 || next === undefined || next <= afterSequence) return false;
      afterSequence = next;
    }
  }

  private isValidReply(sessionId: string, reply: ChatReplyReference): boolean {
    let anchor: DaemonTranscriptItem | undefined;
    let text = '';
    let afterSequence = 0;
    for (;;) {
      const page = this.options.readTranscript(sessionId, afterSequence, 2_000);
      for (const item of page) {
        if (!anchor) {
          if (item.id !== reply.messageId && item.messageId !== reply.messageId && item.id !== stableId('history-message', sessionId, reply.messageId)) continue;
          if (!['user-message', 'assistant-message'].includes(item.kind)) return false;
          anchor = item;
          text = item.text;
        } else if (anchor.messageId) {
          if (item.messageId !== anchor.messageId || item.turnId !== anchor.turnId || item.kind !== anchor.kind) continue;
          text = item.isDelta ? text + item.text : item.text;
        } else {
          if (item.kind !== anchor.kind || item.turnId !== anchor.turnId || item.messageId || !item.isDelta) {
            return text.startsWith(reply.text);
          }
          text += item.text;
        }
      }
      if (page.length < 2_000) return Boolean(anchor && text.startsWith(reply.text));
      const next = page.at(-1)?.sequence;
      if (next === undefined || next <= afterSequence) return false;
      afterSequence = next;
    }
  }

  private promptForTurn(turn: DaemonTurn): string | undefined {
    const command = this.options.findCommand?.(turn.commandId);
    if (command?.type === 'agent.create' && command.payload.sessionId === turn.sessionId) {
      return command.payload.initialPrompt;
    }
    if (
      (command?.type === 'agent.submit' || command?.type === 'agent.interrupt-and-submit')
      && command.payload.sessionId === turn.sessionId
    ) return command.payload.prompt;

    let afterSequence = 0;
    for (;;) {
      const page = this.options.readTranscript(turn.sessionId, afterSequence, 2_000);
      const prompt = page.find((item) => item.turnId === turn.id && item.kind === 'user-message');
      if (prompt) return prompt.text;
      if (page.length < 2_000) return undefined;
      const next = page.at(-1)?.sequence;
      if (next === undefined || next <= afterSequence) return undefined;
      afterSequence = next;
    }
  }

  private async rehydratePersistedSessions(): Promise<void> {
    const snapshot = this.options.getSnapshot();
    for (const agent of snapshot.agents) {
      if (this.disposed) return;
      const session = snapshot.sessions.find((entry) => entry.id === agent.sessionId);
      if (
        !agent.providerSessionId
        || !session
        || TERMINAL_AGENT_STATES.has(agent.state)
        || TERMINAL_SESSION_STATES.has(session.state)
        || !agent.currentTurnId && agent.queuedTurnCount === 0
      ) continue;
      await this.rehydrateSession(agent.sessionId);
    }
  }

  private async rehydrateProviderSessions(providerId: string, lifecycleGeneration: number): Promise<void> {
    const snapshot = this.options.getSnapshot();
    for (const agent of snapshot.agents) {
      if (!this.isCurrentProviderEnable(providerId, lifecycleGeneration)) return;
      if (agent.providerId !== providerId || !agent.providerSessionId) continue;
      if (agent.state === 'idle' && !agent.currentTurnId && !snapshot.turns.some(turn => turn.sessionId === agent.sessionId && turn.state === 'queued')) continue;
      const session = snapshot.sessions.find((entry) => entry.id === agent.sessionId);
      if (
        !session
        || TERMINAL_AGENT_STATES.has(agent.state)
        || TERMINAL_SESSION_STATES.has(session.state)
      ) continue;
      await this.rehydrateSession(
        agent.sessionId,
        () => this.isCurrentProviderEnable(providerId, lifecycleGeneration),
      );
    }
  }

  private async rehydrateSession(sessionId: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!isCurrent()) return;
    const snapshot = this.options.getSnapshot();
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    const workspace = session
      ? findActiveDaemonWorkspace(snapshot, session.workspaceId, session.projectId)
      : undefined;
    if (
      !session
      || !agent?.providerSessionId
      || !workspace
      || TERMINAL_AGENT_STATES.has(agent.state)
      || TERMINAL_SESSION_STATES.has(session.state)
    ) return;
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) {
      if (!isCurrent()) return;
      await this.markSessionDeliveryUncertain(sessionId, 'provider-unavailable', provider.message);
      return;
    }
    try {
      const additionalRoots = await this.additionalRootsFor(snapshot, session);
      const handle = await provider.value.resumeSession({
        ...this.sessionContext(
          sessionId,
          workspace.id,
          workspace.rootPath,
          agent.model,
          agent.permissionPreset,
          agent.orchestrationEnabled,
          additionalRoots,
        ),
        providerSessionId: agent.providerSessionId,
      }, this.lifecycleAbortController.signal);
      if (!isCurrent()) return;
      let attached = false;
      await this.transition((fresh) => {
        if (!isCurrent()) return undefined;
        const currentAgent = fresh.agents.find((entry) => entry.sessionId === sessionId);
        const currentSession = fresh.sessions.find((entry) => entry.id === sessionId);
        const currentWorkspace = currentSession
          ? findActiveDaemonWorkspace(fresh, currentSession.workspaceId, currentSession.projectId)
          : undefined;
        if (
          !currentAgent
          || !currentSession
          || !currentWorkspace
          || TERMINAL_AGENT_STATES.has(currentAgent.state)
          || TERMINAL_SESSION_STATES.has(currentSession.state)
        ) return undefined;
        const hasCurrent = currentAgent.currentTurnId !== undefined;
        attached = true;
        return { mutations: [
          { kind: 'agent.upsert', value: agentInput(currentAgent, {
            providerSessionId: handle.providerSessionId,
            ...(handle.model ? { model: handle.model } : {}),
            ...appliedEffort(currentAgent, handle),
            permissionPreset: handle.permissionPreset,
            ...(!hasCurrent ? { state: currentAgent.queuedTurnCount > 0 ? 'queued' : 'idle' } : {}),
          }) },
          ...(!hasCurrent ? [{
            kind: 'session.upsert' as const,
            value: sessionInput(currentSession, 'idle'),
          }] : []),
        ] };
      });
      if (!attached) {
        await this.disposeProviderSession(provider.value, sessionId, handle.providerSessionId);
      } else this.setProviderAttached(sessionId, true);
    } catch (error) {
      if (!isCurrent()) return;
      await this.markSessionDeliveryUncertain(
        sessionId,
        'provider-resume-failed',
        error instanceof Error ? error.message : 'Provider Session could not be resumed.',
      );
    }
  }

  private async markSessionDeliveryUncertain(
    sessionId: string,
    code: string,
    detail: string,
    expectedTurnId?: string,
  ): Promise<void> {
    await this.transition((snapshot) => {
      const session = snapshot.sessions.find((entry) => entry.id === sessionId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
      if (!session || !agent || TERMINAL_SESSION_STATES.has(session.state)) return undefined;
      const turn = agent.currentTurnId
        ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
        : undefined;
      if (
        expectedTurnId !== undefined
        && (
          agent.currentTurnId !== expectedTurnId
          || turn?.id !== expectedTurnId
          || TERMINAL_TURN_STATES.has(turn.state)
        )
      ) return undefined;
      return { mutations: [
        ...(turn && !TERMINAL_TURN_STATES.has(turn.state) ? [{
          kind: 'turn.upsert' as const,
          value: turnInput(turn, { state: 'delivery-uncertain', errorCode: code }),
        }] : []),
        { kind: 'agent.upsert', value: agentInput(agent, { state: 'delivery-uncertain' }) },
        { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
        ...this.transcriptMutations([{
          id: stableId('session-error', sessionId, code, detail),
          sessionId,
          ...(turn ? { turnId: turn.id } : {}),
          kind: 'error',
          text: detail,
          isDelta: false,
          isSensitive: false,
        }]),
      ] };
    });
  }

  private async requestInterrupt(
    sessionId: string,
    turnId: string,
    providerId: string,
    providerSessionId: string,
  ): Promise<void> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'interrupt-provider-unavailable',
        provider.message,
        turnId,
      );
      return;
    }
    try {
      await provider.value.interrupt(sessionId, providerSessionId);
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'interrupt-failed',
        error instanceof Error ? error.message : `Turn ${turnId} could not be interrupted.`,
        turnId,
      );
    }
  }

  /**
   * Applies what waited for this request before it is sent. A failure fails the request with the
   * provider reason (nothing was sent) and the queued settings stay for the next try.
   */
  private async applyQueuedSettings(
    provider: AgentProviderAdapter,
    agent: DaemonAgent,
    providerSessionId: string,
    model: string | undefined,
    permissionPreset: DaemonAgent['permissionPreset'] | undefined,
    reasoningEffort: string | undefined,
  ): Promise<string> {
    let handle: ProviderSessionHandle | undefined;
    if (model || permissionPreset) {
      const nextModel = model ?? agent.model;
      handle = await provider.setSettings({
        sessionId: agent.sessionId,
        providerSessionId,
        ...(nextModel ? { model: nextModel } : {}),
        permissionPreset: permissionPreset ?? agent.permissionPreset,
      });
    }
    await this.transition((snapshot) => {
      const current = snapshot.agents.find((entry) => entry.sessionId === agent.sessionId);
      if (!current || TERMINAL_AGENT_STATES.has(current.state)) return undefined;
      return { mutations: [{ kind: 'agent.upsert', value: agentInput(current, {
        ...(handle ? { providerSessionId: handle.providerSessionId, permissionPreset: handle.permissionPreset } : {}),
        ...(handle?.model ? { model: handle.model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }) }] };
    });
    return handle?.providerSessionId ?? providerSessionId;
  }

  private async applyProviderSettings(
    sessionId: string,
    providerId: string,
    providerSessionId: string,
    model: string | undefined,
    permissionPreset: DaemonAgent['permissionPreset'],
  ): Promise<void> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) {
      await this.markSessionDeliveryUncertain(sessionId, 'settings-provider-unavailable', provider.message);
      return;
    }
    try {
      const handle = await provider.value.setSettings({ sessionId, providerSessionId, ...(model ? { model } : {}), permissionPreset });
      await this.transition((snapshot) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
        if (!agent || agent.state === 'archived') return undefined;
        return { mutations: [{ kind: 'agent.upsert', value: agentInput(agent, {
          providerSessionId: handle.providerSessionId,
          ...(handle.model ? { model: handle.model } : {}),
          permissionPreset: handle.permissionPreset,
        }) }] };
      });
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'settings-update-failed',
        error instanceof Error ? error.message : 'Provider settings could not be updated.',
      );
    }
  }

  private async resolveProviderApproval(
    providerId: string,
    sessionId: string,
    providerSessionId: string,
    providerRequestId: string,
    decision: 'allow' | 'deny',
    response?: ApprovalResponse,
    endTurn = false,
  ): Promise<boolean> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) {
      await this.markSessionDeliveryUncertain(sessionId, 'approval-provider-unavailable', provider.message);
      return false;
    }
    try {
      const input = { sessionId, providerSessionId, providerRequestId, ...(response ? { response } : {}) };
      if (endTurn && provider.value.approvePlanEndingTurn) await provider.value.approvePlanEndingTurn(input);
      else await provider.value.resolveApproval({ ...input, decision });
      return true;
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'approval-delivery-failed',
        error instanceof Error ? error.message : 'Approval decision could not be delivered.',
      );
      return false;
    }
  }

  private async disposeProviderSession(
    provider: AgentProviderAdapter,
    sessionId: string,
    providerSessionId: string,
  ): Promise<void> {
    this.setProviderAttached(sessionId, false);
    try {
      await provider.disposeSession(sessionId, providerSessionId);
    } catch (error) {
      this.report('provider Session disposal failed', error);
    }
  }

  private transcriptBatches(items: readonly DaemonTranscriptItemInput[]): readonly DaemonTranscriptItemInput[][] {
    const expanded: DaemonTranscriptItemInput[] = [];
    for (const item of items) {
      const input = item;
      if (Buffer.byteLength(input.text, 'utf8') <= MAX_TRANSCRIPT_BATCH_UTF8_BYTES) {
        expanded.push(input);
        continue;
      }
      let part = '';
      let partBytes = 0;
      let index = 0;
      for (const character of input.text) {
        const bytes = Buffer.byteLength(character, 'utf8');
        if (partBytes + bytes > MAX_TRANSCRIPT_BATCH_UTF8_BYTES && part) {
          expanded.push({ ...input, id: stableId('transcript-part', input.id, String(index)), text: part, isDelta: input.messageId && index === 0 ? input.isDelta : true });
          index += 1;
          part = '';
          partBytes = 0;
        }
        part += character;
        partBytes += bytes;
      }
      if (part) expanded.push({ ...input, id: stableId('transcript-part', input.id, String(index)), text: part, isDelta: input.messageId && index === 0 ? input.isDelta : true });
    }
    const batches: DaemonTranscriptItemInput[][] = [];
    let batch: DaemonTranscriptItemInput[] = [];
    let bytes = 0;
    for (const item of expanded) {
      const itemBytes = Buffer.byteLength(item.text, 'utf8')
        + (item.context ? Buffer.byteLength(JSON.stringify(item.context), 'utf8') : 0)
        + (item.payload ? Buffer.byteLength(JSON.stringify(item.payload), 'utf8') : 0);
      if (batch.length >= MAX_TRANSCRIPT_BATCH_ITEMS || bytes + itemBytes > MAX_TRANSCRIPT_BATCH_UTF8_BYTES) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(item);
      bytes += itemBytes;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
  }

  private async reconcileUnsettled(): Promise<void> {
    const snapshot = this.options.getSnapshot();
    for (const agent of snapshot.agents) {
      if (this.disposed) return;
      if (!agent.providerSessionId || agent.state === 'archived') continue;
      const turns = snapshot.turns.filter((turn) => (
        turn.sessionId === agent.sessionId && ACTIVE_TURN_STATES.has(turn.state)
      ));
      if (turns.length === 0) continue;
      const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), agent.providerId);
      if (!provider.ok) continue;
      try {
        const reconciliation = await provider.value.reconcile({
          sessionId: agent.sessionId,
          providerSessionId: agent.providerSessionId,
          unsettledCommands: turns.flatMap((turn) => {
            const command = this.options.findCommand?.(turn.commandId);
            return command ? [{
              commandId: command.commandId,
              idempotencyKey: command.idempotencyKey,
              type: command.type,
              turnId: turn.id,
              ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
              state: turn.state as 'submitting' | 'working' | 'blocked' | 'delivery-uncertain',
            }] : [];
          }),
        }, this.lifecycleAbortController.signal);
        const reconciledSnapshot = this.options.getSnapshot();
        const invalidTranscript = reconciliation.transcriptItems.find((item) => {
          if (item.sessionId !== agent.sessionId) return true;
          if (!item.turnId) return false;
          return reconciledSnapshot.turns.find((turn) => turn.id === item.turnId)?.sessionId !== agent.sessionId;
        });
        if (invalidTranscript) {
          throw new Error(`Provider reconciliation returned transcript ${invalidTranscript.id} for another Session or turn.`);
        }
        for (const batch of this.transcriptBatches(reconciliation.transcriptItems.map(transcriptInput))) {
          await this.transition(() => ({ mutations: [{ kind: 'transcript.append', items: batch }] }));
        }
        for (const result of reconciliation.commands) {
          let shouldPump = false;
          await this.transition((fresh) => {
            const turn = fresh.turns.find((candidate) => candidate.commandId === result.commandId);
            if (!turn || TERMINAL_TURN_STATES.has(turn.state)) return undefined;
            const currentAgent = fresh.agents.find((entry) => entry.sessionId === turn.sessionId);
            const session = fresh.sessions.find((entry) => entry.id === turn.sessionId);
            if (
              turn.sessionId !== agent.sessionId
              || !currentAgent
              || !session
              || currentAgent.providerId !== agent.providerId
            ) return undefined;
            if (result.state === 'not-applied') {
              const queuedCount = fresh.turns.filter((candidate) => (
                candidate.sessionId === turn.sessionId
                && candidate.state === 'queued'
                && candidate.id !== turn.id
              )).length + 1;
              shouldPump = true;
              return {
                mutations: [
                  { kind: 'turn.upsert', value: turnInput(turn, {
                    state: 'queued',
                    providerTurnId: undefined,
                    startedAt: undefined,
                    finishedAt: undefined,
                    errorCode: undefined,
                  }) },
                  { kind: 'agent.upsert', value: agentInput(currentAgent, {
                    state: 'queued',
                    ...(currentAgent.currentTurnId === turn.id ? { currentTurnId: undefined } : {}),
                    queuedTurnCount: queuedCount,
                  }) },
                  { kind: 'session.upsert', value: sessionInput(session, 'idle') },
                ],
                reconciledCommands: [{ commandId: result.commandId, state: 'applied' }],
              };
            }
            if (result.state === 'delivery-uncertain') {
              return {
                mutations: [
                  { kind: 'turn.upsert', value: turnInput(turn, {
                    state: 'delivery-uncertain',
                    ...(result.providerTurnId ? { providerTurnId: result.providerTurnId } : {}),
                    errorCode: result.errorCode ?? 'delivery-uncertain',
                  }) },
                  { kind: 'agent.upsert', value: agentInput(currentAgent, {
                    state: 'delivery-uncertain',
                    currentTurnId: turn.id,
                  }) },
                  { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
                ],
                reconciledCommands: [{
                  commandId: result.commandId,
                  state: 'delivery-uncertain',
                  detail: 'Provider delivery remains uncertain after reconciliation.',
                }],
              };
            }
            const state = result.turnState ?? (turn.state === 'blocked' ? 'blocked' : 'working');
            if (state === 'completed' || state === 'interrupted' || state === 'failed') {
              const now = this.isoNow();
              shouldPump = currentAgent.currentTurnId === turn.id;
              return {
                mutations: [
                  { kind: 'turn.upsert', value: turnInput(turn, {
                    state,
                    ...(result.providerTurnId ? { providerTurnId: result.providerTurnId } : {}),
                    finishedAt: turn.finishedAt ?? now,
                    errorCode: result.errorCode,
                  }) },
                  ...this.expireApprovalMutations(fresh, turn.sessionId, turn.id, now),
                  ...(shouldPump ? [
                    { kind: 'agent.upsert' as const, value: agentInput(currentAgent, {
                      state: state === 'failed'
                        ? 'error'
                        : currentAgent.queuedTurnCount > 0 ? 'queued' : 'idle',
                      currentTurnId: undefined,
                    }) },
                    { kind: 'session.upsert' as const, value: sessionInput(
                      session,
                      state === 'failed' ? 'failed' : 'idle',
                    ) },
                  ] : []),
                ],
                reconciledCommands: [{ commandId: result.commandId, state: 'applied' }],
              };
            }
            return {
              mutations: [
                { kind: 'turn.upsert', value: turnInput(turn, {
                  state,
                  ...(result.providerTurnId ? { providerTurnId: result.providerTurnId } : {}),
                  startedAt: turn.startedAt ?? this.isoNow(),
                  errorCode: undefined,
                }) },
                { kind: 'agent.upsert', value: agentInput(currentAgent, {
                  state,
                  currentTurnId: turn.id,
                }) },
                { kind: 'session.upsert', value: sessionInput(
                  session,
                  state === 'blocked' ? 'needs-attention' : 'running',
                ) },
              ],
              reconciledCommands: [{ commandId: result.commandId, state: 'applied' }],
            };
          });
          if (shouldPump) this.queuePump();
        }
      } catch (error) {
        this.report(`provider reconciliation failed for ${agent.sessionId}`, error);
        await this.markSessionDeliveryUncertain(
          agent.sessionId,
          'provider-reconciliation-failed',
          error instanceof Error ? error.message : 'Provider reconciliation failed.',
        );
      }
    }
  }

  private isoNow(): string {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new Error('Daemon Agent runtime clock returned an invalid Date.');
    }
    return now.toISOString();
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics cannot break the runtime state machine.
    }
  }
}
