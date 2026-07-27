import { randomUUID } from 'node:crypto';

import type {
  AgentActivity,
  AgentActivitySnapshot,
  AgentApproval,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
  AgentHookEvent,
  AgentProvider,
  AgentSettings,
  AgentStatus,
} from '../shared/agent';
import type { InterpreterFrame, RunStartedInfo, SessionInfo } from '../shared/ipc';
import type { RemotePort } from './interpreter-broker';
import {
  classifyDirectAgentCommand,
  directCommandExecutable,
  executableBasename,
} from '../shared/agent-command';
import { classifyApprovalRisk } from '../shared/agent-risk';
import { APPROVAL_GATE_WINDOW_MS, canGateProvider } from './agent-hook-relay';

const COMPLETED_ACTIVITY_CAP = 100;
const ENDED_PROVIDER_SESSION_TTL_MS = 60_000;
const ENDED_PROVIDER_SESSION_CAP = 200;
const MAX_FOLLOWUP_CHARS = 8192;

export interface AgentActivityBroker {
  attachRun(sessionId: string, runId: string): RemotePort | null;
  listRuns(): Promise<readonly RunStartedInfo[]>;
  listSessions(): readonly SessionInfo[];
  onRunStarted(listener: (info: RunStartedInfo) => void): () => void;
  onInterpreterExited(listener: (code?: number) => void): () => void;
}

interface MutableActivity {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly provider: AgentProvider;
  cwd: string;
  status: AgentStatus;
  readonly createdAt: number;
  updatedAt: number;
  port: RemotePort | null;
  ended: boolean;
  hookSeen: boolean;
  providerSessionIds: Set<string>;
  approval: AgentApproval | null;
}

/** A provider hook parked on this activity, waiting to be told what to do. */
interface PendingApproval {
  readonly settle: (decision: AgentDecision | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface AgentActivityTransition {
  readonly activity: AgentActivity;
  readonly previous: AgentStatus;
}

function publicActivity(record: MutableActivity): AgentActivity {
  return {
    id: record.id,
    sessionId: record.sessionId,
    provider: record.provider,
    cwd: record.cwd,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.approval ? { approval: record.approval } : {}),
  };
}

function providerKey(provider: AgentProvider, value: string): string {
  return `${provider}\0${value}`;
}

export function classifyAgentCommand(commandText: string, settings: AgentSettings): AgentProvider | null {
  const direct = classifyDirectAgentCommand(commandText);
  if (direct) return direct;
  const executable = directCommandExecutable(commandText);
  if (!executable) return null;
  for (const profile of settings.genericProfiles) {
    if (!profile.enabled) continue;
    if (executable === executableBasename(profile.executable)) return 'generic';
  }
  return null;
}

function priority(status: AgentStatus): number {
  if (status === 'blocked') return 0;
  if (status === 'error') return 1;
  if (status === 'waiting') return 2;
  if (status === 'working') return 3;
  if (status === 'starting') return 4;
  return 5;
}

export class AgentActivityService {
  private readonly broker: AgentActivityBroker;
  private readonly getSettings: () => AgentSettings;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly records = new Map<string, MutableActivity>();
  private readonly byRun = new Map<string, MutableActivity>();
  private readonly activeBySessionProvider = new Map<string, MutableActivity>();
  private readonly byProviderSession = new Map<string, MutableActivity>();
  private readonly endedProviderSessions = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly completedIds: string[] = [];
  private readonly snapshotListeners = new Set<(snapshot: AgentActivitySnapshot) => void>();
  private readonly transitionListeners = new Set<(transition: AgentActivityTransition) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private revision = 0;
  private disposed = false;

