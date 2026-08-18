import { randomUUID } from 'node:crypto';

import {
  MAX_AGENT_PROVIDER_LABEL_LENGTH,
  type AgentActivity,
  type AgentActivitySnapshot,
  type AgentApproval,
  type AgentDecision,
  type AgentDecisionResult,
  type AgentFollowupResult,
  type AgentHookEvent,
  type AgentProvider,
  type AgentSettings,
  type AgentState,
  type AgentStateSource,
} from '../shared/agent';
import type { InterpreterFrame, PtyTextReadResult, RunStartedInfo, SessionInfo } from '../shared/ipc';
import type { RemotePort } from './interpreter-broker';
import {
  classifyDirectAgentCommand,
  directCommandExecutable,
  executableBasename,
} from '../shared/agent-command';
import { classifyApprovalRisk } from '../shared/agent-risk';
import { isSafeAgentPromptText } from '../shared/agent-coordination';
import { APPROVAL_GATE_WINDOW_MS, canGateProvider } from './agent-hook-relay';

const COMPLETED_ACTIVITY_CAP = 100;
const ENDED_PROVIDER_SESSION_TTL_MS = 60_000;
const ENDED_PROVIDER_SESSION_CAP = 200;
const MAX_FOLLOWUP_CHARS = 8192;
const DECISION_RECEIPT_TTL_MS = 10 * 60_000;
const DECISION_RECEIPT_CAP = 500;

export interface AgentActivityBroker {
  attachRun(sessionId: string, runId: string): RemotePort | null;
  listRuns(): Promise<readonly RunStartedInfo[]>;
  listSessions(): readonly SessionInfo[];
  onRunStarted(listener: (info: RunStartedInfo) => void): () => void;
  onInterpreterExited(listener: (code?: number) => void): () => void;
  readPtyText?(
    sessionId: string,
    runId: string,
    lines?: number,
    maxBytes?: number,
  ): Promise<PtyTextReadResult>;
  submitPtyText?(
    sessionId: string,
    runId: string,
    text: string,
    whenReady?: boolean,
  ): Promise<
    | { readonly ok: true; readonly queued: boolean }
    | { readonly ok: false; readonly reason: string }
  >;
}

interface MutableActivity {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly provider: AgentProvider;
  readonly providerLabel: string;
  cwd: string;
  state: AgentState;
  stateSeq: number;
  live: boolean;
  interactiveReady: boolean;
  stateSource: AgentStateSource;
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
  readonly approvalId: string;
  readonly settle: (decision: AgentDecision | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface DecisionReceipt {
  readonly activityId: string;
  readonly decision: AgentDecision;
  readonly expiresAt: number;
}

export interface AgentActivityTransition {
  readonly activity: AgentActivity;
  readonly previous: AgentState;
}

function publicActivity(record: MutableActivity): AgentActivity {
  return {
    id: record.id,
    sessionId: record.sessionId,
    provider: record.provider,
    providerLabel: record.providerLabel,
    cwd: record.cwd,
    state: record.state,
    status: record.state,
    stateSeq: record.stateSeq,
    live: record.live,
    interactiveReady: record.interactiveReady,
    stateSource: record.stateSource,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.approval ? { approval: record.approval } : {}),
  };
}

function providerKey(provider: AgentProvider, value: string): string {
  return `${provider}\0${value}`;
}

export function classifyAgentCommand(commandText: string, settings: AgentSettings): AgentProvider | null {
  return classifyAgentCommandIdentity(commandText, settings)?.provider ?? null;
}

function classifyAgentCommandIdentity(
  commandText: string,
  settings: AgentSettings,
): { readonly provider: AgentProvider; readonly providerLabel: string } | null {
  const direct = classifyDirectAgentCommand(commandText);
  if (direct) {
    return {
      provider: direct,
      providerLabel: direct === 'codex' ? 'Codex' : 'Claude',
    };
  }
  const executable = directCommandExecutable(commandText);
  if (!executable) return null;
  for (const profile of settings.genericProfiles) {
    if (!profile.enabled) continue;
    if (executable === executableBasename(profile.executable)) {
      return {
        provider: 'generic',
        providerLabel: profile.name.trim().slice(0, MAX_AGENT_PROVIDER_LABEL_LENGTH) || 'CLI',
      };
    }
  }
  return null;
}

function priority(state: AgentState): number {
  if (state === 'blocked') return 0;
  if (state === 'error') return 1;
  if (state === 'done') return 2;
  if (state === 'working') return 3;
  if (state === 'starting') return 4;
  if (state === 'unknown') return 5;
  return 5;
}

export class AgentActivityService {
  private readonly broker: AgentActivityBroker;
  private readonly getSettings: () => AgentSettings;
  private readonly newId: () => string;
  private readonly newApprovalId: () => string;
  private readonly now: () => number;
  private readonly records = new Map<string, MutableActivity>();
  private readonly byRun = new Map<string, MutableActivity>();
  private readonly activeBySessionProvider = new Map<string, MutableActivity>();
  private readonly byProviderSession = new Map<string, MutableActivity>();
  private readonly endedProviderSessions = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly decisionReceipts = new Map<string, DecisionReceipt>();
  private readonly completedIds: string[] = [];
  private readonly snapshotListeners = new Set<(snapshot: AgentActivitySnapshot) => void>();
  private readonly transitionListeners = new Set<(transition: AgentActivityTransition) => void>();
  private readonly observationListeners = new Set<(activity: AgentActivity) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private publishingSnapshots = false;
  private queuedSnapshot: AgentActivitySnapshot | null = null;
  private publishingTransitions = false;
  private readonly queuedTransitions: AgentActivityTransition[] = [];
  private revision = 0;
  private disposed = false;
  private approvalGateEnabled: boolean;

