import { createHash, randomUUID } from 'node:crypto';

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
} from './daemon-command-router';
import type {
  DaemonStoreCommit,
  DaemonStoreMutation,
  DaemonTranscriptItemInput,
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
  readonly applySystemCommit: (commit: DaemonStoreCommit) => Promise<unknown>;
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

const ACTIVE_TURN_STATES = new Set<DaemonTurn['state']>([
  'submitting',
  'working',
  'blocked',
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
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    commandId: turn.commandId,
    state: patch.state ?? turn.state,
    ...(patch.providerTurnId ?? turn.providerTurnId
      ? { providerTurnId: patch.providerTurnId ?? turn.providerTurnId }
      : {}),
    ...(patch.startedAt ?? turn.startedAt ? { startedAt: patch.startedAt ?? turn.startedAt } : {}),
    ...(patch.finishedAt ?? turn.finishedAt ? { finishedAt: patch.finishedAt ?? turn.finishedAt } : {}),
    ...(patch.errorCode ?? turn.errorCode ? { errorCode: patch.errorCode ?? turn.errorCode } : {}),
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
  private readonly idFactory: () => string;
  private readonly setTimer: NonNullable<DaemonAgentRuntimeOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DaemonAgentRuntimeOptions['clearTimer']>;
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeProviders: (() => void) | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private pumpPromise: Promise<void> | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly options: DaemonAgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
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
    await this.reconcileUnsettled();
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
    await Promise.allSettled([this.eventTail, this.pumpPromise ?? Promise.resolve()]);
    await this.options.providers.dispose();
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
    const shouldQueue = snapshot.turns.filter((turn) => ACTIVE_TURN_STATES.has(turn.state)).length
      >= DAEMON_HARD_LIMITS.concurrentManagedTurns;
    const sessionContext = this.sessionContext(
      command.payload.sessionId,
      workspace.id,
      workspace.rootPath,
      command.payload.model,
      command.payload.permissionPreset,
      snapshot.runtime.orchestrationToolsEnabled,
    );
    await context.markProviderDispatchStarted();
    const handle = await provider.value.createSession(sessionContext);
    if (!shouldQueue) {
      await provider.value.submit({
        sessionId: command.payload.sessionId,
        providerSessionId: handle.providerSessionId,
        turnId,
        commandId: command.commandId,
        prompt: command.payload.initialPrompt,
      });
    }
    const now = this.isoNow();
    if (!shouldQueue) this.armTurnTimeout(turnId, command.payload.sessionId, handle.providerSessionId);
    const mutations: DaemonStoreMutation[] = [
      { kind: 'session.upsert', value: {
        id: command.payload.sessionId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        kind: 'agent',
        title: command.payload.title,
        state: shouldQueue ? 'idle' : 'running',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId: command.payload.sessionId,
        providerId: command.payload.providerId,
        providerSessionId: handle.providerSessionId,
        ...(handle.model ?? command.payload.model ? { model: handle.model ?? command.payload.model } : {}),
        permissionPreset: handle.permissionPreset,
        state: shouldQueue ? 'idle' : 'working',
        ...(!shouldQueue ? { currentTurnId: turnId } : {}),
        queuedTurnCount: shouldQueue ? 1 : 0,
        orchestrationEnabled: snapshot.runtime.orchestrationToolsEnabled,
      } },
      { kind: 'turn.upsert', value: {
        id: turnId,
        sessionId: command.payload.sessionId,
        commandId: command.commandId,
        state: shouldQueue ? 'queued' : 'working',
        ...(!shouldQueue ? { startedAt: now } : {}),
      } },
      { kind: 'transcript.append', items: [this.userTranscript(
        command.payload.sessionId,
        turnId,
        command.commandId,
        command.payload.initialPrompt,
        now,
      )] },
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
    return { ok: true, commit: { mutations } };
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
    await context.markProviderDispatchStarted();
    const handle = await provider.value.resumeSession({
      ...this.sessionContext(
        command.payload.sessionId,
        workspace.id,
        workspace.rootPath,
        command.payload.model,
        command.payload.permissionPreset,
        snapshot.runtime.orchestrationToolsEnabled,
      ),
      providerSessionId: command.payload.providerSessionId,
    });
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
        providerSessionId: handle.providerSessionId,
        ...(handle.model ?? command.payload.model ? { model: handle.model ?? command.payload.model } : {}),
        permissionPreset: handle.permissionPreset,
        state: 'idle',
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
    return { ok: true, commit: { mutations } };
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
    if (!agent.providerSessionId || ['archived', 'done', 'interrupted', 'error'].includes(agent.state)) {
      return commandError('invalid-state', 'Agent Session is not available for a new turn.');
    }
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    const currentTurn = agent.currentTurnId
      ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    const hasActiveCurrentTurn = Boolean(currentTurn && ACTIVE_TURN_STATES.has(currentTurn.state));
    const activeCount = snapshot.turns.filter((turn) => ACTIVE_TURN_STATES.has(turn.state)).length;
    const canStart = interruptFirst
      ? hasActiveCurrentTurn || activeCount < DAEMON_HARD_LIMITS.concurrentManagedTurns
      : !hasActiveCurrentTurn && activeCount < DAEMON_HARD_LIMITS.concurrentManagedTurns;
    const turnId = stableId('turn', command.commandId);
    const now = this.isoNow();
    if (!canStart) {
      return { ok: true, commit: { mutations: [
        { kind: 'turn.upsert', value: {
          id: turnId,
          sessionId: session.id,
          commandId: command.commandId,
          state: 'queued',
        } },
        { kind: 'agent.upsert', value: agentInput(agent, {
          queuedTurnCount: agent.queuedTurnCount + 1,
        }) },
        { kind: 'transcript.append', items: [this.userTranscript(
          session.id,
          turnId,
          command.commandId,
          command.payload.prompt,
          now,
        )] },
      ] } };
    }

    await context.markProviderDispatchStarted();
    if (interruptFirst && currentTurn && hasActiveCurrentTurn) {
      await provider.value.interrupt(session.id, agent.providerSessionId);
      this.clearTurnTimeout(currentTurn.id);
    }
    await provider.value.submit({
      sessionId: session.id,
      providerSessionId: agent.providerSessionId,
      turnId,
      commandId: command.commandId,
      prompt: command.payload.prompt,
    });
    this.armTurnTimeout(turnId, session.id, agent.providerSessionId);
    const mutations: DaemonStoreMutation[] = [];
    if (interruptFirst && currentTurn && hasActiveCurrentTurn) {
      mutations.push({ kind: 'turn.upsert', value: turnInput(currentTurn, {
        state: 'interrupted',
        finishedAt: now,
      }) });
    }
    mutations.push(
      { kind: 'turn.upsert', value: {
        id: turnId,
        sessionId: session.id,
        commandId: command.commandId,
        state: 'working',
        startedAt: now,
      } },
      { kind: 'agent.upsert', value: agentInput(agent, {
        state: 'working',
        currentTurnId: turnId,
      }) },
      { kind: 'session.upsert', value: sessionInput(session, 'running') },
      { kind: 'transcript.append', items: [this.userTranscript(
        session.id,
        turnId,
        command.commandId,
        command.payload.prompt,
        now,
      )] },
    );
    return { ok: true, commit: { mutations } };
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
    await context.markProviderDispatchStarted();
    await provider.value.interrupt(session.id, agent.providerSessionId);
    this.clearTurnTimeout(currentTurn.id);
    const now = this.isoNow();
    return { ok: true, commit: { mutations: [
      { kind: 'turn.upsert', value: turnInput(currentTurn, { state: 'interrupted', finishedAt: now }) },
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'idle', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'idle') },
    ] } };
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
    await context.markProviderDispatchStarted();
    const handle = await provider.value.setSettings({
      sessionId: agent.sessionId,
      providerSessionId: agent.providerSessionId,
      ...(command.payload.model ? { model: command.payload.model } : {}),
      ...(command.payload.permissionPreset
        ? { permissionPreset: command.payload.permissionPreset }
        : {}),
    });
    return { ok: true, commit: { mutations: [{ kind: 'agent.upsert', value: agentInput(agent, {
      providerSessionId: handle.providerSessionId,
      ...(handle.model ? { model: handle.model } : {}),
      permissionPreset: handle.permissionPreset,
    }) }] } };
  }

  private async cancel(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.cancel') return commandError('invalid-command', 'Unexpected Agent cancel command.');
    const session = context.snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent?.providerSessionId) return commandError('not-found', 'Agent Session was not found.');
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    await context.markProviderDispatchStarted();
    if (agent.currentTurnId) await provider.value.interrupt(session.id, agent.providerSessionId);
    await provider.value.disposeSession(session.id, agent.providerSessionId);
    if (agent.currentTurnId) this.clearTurnTimeout(agent.currentTurnId);
    const now = this.isoNow();
    const currentTurn = agent.currentTurnId
      ? context.snapshot.turns.find((entry) => entry.id === agent.currentTurnId)
      : undefined;
    return { ok: true, commit: { mutations: [
      ...(currentTurn && ACTIVE_TURN_STATES.has(currentTurn.state) ? [{
        kind: 'turn.upsert' as const,
        value: turnInput(currentTurn, { state: 'interrupted', finishedAt: now }),
      }] : []),
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'interrupted', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'interrupted') },
    ] } };
  }

  private async archive(
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> {
    if (command.type !== 'agent.archive') return commandError('invalid-command', 'Unexpected Agent archive command.');
    const session = context.snapshot.sessions.find((entry) => entry.id === command.payload.sessionId);
    const agent = context.snapshot.agents.find((entry) => entry.sessionId === command.payload.sessionId);
    if (!session || !agent) return commandError('not-found', 'Agent Session was not found.');
    if (agent.currentTurnId || ACTIVE_TURN_STATES.has(
      context.snapshot.turns.find((entry) => entry.id === agent.currentTurnId)?.state ?? 'completed',
    )) return commandError('invalid-state', 'Stop the Agent before archiving it.');
    if (agent.providerSessionId) {
      const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
      if (provider.ok) {
        await context.markProviderDispatchStarted();
        await provider.value.disposeSession(session.id, agent.providerSessionId);
      }
    }
    const now = this.isoNow();
    return { ok: true, commit: { mutations: [
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'archived', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'archived', now) },
    ] } };
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
    if (!agent?.providerSessionId) return commandError('invalid-state', 'Approval Agent is unavailable.');
    const provider = this.options.providers.enabledAdapter(context.snapshot, agent.providerId);
    if (!provider.ok) return commandError('provider-unavailable', provider.message, true);
    await context.markProviderDispatchStarted();
    await provider.value.resolveApproval({
      sessionId: agent.sessionId,
      providerSessionId: agent.providerSessionId,
      providerRequestId: approval.providerRequestId,
      decision: command.payload.decision,
    });
    const resolvedAt = this.isoNow();
    return { ok: true, commit: { mutations: [
      { kind: 'approval.upsert', value: {
        id: approval.id,
        sessionId: approval.sessionId,
        ...(approval.turnId ? { turnId: approval.turnId } : {}),
        providerRequestId: approval.providerRequestId,
        risk: approval.risk,
        title: approval.title,
        ...(approval.detail ? { detail: approval.detail } : {}),
        state: command.payload.decision === 'allow' ? 'allowed' : 'denied',
        resolvedAt,
      } },
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'working' }) },
    ] } };
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
    return { ok: true, commit: { mutations: [{ kind: 'provider.upsert', value: authorized.value }] } };
  }

  private disableProvider(command: DaemonCommand): DaemonCommandExecutionResult {
    if (command.type !== 'provider.disable') return commandError('invalid-command', 'Unexpected provider disable command.');
    const snapshot = this.options.getSnapshot();
    const current = snapshot.providers.find((entry) => entry.id === command.payload.providerId);
    if (!current) return commandError('not-found', 'Provider was not found.');
    if (snapshot.agents.some((agent) => (
      agent.providerId === current.id && ['starting', 'queued', 'working', 'blocked'].includes(agent.state)
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

  private queuePump(): void {
    if (this.disposed || this.pumpPromise) return;
    this.pumpPromise = Promise.resolve()
      .then(() => this.pumpQueuedTurns())
      .catch((error) => this.report('queued turn pump failed', error))
      .finally(() => {
        this.pumpPromise = null;
      });
  }

  private async pumpQueuedTurns(): Promise<void> {
    while (!this.disposed) {
      const snapshot = this.options.getSnapshot();
      const activeCount = snapshot.turns.filter((turn) => ACTIVE_TURN_STATES.has(turn.state)).length;
      if (activeCount >= DAEMON_HARD_LIMITS.concurrentManagedTurns) return;
      const queued = snapshot.turns
        .filter((turn) => turn.state === 'queued')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const turn = queued.find((candidate) => {
        const agent = snapshot.agents.find((entry) => entry.sessionId === candidate.sessionId);
        return agent && !agent.currentTurnId;
      });
      if (!turn) return;
      const agent = snapshot.agents.find((entry) => entry.sessionId === turn.sessionId)!;
      const session = snapshot.sessions.find((entry) => entry.id === turn.sessionId);
      const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
      const prompt = this.options.readTranscript(turn.sessionId, 0, 2_000).find((item) => (
        item.turnId === turn.id && item.kind === 'user-message'
      ))?.text;
      if (!session || !agent.providerSessionId || !provider.ok || !prompt) {
        await this.options.applySystemCommit({ mutations: [
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: 'failed',
            finishedAt: this.isoNow(),
            errorCode: 'queue-state-invalid',
          }) },
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: 'error',
            queuedTurnCount: Math.max(0, agent.queuedTurnCount - 1),
          }) },
          ...(session ? [{ kind: 'session.upsert' as const, value: sessionInput(session, 'failed') }] : []),
        ] });
        continue;
      }
      const startedAt = this.isoNow();
      await this.options.applySystemCommit({ mutations: [
        { kind: 'turn.upsert', value: turnInput(turn, { state: 'submitting', startedAt }) },
        { kind: 'agent.upsert', value: agentInput(agent, {
          state: 'working',
          currentTurnId: turn.id,
          queuedTurnCount: Math.max(0, agent.queuedTurnCount - 1),
        }) },
        { kind: 'session.upsert', value: sessionInput(session, 'running') },
      ] });
      try {
        await provider.value.submit({
          sessionId: turn.sessionId,
          providerSessionId: agent.providerSessionId,
          turnId: turn.id,
          commandId: turn.commandId,
          prompt,
        });
        await this.options.applySystemCommit({ mutations: [{
          kind: 'turn.upsert',
          value: turnInput({ ...turn, state: 'submitting', startedAt }, { state: 'working' }),
        }] });
        this.armTurnTimeout(turn.id, turn.sessionId, agent.providerSessionId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Provider delivery could not be confirmed.';
        await this.options.applySystemCommit({ mutations: [
          { kind: 'turn.upsert', value: turnInput(turn, {
            state: 'delivery-uncertain',
            startedAt,
            errorCode: 'delivery-uncertain',
          }) },
          { kind: 'agent.upsert', value: agentInput(agent, {
            state: 'delivery-uncertain',
            currentTurnId: turn.id,
            queuedTurnCount: Math.max(0, agent.queuedTurnCount - 1),
          }) },
          { kind: 'session.upsert', value: sessionInput(session, 'delivery-uncertain') },
          { kind: 'transcript.append', items: [{
            id: this.idFactory(),
            sessionId: turn.sessionId,
            turnId: turn.id,
            kind: 'error',
            text: detail,
            isDelta: false,
            isSensitive: false,
          }] },
        ] });
      }
    }
  }

  private async handleProviderEvent(providerId: string, event: AgentProviderEvent): Promise<void> {
    if (this.disposed) return;
    const snapshot = this.options.getSnapshot();
    if (event.kind === 'transcript') {
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.item.sessionId);
      if (!agent || agent.providerId !== providerId) return;
      await this.options.applySystemCommit({ mutations: [{
        kind: 'transcript.append',
        items: [transcriptInput(event.item)],
      }] });
      return;
    }
    if (event.kind === 'session-state') {
      const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      if (!session || !agent || agent.providerId !== providerId) return;
      await this.options.applySystemCommit({ mutations: [
        { kind: 'agent.upsert', value: agentInput(agent, { state: providerStateToAgent(event.state) }) },
        { kind: 'session.upsert', value: sessionInput(session, providerStateToSession(event.state)) },
      ] });
      return;
    }
    if (event.kind === 'turn-started') {
      const turn = snapshot.turns.find((entry) => entry.id === event.turnId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      if (!turn || !agent || !session || agent.providerId !== providerId) return;
      await this.options.applySystemCommit({ mutations: [
        { kind: 'turn.upsert', value: turnInput(turn, {
          state: 'working',
          ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
          startedAt: turn.startedAt ?? this.isoNow(),
        }) },
        { kind: 'agent.upsert', value: agentInput(agent, { state: 'working', currentTurnId: turn.id }) },
        { kind: 'session.upsert', value: sessionInput(session, 'running') },
      ] });
      return;
    }
    if (event.kind === 'turn-finished') {
      const turn = snapshot.turns.find((entry) => entry.id === event.turnId);
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      if (!turn || !agent || !session || agent.providerId !== providerId) return;
      this.clearTurnTimeout(turn.id);
      const failed = event.outcome === 'failed';
      const interrupted = event.outcome === 'interrupted';
      await this.options.applySystemCommit({ mutations: [
        { kind: 'turn.upsert', value: turnInput(turn, {
          state: failed ? 'failed' : interrupted ? 'interrupted' : 'completed',
          finishedAt: this.isoNow(),
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        }) },
        { kind: 'agent.upsert', value: agentInput(agent, {
          state: failed ? 'error' : interrupted ? 'interrupted' : 'idle',
          currentTurnId: undefined,
        }) },
        { kind: 'session.upsert', value: sessionInput(
          session,
          failed ? 'failed' : interrupted ? 'interrupted' : 'idle',
        ) },
        ...(event.summary ? [{ kind: 'transcript.append' as const, items: [{
          id: this.idFactory(),
          sessionId: event.sessionId,
          turnId: event.turnId,
          kind: 'notice' as const,
          text: event.summary,
          isDelta: false,
          isSensitive: false,
        }] }] : []),
      ] });
      this.queuePump();
      return;
    }
    if (event.kind === 'approval-requested') {
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      if (!agent || !session || agent.providerId !== providerId) return;
      const approvalId = stableId('approval', event.sessionId, event.providerRequestId);
      await this.options.applySystemCommit({ mutations: [
        { kind: 'approval.upsert', value: {
          id: approvalId,
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          providerRequestId: event.providerRequestId,
          risk: event.risk,
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          state: 'pending',
        } },
        { kind: 'agent.upsert', value: agentInput(agent, { state: 'blocked' }) },
        { kind: 'session.upsert', value: sessionInput(session, 'needs-attention') },
      ] });
      return;
    }
    if (event.kind === 'native-subagent') {
      await this.handleNativeSubagent(providerId, event, snapshot);
      return;
    }
    if (event.kind === 'provider-error') {
      if (!event.sessionId) {
        this.report(`${providerId} provider error: ${event.code}`, new Error(event.message));
        return;
      }
      const agent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
      const session = snapshot.sessions.find((entry) => entry.id === event.sessionId);
      if (!agent || !session || agent.providerId !== providerId) return;
      await this.options.applySystemCommit({ mutations: [
        { kind: 'agent.upsert', value: agentInput(agent, { state: 'error' }) },
        { kind: 'session.upsert', value: sessionInput(session, 'failed') },
        { kind: 'transcript.append', items: [{
          id: this.idFactory(),
          sessionId: event.sessionId,
          kind: 'error',
          text: event.message,
          isDelta: false,
          isSensitive: false,
        }] },
      ] });
    }
  }

  private async handleNativeSubagent(
    providerId: string,
    event: Extract<AgentProviderEvent, { kind: 'native-subagent' }>,
    snapshot: DaemonSnapshot,
  ): Promise<void> {
    const parent = snapshot.sessions.find((entry) => entry.id === event.sessionId);
    const parentAgent = snapshot.agents.find((entry) => entry.sessionId === event.sessionId);
    if (!parent || !parentAgent || parentAgent.providerId !== providerId) return;
    const childId = stableId('native-agent', providerId, event.providerChildId);
    const existingSession = snapshot.sessions.find((entry) => entry.id === childId);
    const existingAgent = snapshot.agents.find((entry) => entry.sessionId === childId);
    const existingRelation = snapshot.agentRelations.find((entry) => entry.childSessionId === childId);
    const relationPlan = existingRelation
      ? { treeId: existingRelation.treeId, depth: existingRelation.depth }
      : this.planNativeRelation(snapshot, event.sessionId);
    if (!relationPlan) {
      await this.options.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [{
        id: this.idFactory(),
        sessionId: event.sessionId,
        kind: 'error',
        text: 'A provider-native subagent exceeded the managed tree safety limits.',
        isDelta: false,
        isSensitive: false,
      }] }] });
      return;
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
    if (event.summary) mutations.push({ kind: 'transcript.append', items: [{
      id: this.idFactory(),
      sessionId: childId,
      kind: 'child-summary',
      text: event.summary,
      isDelta: false,
      isSensitive: false,
      relatedSessionId: event.sessionId,
    }] });
    await this.options.applySystemCommit({ mutations });
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
    const snapshot = this.options.getSnapshot();
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!turn || !session || !agent || !ACTIVE_TURN_STATES.has(turn.state)) return;
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    if (provider.ok) {
      try {
        await provider.value.interrupt(sessionId, providerSessionId);
      } catch (error) {
        this.report('provider timeout interrupt failed', error);
      }
    }
    const now = this.isoNow();
    await this.options.applySystemCommit({ mutations: [
      { kind: 'turn.upsert', value: turnInput(turn, {
        state: 'failed',
        finishedAt: now,
        errorCode: 'background-turn-timeout',
      }) },
      { kind: 'agent.upsert', value: agentInput(agent, { state: 'error', currentTurnId: undefined }) },
      { kind: 'session.upsert', value: sessionInput(session, 'failed') },
      { kind: 'transcript.append', items: [{
        id: this.idFactory(),
        sessionId,
        turnId,
        kind: 'error',
        text: 'The background Agent turn exceeded the two-hour safety limit and was interrupted.',
        isDelta: false,
        isSensitive: false,
      }] },
    ] });
    this.queuePump();
  }

  private async reconcileUnsettled(): Promise<void> {
    const snapshot = this.options.getSnapshot();
    for (const agent of snapshot.agents) {
      if (!agent.providerSessionId || agent.state === 'archived') continue;
      const turns = snapshot.turns.filter((turn) => (
        turn.sessionId === agent.sessionId
        && ['submitting', 'delivery-uncertain'].includes(turn.state)
      ));
      if (turns.length === 0) continue;
      const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
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
            }] : [];
          }),
        });
        const mutations: DaemonStoreMutation[] = reconciliation.transcriptItems.length > 0
          ? [{ kind: 'transcript.append', items: reconciliation.transcriptItems.map(transcriptInput) }]
          : [];
        for (const result of reconciliation.commands) {
          const turn = turns.find((candidate) => candidate.commandId === result.commandId);
          if (!turn) continue;
          mutations.push({ kind: 'turn.upsert', value: turnInput(turn, {
            state: result.state === 'applied'
              ? 'working'
              : result.state === 'not-applied'
                ? 'queued'
                : 'delivery-uncertain',
            ...(result.providerTurnId ? { providerTurnId: result.providerTurnId } : {}),
          }) });
        }
        if (mutations.length > 0) await this.options.applySystemCommit({ mutations });
      } catch (error) {
        this.report(`provider reconciliation failed for ${agent.sessionId}`, error);
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