  constructor(deps: {
    broker: AgentActivityBroker;
    getSettings: () => AgentSettings;
    newId?: () => string;
    now?: () => number;
  }) {
    this.broker = deps.broker;
    this.getSettings = deps.getSettings;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.unsubscribers.push(
      this.broker.onRunStarted((info) => this.handleRunStarted(info)),
      this.broker.onInterpreterExited(() => this.handleInterpreterExit()),
    );
    // Level-triggered catch-up closes the tiny construction race between
    // broker creation and listener registration.
    void this.broker
      .listRuns()
      .then((runs) => {
        for (const run of runs) this.handleRunStarted(run);
      })
      .catch(() => undefined);
  }

  getSnapshot(): AgentActivitySnapshot {
    const items = [...this.records.values()]
      .map(publicActivity)
      .sort((a, b) => priority(a.status) - priority(b.status) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return { revision: this.revision, items };
  }

  onSnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onTransition(listener: (transition: AgentActivityTransition) => void): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  handleHookEvent(event: AgentHookEvent): void {
    if (this.disposed) return;
    const record = this.findRecordForEvent(event);
    if (!record) return;
    this.applyHook(record, event);
  }

  /**
   * Park the provider's permission hook until a human answers it.
   *
   * Every early return resolves to null, which the relay turns into "no
   * output", which the provider turns into its own terminal prompt. Failing
   * open is the only acceptable failure here: a gate that swallows a request
   * it cannot service would leave the agent waiting on nobody.
   */
  async requestApproval(event: AgentHookEvent): Promise<AgentDecision | null> {
    if (this.disposed) return null;
    if (!this.getSettings().approvalGate) return null;
    if (!canGateProvider(event.provider)) return null;
    const record = this.findRecordForEvent(event);
    if (!record || record.ended) return null;
    // A second request for the same activity supersedes the first; the older
    // hook is released rather than left parked behind the newer one.
    this.releaseApproval(record, null);

    const requestedAt = this.now();
    const toolName = event.toolName ?? '';
    record.approval = {
      toolName,
      ...(event.command ? { command: event.command } : {}),
      risk: classifyApprovalRisk(toolName, event.command),
      requestedAt,
      expiresAt: requestedAt + APPROVAL_GATE_WINDOW_MS,
    };
    this.publish();

    return new Promise<AgentDecision | null>((resolve) => {
      const timer = setTimeout(() => this.releaseApproval(record, null), APPROVAL_GATE_WINDOW_MS);
      timer.unref?.();
      this.pendingApprovals.set(record.id, { settle: resolve, timer });
    });
  }

  decideApproval(activityId: string, decision: AgentDecision): AgentDecisionResult {
    const record = this.records.get(activityId);
    if (!record) return { ok: false, error: 'not-found' };
    if (record.ended) return { ok: false, error: 'not-pending' };
    if (!this.pendingApprovals.has(activityId)) {
      return { ok: false, error: record.approval ? 'expired' : 'not-pending' };
    }
    this.releaseApproval(record, decision);
    return { ok: true };
  }

  private findRecordForEvent(event: AgentHookEvent): MutableActivity | null {
    const providerSessionKey = providerKey(event.provider, event.providerSessionId);
    const known = this.byProviderSession.get(providerSessionKey);
    const endedUntil = this.endedProviderSessions.get(providerSessionKey) ?? 0;
    if (!known && endedUntil > this.now()) return null;
    if (!known) this.endedProviderSessions.delete(providerSessionKey);
    // A hook may enrich a run that was independently recognized from its
    // direct executable, but it can never create/promote a run. Session-only
    // wrapper correlation is ambiguous once a pane starts its next command
    // and could otherwise route follow-up input to the wrong PTY.
    return known ?? this.activeBySessionProvider.get(providerKey(event.provider, event.ezSessionId)) ?? null;
  }

  /**
   * Settle a parked hook and drop what should not outlive it.
   *
   * A decision clears the approval outright and puts the agent back to work. An
   * expiry keeps the shape of the card — so the UI can say the window closed
   * rather than silently losing the row — but strips the command text, which is
   * the one field this module promised not to keep.
   */
  private releaseApproval(record: MutableActivity, decision: AgentDecision | null): void {
    const pending = this.pendingApprovals.get(record.id);
    if (!pending) return;
    this.pendingApprovals.delete(record.id);
    clearTimeout(pending.timer);
    pending.settle(decision);
    if (decision) {
      record.approval = null;
      this.setStatus(record, 'working');
      return;
    }
    if (record.approval?.command !== undefined) {
      const { toolName, risk, requestedAt, expiresAt } = record.approval;
      record.approval = { toolName, risk, requestedAt, expiresAt };
    }
    this.publish();
  }

  sendFollowup(activityId: string, text: string): AgentFollowupResult {
    const record = this.records.get(activityId);
    if (!record) return { ok: false, error: 'not-found' };
    if (record.ended) return { ok: false, error: 'session-ended' };
    if (record.status !== 'waiting') return { ok: false, error: 'not-waiting' };
    if (typeof text !== 'string' || /[\r\n]/u.test(text)) return { ok: false, error: 'invalid-text' };
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_FOLLOWUP_CHARS) return { ok: false, error: 'invalid-text' };
    if (!record.port) return { ok: false, error: 'delivery-failed' };
    try {
      record.port.postMessage({ type: 'pty-input', data: `${trimmed}\r` });
    } catch {
      return { ok: false, error: 'delivery-failed' };
    }
    this.setStatus(record, 'working');
    return { ok: true };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [activityId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      pending.settle(null);
      const record = this.records.get(activityId);
      if (record) record.approval = null;
    }
    this.pendingApprovals.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    for (const record of this.records.values()) {
      if (!record.port) continue;
      try {
        record.port.postMessage({ type: 'close' });
        record.port.close();
      } catch {
        // Interpreter already gone.
      }
      record.port = null;
    }
    this.snapshotListeners.clear();
    this.transitionListeners.clear();
    this.endedProviderSessions.clear();
  }