  constructor(deps: {
    broker: AgentActivityBroker;
    getSettings: () => AgentSettings;
    newId?: () => string;
    newApprovalId?: () => string;
    now?: () => number;
  }) {
    this.broker = deps.broker;
    this.getSettings = deps.getSettings;
    this.newId = deps.newId ?? randomUUID;
    this.newApprovalId = deps.newApprovalId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.approvalGateEnabled = this.getSettings().approvalGate;
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
      .sort((a, b) => priority(a.state) - priority(b.state) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
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

  /** Emits only runs that EZTerminal directly recognized, including cwd changes. */
  onObserved(listener: (activity: AgentActivity) => void): () => void {
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
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
    this.applySettings(this.getSettings());
    if (!this.approvalGateEnabled) return null;
    if (!canGateProvider(event.provider)) return null;
    const record = this.findRecordForEvent(event);
    if (!record || record.ended) return null;
    // A second request for the same activity supersedes the first; the older
    // hook is released rather than left parked behind the newer one.
    const previous = this.pendingApprovals.get(record.id);
    if (previous) this.releaseApproval(record, previous.approvalId, null, false);

    const requestedAt = this.now();
    const approvalId = this.newApprovalId();
    const toolName = event.toolName ?? '';
    record.approval = {
      approvalId,
      toolName,
      ...(event.command ? { command: event.command } : {}),
      risk: classifyApprovalRisk(toolName, event.command),
      pending: true,
      requestedAt,
      expiresAt: requestedAt + APPROVAL_GATE_WINDOW_MS,
    };
    const decision = new Promise<AgentDecision | null>((resolve) => {
      const timer = setTimeout(
        () => this.releaseApproval(record, approvalId, null, true),
        APPROVAL_GATE_WINDOW_MS,
      );
      timer.unref?.();
      this.pendingApprovals.set(record.id, { approvalId, settle: resolve, timer });
    });
    // Reserve the exact hook before notifying observers. An in-process
    // subscriber is allowed to answer synchronously from the published
    // snapshot; it must not see a card that is not yet decidable.
    this.publish();
    return decision;
  }

  decideApproval(activityId: string, approvalId: string, decision: AgentDecision): AgentDecisionResult {
    const now = this.now();
    this.pruneDecisionReceipts(now);
    const receipt = this.decisionReceipts.get(approvalId);
    if (receipt) {
      return receipt.activityId === activityId && receipt.decision === decision
        ? { ok: true }
        : { ok: false, error: 'conflict' };
    }
    const record = this.records.get(activityId);
    if (!record) return { ok: false, error: 'not-found' };
    if (record.ended) return { ok: false, error: 'not-pending' };
    const pending = this.pendingApprovals.get(activityId);
    if (!pending) {
      if (!record.approval) return { ok: false, error: 'not-pending' };
      return {
        ok: false,
        error: record.approval.approvalId === approvalId ? 'expired' : 'stale',
      };
    }
    if (pending.approvalId !== approvalId) return { ok: false, error: 'stale' };
    this.decisionReceipts.set(approvalId, {
      activityId,
      decision,
      expiresAt: now + DECISION_RECEIPT_TTL_MS,
    });
    this.pruneDecisionReceipts(now);
    this.releaseApproval(record, approvalId, decision, false);
    return { ok: true };
  }

  /**
   * Reconcile persisted settings with live gates.
   *
   * The settings owner calls this after a successful save. Turning the gate
   * off releases every provider hook immediately; no request remains parked
   * until its timer merely because the preference changed underneath it.
   */
  applySettings(settings: AgentSettings): void {
    const wasEnabled = this.approvalGateEnabled;
    this.approvalGateEnabled = settings.approvalGate;
    if (!wasEnabled || this.approvalGateEnabled) return;
    for (const [activityId, pending] of [...this.pendingApprovals]) {
      const record = this.records.get(activityId);
      if (record) this.releaseApproval(record, pending.approvalId, null, false);
    }
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
  private releaseApproval(
    record: MutableActivity,
    approvalId: string,
    decision: AgentDecision | null,
    retainExpired: boolean,
  ): void {
    const pending = this.pendingApprovals.get(record.id);
    if (!pending || pending.approvalId !== approvalId) return;
    this.pendingApprovals.delete(record.id);
    clearTimeout(pending.timer);
    pending.settle(decision);
    if (decision) {
      record.approval = null;
      this.setState(record, 'working', 'provider-hook');
      return;
    }
    if (!retainExpired) {
      record.approval = null;
    } else if (record.approval?.approvalId === approvalId) {
      const { toolName, risk, requestedAt, expiresAt } = record.approval;
      record.approval = {
        approvalId,
        toolName,
        risk,
        pending: false,
        requestedAt,
        expiresAt,
      };
    }
    this.publish();
  }

  sendFollowup(activityId: string, text: string): AgentFollowupResult {
    const record = this.records.get(activityId);
    if (!record) return { ok: false, error: 'not-found' };
    if (record.ended) return { ok: false, error: 'session-ended' };
    if (record.state !== 'done' && record.state !== 'idle') return { ok: false, error: 'not-ready' };
    if (!isSafeAgentPromptText(text) || text.includes('\r') || text.includes('\n')) {
      return { ok: false, error: 'invalid-text' };
    }
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_FOLLOWUP_CHARS) return { ok: false, error: 'invalid-text' };
    if (!record.port) return { ok: false, error: 'delivery-failed' };
    try {
      record.port.postMessage({ type: 'pty-input', data: `${trimmed}\r` });
    } catch {
      return { ok: false, error: 'delivery-failed' };
    }
    this.setState(record, 'working', 'terminal');
    return { ok: true };
  }

  /** Bounded semantic terminal read. This deliberately does not mark completion seen. */
  readActivity(activityId: string, lines = 80): Promise<PtyTextReadResult> {
    const record = this.records.get(activityId);
    if (!record || record.ended || !this.broker.readPtyText) {
      return Promise.resolve({ ok: false, reason: record ? 'unavailable' : 'run-not-found' });
    }
    return this.broker.readPtyText(record.sessionId, record.runId, lines, 64 * 1024);
  }

  /** Provider-neutral structured submission used by desktop, mobile, and the CLI. */
  async sendPrompt(
    activityId: string,
    text: string,
    options: { readonly whenReady?: boolean } = {},
  ): Promise<AgentFollowupResult> {
    const record = this.records.get(activityId);
    if (!record) return { ok: false, error: 'not-found' };
    if (record.ended || !record.live) return { ok: false, error: 'session-ended' };
    if (!isSafeAgentPromptText(text)) {
      return { ok: false, error: 'invalid-text' };
    }
    const readyState = record.state === 'done' || record.state === 'idle';
    if (!readyState || !record.interactiveReady) {
      return { ok: false, error: 'not-ready' };
    }
    if (!this.broker.submitPtyText) return { ok: false, error: 'delivery-failed' };
    const result = await this.broker.submitPtyText(
      record.sessionId,
      record.runId,
      text,
      options.whenReady === true,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.reason === 'not-ready' ? 'not-ready' : 'delivery-failed',
      };
    }
    this.setState(record, 'working', 'terminal');
    return { ok: true };
  }

  /** Exact sequence acknowledgement: stale focus events cannot hide new work. */
  markSeen(activityId: string, stateSeq: number): boolean {
    const record = this.records.get(activityId);
    if (!record || record.stateSeq !== stateSeq) return false;
    if (record.state !== 'done') return true;
    this.setState(record, 'idle', record.stateSource);
    return true;
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
    this.decisionReceipts.clear();
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
    this.observationListeners.clear();
    this.endedProviderSessions.clear();
  }

  private pruneDecisionReceipts(now: number): void {
    for (const [approvalId, receipt] of this.decisionReceipts) {
      if (receipt.expiresAt <= now) this.decisionReceipts.delete(approvalId);
    }
    while (this.decisionReceipts.size > DECISION_RECEIPT_CAP) {
      const oldest = this.decisionReceipts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.decisionReceipts.delete(oldest);
    }
  }

  private handleRunStarted(info: RunStartedInfo): void {
    if (this.disposed || this.byRun.has(info.runId)) return;
    const identity = classifyAgentCommandIdentity(info.commandText, this.getSettings());
    if (!identity) return;
    this.startActivity(info, identity);
  }

  private startActivity(
    info: RunStartedInfo,
    identity: { readonly provider: AgentProvider; readonly providerLabel: string },
  ): MutableActivity {
    const now = this.now();
    const cwd = this.broker.listSessions().find((session) => session.sessionId === info.sessionId)?.cwd ?? '';
    const record: MutableActivity = {
      id: this.newId(),
      sessionId: info.sessionId,
      runId: info.runId,
      provider: identity.provider,
      providerLabel: identity.providerLabel,
      cwd,
      state: 'starting',
      stateSeq: 1,
      live: true,
      interactiveReady: false,
      stateSource: 'process',
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
    this.activeBySessionProvider.set(providerKey(identity.provider, record.sessionId), record);
    this.attach(record);
    this.publish();
    this.publishObservation(record);
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
      this.publishObservation(record);
    } else if (frame.type === 'end') {
      if (frame.cwd !== undefined) record.cwd = frame.cwd;
      this.finish(record, frame.exitCode !== undefined && frame.exitCode !== 0 ? 'error' : 'done', true);
    } else if (frame.type === 'error') {
      this.finish(record, 'error', true);
    } else if (frame.type === 'cancelled') {
      this.finish(record, 'done', true);
    } else if (frame.type === 'pty-interactive-ready') {
      if (!record.interactiveReady) {
        record.interactiveReady = true;
        record.updatedAt = this.now();
        if (!record.hookSeen && record.state === 'starting') {
          this.setState(record, 'working', 'terminal');
        } else {
          this.publish();
          this.publishObservation(record);
        }
      }
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
      this.publishObservation(record);
    }

    switch (event.event) {
      case 'SessionStart':
        if (firstHook && record.state === 'starting') this.setState(record, 'starting', 'provider-hook');
        break;
      case 'UserPromptSubmit':
        this.setState(record, 'working', 'provider-hook');
        break;
      case 'PermissionRequest':
        this.setState(record, 'blocked', 'provider-hook');
        break;
      case 'Notification':
        if (event.notificationType === 'permission_prompt') this.setState(record, 'blocked', 'provider-hook');
        else if (event.notificationType === 'idle_prompt') this.setState(record, 'done', 'provider-hook');
        // agent_needs_input/agent_completed refer to Claude background
        // sessions. They cannot safely drive the foreground terminal state.
        break;
      case 'Stop':
        this.setState(record, 'done', 'provider-hook');
        break;
      case 'StopFailure':
        this.setState(record, 'error', 'provider-hook');
        break;
      case 'SessionEnd':
        this.finish(record, 'done', true);
        break;
      default:
        break;
    }
  }

  private setState(record: MutableActivity, state: AgentState, source: AgentStateSource): void {
    if (record.state === state && record.stateSource === source) return;
    const previous = record.state;
    record.state = state;
    record.stateSource = source;
    record.stateSeq += 1;
    record.updatedAt = this.now();
    this.publish();
    this.publishTransition({ activity: publicActivity(record), previous });
    this.publishObservation(record);
  }

  private finish(record: MutableActivity, status: 'done' | 'error', closePort: boolean): void {
    if (record.ended) return;
    record.ended = true;
    // The provider is gone; anything still parked on it has to be let go, and
    // a finished run has nothing left to approve.
    const pending = this.pendingApprovals.get(record.id);
    if (pending) this.releaseApproval(record, pending.approvalId, null, false);
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
    record.live = false;
    record.interactiveReady = false;
    this.setState(record, status, 'process');
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
    if (this.publishingSnapshots) {
      // Snapshots are level-triggered. Coalesce nested mutations to the newest
      // state, but finish revision N before publishing N+1.
      this.queuedSnapshot = snapshot;
      return;
    }
    this.publishingSnapshots = true;
    try {
      let next: AgentActivitySnapshot | null = snapshot;
      while (next) {
        this.queuedSnapshot = null;
        for (const listener of [...this.snapshotListeners]) {
          try {
            listener(next);
          } catch {
            // Observers are not part of the state transaction. A destroyed
            // WebContents or faulty notification listener cannot break it.
          }
        }
        next = this.queuedSnapshot;
      }
    } finally {
      this.queuedSnapshot = null;
      this.publishingSnapshots = false;
    }
  }

  private publishTransition(transition: AgentActivityTransition): void {
    this.queuedTransitions.push(transition);
    if (this.publishingTransitions) return;
    this.publishingTransitions = true;
    try {
      while (this.queuedTransitions.length > 0) {
        const next = this.queuedTransitions.shift()!;
        for (const listener of [...this.transitionListeners]) {
          try {
            listener(next);
          } catch {
            // Best-effort notification of already committed state.
          }
        }
      }
    } finally {
      this.queuedTransitions.length = 0;
      this.publishingTransitions = false;
    }
  }

  private publishObservation(record: MutableActivity): void {
    const activity = publicActivity(record);
    for (const listener of [...this.observationListeners]) {
      try {
        listener(activity);
      } catch {
        // Observers persist secondary metadata only; they cannot break a run.
      }
    }
  }
}
