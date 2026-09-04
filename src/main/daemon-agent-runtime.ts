import { createHash } from 'node:crypto';

import {
  DAEMON_HARD_LIMITS,
  type DaemonAgent,
  type DaemonCommand,
  type DaemonCommandError,
  type DaemonCommandType,
  type DaemonSession,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import type {
  AgentProviderEvent,
  ProviderSessionContext,
} from './agent-provider-adapter';
import type {
  DaemonCommandExecutionContext,
  DaemonCommandExecutionResult,
  DaemonCommandHandler,
  DaemonSystemTransitionPlanner,
} from './daemon-command-router';
import type {
  DaemonStoreCommit,
  DaemonStoreMutation,
  DaemonTranscriptItemInput,
} from './daemon-store';
import {
  MAX_TRANSCRIPT_BATCH_ITEMS,
  MAX_TRANSCRIPT_BATCH_UTF8_BYTES,
} from './daemon-store';
import { AgentProviderRegistry } from './agent-provider-registry';

type AgentCommandType = Extract<DaemonCommandType,
  | 'agent.create'
  | 'agent.resume'
  | 'agent.submit'
  | 'agent.interrupt-and-submit'
  | 'agent.interrupt'
  | 'agent.set-settings'
  | 'agent.cancel'
  | 'agent.archive'
  | 'agent.detach'
  | 'permission.resolve'
  | 'provider.enable'
  | 'provider.disable'
  | 'provider.update'
>;

export interface DaemonAgentRuntimeOptions {
  readonly providers: AgentProviderRegistry;
  readonly getSnapshot: () => DaemonSnapshot;
  readonly applySystemCommit: (
    commit: DaemonStoreCommit | DaemonSystemTransitionPlanner,
  ) => Promise<unknown>;
  readonly readTranscript: (
    sessionId: string,
    afterSequence?: number,
    limit?: number,
  ) => readonly DaemonTranscriptItem[];
  readonly findCommand?: (commandId: string) => DaemonCommand | undefined;
  readonly orchestrationForSession?: (
    sessionId: string,
  ) => ProviderSessionContext['orchestration'] | undefined;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface ChildRelationPlan {
  readonly treeId: string;
  readonly depth: number;
}

const MAX_CHILD_SUMMARY_LENGTH = 2_000;

function boundedChildSummary(value: string | undefined): string | undefined {
  const summary = value?.trim().slice(0, MAX_CHILD_SUMMARY_LENGTH);
  return summary ? summary : undefined;
}

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

function commandError(
  code: DaemonCommandError['code'],
  message: string,
  retryable = false,
): DaemonCommandExecutionResult {
  return { ok: false, error: { code, message, retryable } };
}

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
  const currentTurnId = Object.prototype.hasOwnProperty.call(patch, 'currentTurnId')
    ? patch.currentTurnId
    : agent.currentTurnId;
  return {
    sessionId: agent.sessionId,
    providerId: patch.providerId ?? agent.providerId,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(model ? { model } : {}),
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

function transcriptInput(item: DaemonTranscriptItem): DaemonTranscriptItemInput {
  return {
    id: item.id,
    sessionId: item.sessionId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    kind: item.kind,
    text: item.text,
    isDelta: item.isDelta,
    isSensitive: item.isSensitive,
    ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}),
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
    case 'interrupted': return 'interrupted';
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
    case 'interrupted': return 'interrupted';
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
  private readonly setTimer: NonNullable<DaemonAgentRuntimeOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DaemonAgentRuntimeOptions['clearTimer']>;
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private unsubscribeProviders: (() => void) | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private started = false;
  private disposed = false;

  constructor(private readonly options: DaemonAgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  handlers(): Partial<Record<AgentCommandType, DaemonCommandHandler>> {
    return {
      'agent.create': (command, context) => this.create(command, context),
      'agent.resume': (command, context) => this.resume(command, context),
      'agent.submit': (command, context) => this.submit(command, context, false),
      'agent.interrupt-and-submit': (command, context) => this.submit(command, context, true),
      'agent.interrupt': (command, context) => this.interrupt(command, context),
      'agent.set-settings': (command, context) => this.setSettings(command, context),
      'agent.cancel': (command, context) => this.cancel(command, context),
      'agent.archive': (command, context) => this.archive(command, context),
      'agent.detach': (command) => this.detach(command),
      'permission.resolve': (command, context) => this.resolveApproval(command, context),
      'provider.enable': (command) => this.enableProvider(command),
      'provider.update': (command) => this.enableProvider(command),
      'provider.disable': (command) => this.disableProvider(command),
    };
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribeProviders = this.options.providers.subscribe((providerId, event) => {
      this.eventTail = this.eventTail
        .then(() => this.handleProviderEvent(providerId, event))
        .catch((error) => this.report('provider event failed', error));
    });
    await this.expirePersistedApprovals();
    await this.recoverUnattachedClaims();
    await this.rehydratePersistedSessions();
    await this.reconcileUnsettled();
    await this.drainEventTail();
    this.rearmPersistedTimeouts();
    this.queuePump();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProviders?.();
    this.unsubscribeProviders = null;
    for (const timer of this.turnTimers.values()) this.clearTimer(timer);
    this.turnTimers.clear();
    await Promise.allSettled([
      this.eventTail,
      this.pumpPromise ?? Promise.resolve(),
      ...this.backgroundTasks,
    ]);
    await this.drainEventTail();
    await this.options.providers.dispose();
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

  private async create(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.create') return commandError('invalid-command', 'Unexpected Agent create command.');
    const { snapshot } = context;
    const workspace = snapshot.workspaces.find((entry) => (
      entry.id === command.payload.workspaceId && !entry.archivedAt
    ));
    if (!workspace) return commandError('not-found', 'Active Workspace was not found.');
    if (snapshot.sessions.some((entry) => entry.id === command.payload.sessionId)) {
      return commandError('invalid-state', 'Session already exists.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, command.payload.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const relation = command.payload.parentSessionId
      ? this.planChildRelation(snapshot, command.payload.parentSessionId, workspace.projectId)
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
        permissionPreset: command.payload.permissionPreset,
        state: 'queued',
        queuedTurnCount: 1,
        orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled,
      } },
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
    ];
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
    return { ok: true, commit: { mutations }, afterCommit: () => this.queuePump() };
  }

  private async resume(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.resume') return commandError('invalid-command', 'Unexpected Agent resume command.');
    const { snapshot } = context;
    const workspace = snapshot.workspaces.find((entry) => (
      entry.id === command.payload.workspaceId && !entry.archivedAt
    ));
    if (!workspace) return commandError('not-found', 'Active Workspace was not found.');
    if (snapshot.sessions.some((entry) => entry.id === command.payload.sessionId)) {
      return commandError('invalid-state', 'Session already exists.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, command.payload.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const relation = command.payload.parentSessionId
      ? this.planChildRelation(snapshot, command.payload.parentSessionId, workspace.projectId)
      : undefined;
    if (relation && !relation.ok) return relation.result;
    const mutations: DaemonStoreMutation[] = [
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
        state: 'starting',
        queuedTurnCount: 0,
        orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled,
      } },
    ];
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
      afterCommit: () => this.runBackground(
        `resume Agent ${command.payload.sessionId}`,
        () => this.rehydrateSession(command.payload.sessionId),
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
    const snapshot = context.snapshot;
    const session = snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent || session.kind !== 'agent') {
      return commandError('not-found', 'Agent Session was not found.');
    }
    if (['archived', 'done', 'interrupted', 'error'].includes(agent.state)) {
      return commandError('invalid-state', 'Agent Session is not available for a new turn.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const currentTurn = agent.currentTurnId
      ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    const hasActiveCurrentTurn = Boolean(currentTurn && ACTIVE_TURN_STATES.has(currentTurn.state));
    const turnId = stableId('turn', command.commandId);
    const now = this.isoNow();
    const mutations: DaemonStoreMutation[] = [{ kind: 'turn.upsert', value: {
      id: turnId,
      sessionId: session.id,
      commandId: command.commandId,
      enqueueSequence: command.expectedRevision + 1,
      state: 'queued',
    } }];
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
      ...this.transcriptMutations([this.userTranscript(
        session.id,
        turnId,
        command.commandId,
        command.payload.prompt,
        now,
      )]),
    );
    return {
      ok: true,
      commit: { mutations },
      afterCommit: () => {
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

  private async interrupt(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.interrupt') return commandError('invalid-command', 'Unexpected Agent interrupt command.');
    const session = context.snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent?.providerSessionId) return commandError('not-found', 'Agent Session was not found.');
    const currentTurn = agent.currentTurnId
      ? context.snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    if (!currentTurn || !ACTIVE_TURN_STATES.has(currentTurn.state)) return { ok: true };
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
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
        `interrupt Agent ${session.id}`,
        () => this.requestInterrupt(session.id, currentTurn.id, agent.providerId, agent.providerSessionId!),
      ),
    };
  }

  private async setSettings(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.set-settings') return commandError('invalid-command', 'Unexpected Agent settings command.');
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!agent?.providerSessionId) return commandError('not-found', 'Agent Session was not found.');
    if (agent.currentTurnId) return commandError('invalid-state', 'Change Agent settings between turns.');
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const nextModel = command.payload.model ?? agent.model;
    const nextPermissionPreset = command.payload.permissionPreset ?? agent.permissionPreset;
    return {
      ok: true,
      commit: { mutations: [{ kind: 'agent.upsert', value: agentInput(agent, {
        ...(nextModel ? { model: nextModel } : {}),
        permissionPreset: nextPermissionPreset,
      }) }] },
      afterCommit: () => this.runBackground(
        `update Agent settings ${agent.sessionId}`,
        () => this.applyProviderSettings(
          agent.sessionId,
          agent.providerId,
          agent.providerSessionId!,
          nextModel,
          nextPermissionPreset,
        ),
      ),
    };
  }

  private async cancel(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.cancel') return commandError('invalid-command', 'Unexpected Agent cancel command.');
    const session = context.snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent) return commandError('not-found', 'Agent Session was not found.');
    const now = this.isoNow();
    const unsettledTurns = context.snapshot.turns.filter((turn) => (
      turn.sessionId === session.id && !TERMINAL_TURN_STATES.has(turn.state)
    ));
    const pendingApprovals = context.snapshot.approvals.filter((approval) => (
      approval.sessionId === session.id && approval.state === 'pending'
    ));
    return { ok: true, commit: { mutations: [
      ...unsettledTurns.map((turn): DaemonStoreMutation => ({
        kind: 'turn.upsert',
        value: turnInput(turn, { state: 'interrupted', finishedAt: now, errorCode: undefined }),
      })),
      ...pendingApprovals.map((approval): DaemonStoreMutation => ({
        kind: 'approval.upsert',
        value: this.resolvedApprovalInput(approval, 'expired', now),
      })),
      { kind: 'agent.upsert', value: agentInput(agent, {
        state: 'interrupted',
        currentTurnId: undefined,
        queuedTurnCount: 0,
      }) },
      { kind: 'session.upsert', value: sessionInput(session, 'interrupted') },
    ] }, afterCommit: () => {
      for (const turn of unsettledTurns) this.clearTurnTimeout(turn.id);
      if (agent.providerSessionId) {
        this.runBackground(
          `cancel Agent ${session.id}`,
          () => this.cancelProviderSession(session.id, agent.providerId, agent.providerSessionId!),
        );
      }
    } };
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
    return { ok: true, commit: { mutations: [
      ...pendingApprovals.map((approval): DaemonStoreMutation => ({
        kind: 'approval.upsert',
        value: this.resolvedApprovalInput(approval, 'expired', now),
      })),
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'archived', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'archived', now) },
    ] }, ...(agent.providerSessionId ? { afterCommit: () => this.runBackground(
      `archive Agent ${session.id}`,
      () => this.disposeProviderSession(session.id, agent.providerId, agent.providerSessionId!),
    ) } : {}) };
  }

  private detach(command: DaemonCommand): DaemonCommandExecutionResult {
    if (command.type !== 'agent.detach') return commandError('invalid-command', 'Unexpected Agent detach command.');
    const snapshot = this.options.getSnapshot();
    const relation = snapshot.agentRelations.find((entry) => (
      entry.childSessionId === command.payload.sessionId && !entry.detachedAt
    ));
    if (!relation) return commandError('not-found', 'Managed Agent relation was not found.');
    return { ok: true, commit: { mutations: [{ kind: 'agent-relation.upsert', value: {
      id: relation.id,
      treeId: relation.treeId,
      parentSessionId: relation.parentSessionId,
      childSessionId: relation.childSessionId,
      owner: relation.owner,
      depth: relation.depth,
      detachedAt: this.isoNow(),
    } }] } };
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
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'working' }) },
      { kind: 'session.upsert', value: sessionInput(session, 'running') },
    ] }, afterCommit: () => this.runBackground(
      `resolve approval ${approval.id}`,
      () => this.resolveProviderApproval(
        agent.providerId,
        agent.sessionId,
        agent.providerSessionId!,
        approval.providerRequestId,
        command.payload.decision,
      ),
    ) };
  }

  private async enableProvider(command: DaemonCommand): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'provider.enable' && command.type !== 'provider.update') {
      return commandError('invalid-command', 'Unexpected provider enable command.');
    }
    const authorized = await this.options.providers.authorizeEnable(command.payload);
    if (!authorized.ok) {
      const code = authorized.code === 'provider-incompatible'
        ? 'provider-incompatible'
        : 'provider-unavailable';
      return commandError(code, authorized.message);
    }
    return {
      ok: true,
      commit: { mutations: [{ kind: 'provider.upsert', value: authorized.value }] },
      afterCommit: () => this.queuePump(),
    };
  }

  private disableProvider(command: DaemonCommand): DaemonCommandExecutionResult {
    if (command.type !== 'provider.disable') return commandError('invalid-command', 'Unexpected provider disable command.');
    const snapshot = this.options.getSnapshot();
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
    return { ok: true, commit: { mutations: [{ kind: 'provider.upsert', value: {
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
    } }] } };
  }

  private planChildRelation(
    snapshot: DaemonSnapshot,
    parentSessionId: string,
    projectId: string,
  ): { readonly ok: true; readonly value: ChildRelationPlan } | {
    readonly ok: false;
    readonly result: DaemonCommandExecutionResult;
  } {
    if (!snapshot.runtime.orchestrationToolsEnabled) {
      return { ok: false, result: commandError(
        'invalid-state',
        'Enable Agent orchestration on this host before creating managed children.',
      ) };
    }
    const parent = snapshot.sessions.find((session) => session.id === parentSessionId);
    const parentAgent = snapshot.agents.find((agent) => agent.sessionId === parentSessionId);
    if (!parent || !parentAgent || parent.kind !== 'agent' || parent.projectId !== projectId) {
      return { ok: false, result: commandError(
        'invalid-state',
        'A managed child must share a Project with an active parent Agent.',
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
    const treeRelations = snapshot.agentRelations.filter((relation) => (
      relation.treeId === treeId && !relation.detachedAt
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
    const recentChildren = treeRelations.filter((relation) => (
      relation.owner === 'managed' && Date.parse(relation.createdAt) >= windowStart
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
  ): ProviderSessionContext {
    const orchestration = orchestrationEnabled
      ? this.options.orchestrationForSession?.(sessionId)
      : undefined;
    return {
      sessionId,
      workspaceId,
      workspaceRoot,
      ...(model ? { model } : {}),
      permissionPreset,
      ...(orchestration ? { orchestration } : {}),
    };
  }

  private userTranscript(
    sessionId: string,
    turnId: string,
    commandId: string,
    text: string,
    createdAt: string,
  ): DaemonTranscriptItemInput {
    return {
      id: stableId('message', commandId, 'user'),
      sessionId,
      turnId,
      kind: 'user-message',
      text,
      isDelta: false,
      isSensitive: false,
      createdAt,
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
          .filter((turn) => turn.state === 'queued')
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
        const workspace = snapshot.workspaces.find((entry) => entry.id === session.workspaceId);
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

      const selected = claim;
      const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), selected.agent.providerId);
      if (!provider.ok) return;
      let providerSessionId = selected.agent.providerSessionId;
      try {
        if (!providerSessionId) {
          const handle = await provider.value.createSession(this.sessionContext(
            selected.session.id,
            selected.workspaceId,
            selected.workspaceRoot,
            selected.agent.model,
            selected.agent.permissionPreset,
            selected.agent.orchestrationEnabled,
          ));
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
              permissionPreset: handle.permissionPreset,
              state: 'working',
            }) }] };
          });
          if (!attached) {
            await provider.value.disposeSession(selected.session.id, handle.providerSessionId);
            continue;
          }
          providerSessionId = handle.providerSessionId;
        }
        await provider.value.submit({
          sessionId: selected.turn.sessionId,
          providerSessionId,
          turnId: selected.turn.id,
          commandId: selected.turn.commandId,
          prompt: selected.prompt,
        });
        let shouldArmTimeout = false;
        await this.transition((snapshot) => {
          const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
          const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
          const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
          if (!turn || !agent || !session || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
            return undefined;
          }
          shouldArmTimeout = ACTIVE_TURN_STATES.has(turn.state);
          if (turn.state !== 'submitting') return undefined;
          return { mutations: [
            { kind: 'turn.upsert', value: turnInput(turn, { state: 'working' }) },
            { kind: 'agent.upsert', value: agentInput(agent, { state: 'working' }) },
            { kind: 'session.upsert', value: sessionInput(session, 'running') },
          ] };
        });
        if (shouldArmTimeout) {
          this.armTurnTimeout(selected.turn.id, selected.turn.sessionId, providerSessionId);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Provider delivery could not be confirmed.';
        let markedUncertain = false;
        await this.transition((snapshot) => {
          const turn = snapshot.turns.find((entry) => entry.id === selected.turn.id);
          const agent = snapshot.agents.find((entry) => entry.sessionId === selected.turn.sessionId);
          const session = snapshot.sessions.find((entry) => entry.id === selected.turn.sessionId);
          if (!turn || !agent || !session || TERMINAL_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
            return undefined;
          }
          markedUncertain = true;
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
        if (markedUncertain && providerSessionId) {
          this.armTurnTimeout(selected.turn.id, selected.turn.sessionId, providerSessionId);
        }
      }
    }
  }

  private async handleProviderEvent(providerId: string, event: AgentProviderEvent): Promise<void> {
    if (this.disposed) return;
    if (event.kind === 'transcript') {
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
      if (failedTurnIds.length > 0) {
        for (const turnId of failedTurnIds) this.clearTurnTimeout(turnId);
        this.queuePump();
      }
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
      let finishedTurnId: string | undefined;
      let releasedCurrent = false;
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
        finishedTurnId = turn.id;
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
                : failed ? 'error' : interrupted ? 'interrupted' : agent.queuedTurnCount > 0 ? 'queued' : 'idle',
              currentTurnId: undefined,
            }) },
            { kind: 'session.upsert' as const, value: sessionInput(
              session,
              hasQueuedSuccessor ? 'idle' : failed ? 'failed' : interrupted ? 'interrupted' : 'idle',
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
          ...(resultSummary && parent && parent.state !== 'archived'
            ? this.transcriptMutations([{
                id: stableId('managed-child-summary', parent.id, event.sessionId, turn.id, resultSummary),
                sessionId: parent.id,
                kind: 'child-summary' as const,
                text: resultSummary,
                isDelta: false,
                isSensitive: false,
                relatedSessionId: event.sessionId,
              }])
            : []),
        ] };
      });
      if (finishedTurnId) this.clearTurnTimeout(finishedTurnId);
      if (releasedCurrent) this.queuePump();
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
        const turn = event.turnId
          ? snapshot.turns.find((entry) => entry.id === event.turnId)
          : agent.currentTurnId
            ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
            : undefined;
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
            ...(event.detail ? { detail: event.detail } : {}),
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
      await this.transition((snapshot) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
        const session = snapshot.sessions.find((entry) => entry.id === sessionId);
        if (!agent || !session || agent.providerId !== providerId || session.state === 'archived') return undefined;
        const turn = agent.currentTurnId
          ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
          : undefined;
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
          ...this.transcriptMutations([{
            id: stableId('provider-error', providerId, sessionId, event.code, event.message),
            sessionId,
            ...(turn ? { turnId: turn.id } : {}),
            kind: 'error',
            text: event.message,
            isDelta: false,
            isSensitive: false,
          }]),
        ] };
      });
      if (terminalTurnIds.length > 0) {
        for (const turnId of terminalTurnIds) this.clearTurnTimeout(turnId);
        this.queuePump();
      }
    }
  }

  private async handleNativeSubagent(
    providerId: string,
    event: Extract<AgentProviderEvent, { kind: 'native-subagent' }>,
  ): Promise<void> {
    await this.transition((snapshot) => {
      const parent = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      const parentAgent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      if (!parent || !parentAgent || parentAgent.providerId !== providerId || parent.state === 'archived') {
        return undefined;
      }
      const childId = stableId('native-agent', providerId, event.sessionId, event.providerChildId);
      const existingSession = snapshot.sessions.find((entry) => entry.id === childId);
      const existingAgent = snapshot.agents.find((entry) => entry.sessionId === childId);
      const existingRelation = snapshot.agentRelations.find((entry) => entry.childSessionId === childId);
      const relationPlan = existingRelation
        ? { treeId: existingRelation.treeId, depth: existingRelation.depth }
        : this.planNativeRelation(snapshot, event.sessionId);
      if (!relationPlan) {
        return { mutations: [{ kind: 'transcript.append', items: [{
          id: stableId('native-agent-limit', providerId, event.sessionId, event.providerChildId),
          sessionId: event.sessionId,
          kind: 'error',
          text: 'A provider-native subagent exceeded the managed tree safety limits.',
          isDelta: false,
          isSensitive: false,
        }] }] };
      }
      const resultSummary = boundedChildSummary(event.summary);
      const summaryMutations = resultSummary
        ? this.transcriptMutations([{
            id: stableId('native-parent-summary', providerId, event.sessionId, event.providerChildId, resultSummary),
            sessionId: event.sessionId,
            kind: 'child-summary',
            text: resultSummary,
            isDelta: false,
            isSensitive: false,
            relatedSessionId: childId,
          }, {
            id: stableId('native-child-summary', providerId, event.sessionId, event.providerChildId, resultSummary),
            sessionId: childId,
            kind: 'notice',
            text: resultSummary,
            isDelta: false,
            isSensitive: false,
            relatedSessionId: event.sessionId,
          }])
        : [];
      if (existingSession && TERMINAL_SESSION_STATES.has(existingSession.state)) {
        return summaryMutations.length > 0 ? { mutations: summaryMutations } : undefined;
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
              projectId: parent.projectId,
              workspaceId: parent.workspaceId,
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
              model: parentAgent.model,
              permissionPreset: parentAgent.permissionPreset,
              state,
              queuedTurnCount: 0,
              orchestrationEnabled: parentAgent.orchestrationEnabled,
            } },
      ];
      if (!existingRelation) mutations.push({ kind: 'agent-relation.upsert', value: {
        id: stableId('relation', relationPlan.treeId, childId),
        treeId: relationPlan.treeId,
        parentSessionId: event.sessionId,
        childSessionId: childId,
        owner: 'provider-native',
        depth: relationPlan.depth,
      } });
      mutations.push(...summaryMutations);
      return { mutations };
    });
  }

  private planNativeRelation(snapshot: DaemonSnapshot, parentSessionId: string): ChildRelationPlan | null {
    const parentRelation = snapshot.agentRelations.find((relation) => (
      relation.childSessionId === parentSessionId && !relation.detachedAt
    ));
    const treeId = parentRelation?.treeId ?? parentSessionId;
    const depth = (parentRelation?.depth ?? 0) + 1;
    if (depth > DAEMON_HARD_LIMITS.treeDepth) return null;
    const relations = snapshot.agentRelations.filter((relation) => (
      relation.treeId === treeId && !relation.detachedAt
    ));
    const nodes = new Set<string>([treeId]);
    for (const relation of relations) {
      nodes.add(relation.parentSessionId);
      nodes.add(relation.childSessionId);
    }
    if (nodes.size >= DAEMON_HARD_LIMITS.nodesPerTree) return null;
    return { treeId, depth };
  }

  private rearmPersistedTimeouts(): void {
    const snapshot = this.options.getSnapshot();
    for (const turn of snapshot.turns) {
      if (!ACTIVE_TURN_STATES.has(turn.state) || !turn.startedAt) continue;
      const agent = snapshot.agents.find((entry) => entry.sessionId === turn.sessionId);
      if (!agent?.providerSessionId) continue;
      const elapsed = Math.max(0, this.now().valueOf() - Date.parse(turn.startedAt));
      this.armTurnTimeout(
        turn.id,
        turn.sessionId,
        agent.providerSessionId,
        Math.max(1, DAEMON_HARD_LIMITS.backgroundTurnMs - elapsed),
      );
    }
  }

  private armTurnTimeout(
    turnId: string,
    sessionId: string,
    providerSessionId: string,
    delayMs = DAEMON_HARD_LIMITS.backgroundTurnMs,
  ): void {
    this.clearTurnTimeout(turnId);
    const timer = this.setTimer(() => {
      this.turnTimers.delete(turnId);
      this.eventTail = this.eventTail
        .then(() => this.expireTurn(turnId, sessionId, providerSessionId))
        .catch((error) => this.report('background Agent timeout failed', error));
    }, delayMs);
    this.turnTimers.set(turnId, timer);
  }

  private clearTurnTimeout(turnId: string): void {
    const timer = this.turnTimers.get(turnId);
    if (!timer) return;
    this.turnTimers.delete(turnId);
    this.clearTimer(timer);
  }

  private async expireTurn(
    turnId: string,
    sessionId: string,
    providerSessionId: string,
  ): Promise<void> {
    const now = this.isoNow();
    let providerId: string | undefined;
    let expired = false;
    await this.transition((snapshot) => {
      const turn = snapshot.turns.find((entry) => entry.id === turnId);
      const session = snapshot.sessions.find((entry) => entry.id === sessionId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
      if (!turn || !session || !agent || !ACTIVE_TURN_STATES.has(turn.state) || agent.currentTurnId !== turn.id) {
        return undefined;
      }
      expired = true;
      providerId = agent.providerId;
      return { mutations: [
        ...this.terminalTurnMutations(
          snapshot,
          sessionId,
          'failed',
          now,
          'background-turn-timeout',
        ),
        ...this.expireApprovalMutations(snapshot, sessionId, undefined, now),
        { kind: 'agent.upsert', value: agentInput(agent, {
          state: 'error',
          currentTurnId: undefined,
          queuedTurnCount: 0,
        }) },
        { kind: 'session.upsert', value: sessionInput(session, 'failed') },
        { kind: 'transcript.append', items: [{
          id: stableId('turn-timeout', turnId),
          sessionId,
          turnId,
          kind: 'error',
          text: 'The background Agent turn exceeded the two-hour safety limit and was interrupted.',
          isDelta: false,
          isSensitive: false,
        }] },
      ] };
    });
    if (!expired || !providerId) return;
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (provider.ok) {
      try {
        await provider.value.interrupt(sessionId, providerSessionId);
      } catch (error) {
        this.report('provider timeout interrupt failed', error);
      }
    }
    this.queuePump();
  }

  private transition(planner: DaemonSystemTransitionPlanner): Promise<unknown> {
    return this.options.applySystemCommit(planner);
  }

  private runBackground(context: string, task: () => Promise<void>): void {
    if (this.disposed) return;
    const running = Promise.resolve()
      .then(task)
      .catch((error) => this.report(context, error))
      .finally(() => this.backgroundTasks.delete(running));
    this.backgroundTasks.add(running);
  }

  private async drainEventTail(): Promise<void> {
    for (;;) {
      const tail = this.eventTail;
      await tail;
      if (tail === this.eventTail) return;
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
  ): DaemonStoreMutation[] {
    return snapshot.approvals
      .filter((approval) => (
        approval.sessionId === sessionId
        && approval.state === 'pending'
        && (turnId === undefined || approval.turnId === undefined || approval.turnId === turnId)
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
      const session = snapshot.sessions.find((entry) => entry.id === agent.sessionId);
      if (
        !agent.providerSessionId
        || !session
        || TERMINAL_AGENT_STATES.has(agent.state)
        || TERMINAL_SESSION_STATES.has(session.state)
      ) continue;
      await this.rehydrateSession(agent.sessionId);
    }
  }

  private async rehydrateSession(sessionId: string): Promise<void> {
    const snapshot = this.options.getSnapshot();
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    const workspace = session
      ? snapshot.workspaces.find((entry) => entry.id === session.workspaceId)
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
      await this.markSessionDeliveryUncertain(sessionId, 'provider-unavailable', provider.message);
      return;
    }
    try {
      const handle = await provider.value.resumeSession({
        ...this.sessionContext(
          sessionId,
          workspace.id,
          workspace.rootPath,
          agent.model,
          agent.permissionPreset,
          agent.orchestrationEnabled,
        ),
        providerSessionId: agent.providerSessionId,
      });
      await this.transition((fresh) => {
        const currentAgent = fresh.agents.find((entry) => entry.sessionId === sessionId);
        const currentSession = fresh.sessions.find((entry) => entry.id === sessionId);
        if (!currentAgent || !currentSession || TERMINAL_SESSION_STATES.has(currentSession.state)) return undefined;
        const hasCurrent = currentAgent.currentTurnId !== undefined;
        return { mutations: [
          { kind: 'agent.upsert', value: agentInput(currentAgent, {
            providerSessionId: handle.providerSessionId,
            ...(handle.model ? { model: handle.model } : {}),
            permissionPreset: handle.permissionPreset,
            ...(!hasCurrent ? { state: currentAgent.queuedTurnCount > 0 ? 'queued' : 'idle' } : {}),
          }) },
          ...(!hasCurrent ? [{
            kind: 'session.upsert' as const,
            value: sessionInput(currentSession, 'idle'),
          }] : []),
        ] };
      });
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'provider-resume-failed',
        error instanceof Error ? error.message : 'Provider Session could not be resumed.',
      );
    }
  }

  private async markSessionDeliveryUncertain(sessionId: string, code: string, detail: string): Promise<void> {
    await this.transition((snapshot) => {
      const session = snapshot.sessions.find((entry) => entry.id === sessionId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
      if (!session || !agent || TERMINAL_SESSION_STATES.has(session.state)) return undefined;
      const turn = agent.currentTurnId
        ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
        : undefined;
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
      await this.markSessionDeliveryUncertain(sessionId, 'interrupt-provider-unavailable', provider.message);
      return;
    }
    try {
      await provider.value.interrupt(sessionId, providerSessionId);
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'interrupt-failed',
        error instanceof Error ? error.message : `Turn ${turnId} could not be interrupted.`,
      );
    }
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
  ): Promise<void> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) {
      await this.markSessionDeliveryUncertain(sessionId, 'approval-provider-unavailable', provider.message);
      return;
    }
    try {
      await provider.value.resolveApproval({ sessionId, providerSessionId, providerRequestId, decision });
    } catch (error) {
      await this.markSessionDeliveryUncertain(
        sessionId,
        'approval-delivery-failed',
        error instanceof Error ? error.message : 'Approval decision could not be delivered.',
      );
    }
  }

  private async cancelProviderSession(
    sessionId: string,
    providerId: string,
    providerSessionId: string,
  ): Promise<void> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) return;
    try {
      await provider.value.interrupt(sessionId, providerSessionId);
    } catch (error) {
      this.report('provider cancel interrupt failed', error);
    }
    await this.disposeProviderSession(sessionId, providerId, providerSessionId);
  }

  private async disposeProviderSession(
    sessionId: string,
    providerId: string,
    providerSessionId: string,
  ): Promise<void> {
    const provider = this.options.providers.enabledAdapter(this.options.getSnapshot(), providerId);
    if (!provider.ok) return;
    try {
      await provider.value.disposeSession(sessionId, providerSessionId);
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
          expanded.push({ ...input, id: stableId('transcript-part', input.id, String(index++)), text: part, isDelta: true });
          part = '';
          partBytes = 0;
        }
        part += character;
        partBytes += bytes;
      }
      if (part) expanded.push({ ...input, id: stableId('transcript-part', input.id, String(index)), text: part, isDelta: true });
    }
    const batches: DaemonTranscriptItemInput[][] = [];
    let batch: DaemonTranscriptItemInput[] = [];
    let bytes = 0;
    for (const item of expanded) {
      const itemBytes = Buffer.byteLength(item.text, 'utf8');
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
        });
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
          let terminalTurnId: string | undefined;
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
              terminalTurnId = turn.id;
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
                      state: state === 'failed' ? 'error' : state === 'interrupted' ? 'interrupted' : currentAgent.queuedTurnCount > 0 ? 'queued' : 'idle',
                      currentTurnId: undefined,
                    }) },
                    { kind: 'session.upsert' as const, value: sessionInput(
                      session,
                      state === 'failed' ? 'failed' : state === 'interrupted' ? 'interrupted' : 'idle',
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
          if (terminalTurnId) this.clearTurnTimeout(terminalTurnId);
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