  private handleRunStarted(info: RunStartedInfo): void {
    if (this.disposed || this.byRun.has(info.runId)) return;
    const provider = classifyAgentCommand(info.commandText, this.getSettings());
    if (!provider) return;
    this.startActivity(info, provider);
  }

  private startActivity(info: RunStartedInfo, provider: AgentProvider): MutableActivity {
    const now = this.now();
    const cwd = this.broker.listSessions().find((session) => session.sessionId === info.sessionId)?.cwd ?? '';
    const record: MutableActivity = {
      id: this.newId(),
      sessionId: info.sessionId,
      runId: info.runId,
      provider,
      cwd,
      status: 'working',
      createdAt: now,
      updatedAt: now,
      port: null,
      ended: false,
      hookSeen: false,
      providerSessionIds: new Set(),
      approval: null,
    };
    this.records.set(record.id, record);
    this.byRun.set(record.runId, record);
    this.activeBySessionProvider.set(providerKey(provider, record.sessionId), record);
    this.attach(record);
    this.publish();
    return record;
  }

  private attach(record: MutableActivity): void {
    const port = this.broker.attachRun(record.sessionId, record.runId);
    if (!port) return;
    let mirrorCapRejected = false;
    record.port = port;
    port.on('message', (event) => {
      const frame = event.data as InterpreterFrame;
      if (frame.type === 'error' && frame.message === 'too many mirror viewers for this run') {
        // Degrade to hook-only tracking. This observer owns neither the run nor
        // the mirror cap, so a full cap must not falsely end the real agent.
        mirrorCapRejected = true;
        if (record.port === port) record.port = null;
        return;
      }
      this.handleFrame(record, frame);
    });
    port.on('close', () => {
      if (record.port === port) record.port = null;
      if (mirrorCapRejected) return;
      if (!record.ended) this.finish(record, 'error', false);
    });
    port.start();
  }

  private handleFrame(record: MutableActivity, frame: InterpreterFrame): void {
    if (record.ended) return;
    if (frame.type === 'start' && frame.cwd !== undefined && frame.cwd !== record.cwd) {
      record.cwd = frame.cwd;
      record.updatedAt = this.now();
      this.publish();
    } else if (frame.type === 'end') {
      if (frame.cwd !== undefined) record.cwd = frame.cwd;
      this.finish(record, frame.exitCode !== undefined && frame.exitCode !== 0 ? 'error' : 'done', true);
    } else if (frame.type === 'error') {
      this.finish(record, 'error', true);
    } else if (frame.type === 'cancelled') {
      this.finish(record, 'done', true);
    }
  }

  private applyHook(record: MutableActivity, event: AgentHookEvent): void {
    if (record.ended) return;
    const firstHook = !record.hookSeen;
    record.hookSeen = true;
    record.providerSessionIds.add(event.providerSessionId);
    this.byProviderSession.set(providerKey(event.provider, event.providerSessionId), record);
    if (event.cwd !== record.cwd) {
      record.cwd = event.cwd;
      record.updatedAt = this.now();
      this.publish();
    }

    switch (event.event) {
      case 'SessionStart':
        if (firstHook) this.setStatus(record, 'starting');
        break;
      case 'UserPromptSubmit':
        this.setStatus(record, 'working');
        break;
      case 'PermissionRequest':
        this.setStatus(record, 'blocked');
        break;
      case 'Notification':
        if (event.notificationType === 'permission_prompt') this.setStatus(record, 'blocked');
        else if (event.notificationType === 'idle_prompt') this.setStatus(record, 'waiting');
        // agent_needs_input/agent_completed refer to Claude background
        // sessions. They cannot safely drive the foreground terminal state.
        break;
      case 'Stop':
        this.setStatus(record, 'waiting');
        break;
      case 'StopFailure':
        this.setStatus(record, 'error');
        break;
      case 'SessionEnd':
        this.finish(record, 'done', true);
        break;
      default:
        break;
    }
  }

  private setStatus(record: MutableActivity, status: AgentStatus): void {
    if (record.status === status) return;
    const previous = record.status;
    record.status = status;
    record.updatedAt = this.now();
    this.publish();
    const transition = { activity: publicActivity(record), previous };
    for (const listener of this.transitionListeners) listener(transition);
  }

  private finish(record: MutableActivity, status: 'done' | 'error', closePort: boolean): void {
    if (record.ended) return;
    record.ended = true;
    // The provider is gone; anything still parked on it has to be let go, and
    // a finished run has nothing left to approve.
    this.releaseApproval(record, null);
    record.approval = null;
    this.activeBySessionProvider.delete(providerKey(record.provider, record.sessionId));
    this.byRun.delete(record.runId);
    for (const providerSessionId of record.providerSessionIds) {
      const key = providerKey(record.provider, providerSessionId);
      this.byProviderSession.delete(key);
      this.endedProviderSessions.set(key, this.now() + ENDED_PROVIDER_SESSION_TTL_MS);
    }
    const now = this.now();
    for (const [key, expiresAt] of this.endedProviderSessions) {
      if (expiresAt <= now) this.endedProviderSessions.delete(key);
    }
    while (this.endedProviderSessions.size > ENDED_PROVIDER_SESSION_CAP) {
      const oldest = this.endedProviderSessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.endedProviderSessions.delete(oldest);
    }
    if (closePort && record.port) {
      const port = record.port;
      record.port = null;
      try {
        port.postMessage({ type: 'close' });
        port.close();
      } catch {
        // Run teardown already closed it.
      }
    } else if (!closePort) {
      record.port = null;
    }
    this.setStatus(record, status);
    this.completedIds.push(record.id);
    while (this.completedIds.length > COMPLETED_ACTIVITY_CAP) {
      const oldest = this.completedIds.shift();
      if (oldest) this.records.delete(oldest);
    }
    this.publish();
  }

  private handleInterpreterExit(): void {
    for (const record of [...this.byRun.values()]) this.finish(record, 'error', false);
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }
}
