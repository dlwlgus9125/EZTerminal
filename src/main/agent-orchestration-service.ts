import { randomUUID } from 'node:crypto';

import type { AgentActivity, AgentState } from '../shared/agent';
import type { AgentCoordinationMutationResult, ManagedMergeRequest } from '../shared/agent-coordination';
import { isSafeAgentPromptText } from '../shared/agent-coordination';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  MAX_WORKER_RESULT_BYTES,
  type AgentOrchestrationMutationResult,
  type AgentOrchestrationSnapshot,
  type AgentProfile,
  type AgentProviderRef,
  type CollaborationEvent,
  type CollaborationEventKind,
  type CollaborationPolicy,
  type CollaborationPolicyInput,
  type CollaborationRun,
  type CollaborationTask,
  type CollaborationTaskResult,
  type CreateWorkerInput,
  type LegacyTeamMigrationStatus,
  type WorkerPromptInput,
  type WorkerReportInput,
  composeWorkerBrief,
  isTerminalCollaborationRun,
  isTerminalCollaborationTask,
  normalizeWriteScope,
  writeScopesOverlap,
} from '../shared/agent-orchestration';
import type { AgentOrchestrationStore } from './agent-orchestration-store';

const ACTIVE_TASK_STATES = new Set<CollaborationTask['state']>([
  'starting', 'working', 'blocked', 'verifying',
]);

export interface WorkerLaunchResult {
  readonly profileId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly activityId: string;
  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** Begins task delivery only after the worker binding is durably stored. */
  readonly start?: () => Promise<void> | void;
}

export interface WorkerMergePolicyResult {
  readonly eligible: boolean;
  readonly reason?: string;
}

export interface WorkerSourceState {
  readonly clean: boolean;
  readonly head: string;
}

export interface AgentActivityTransitionLike {
  readonly activity: AgentActivity;
  readonly previous: AgentState;
}

function failure<T>(
  error: 'invalid' | 'not-found' | 'stale' | 'conflict' | 'unavailable' | 'forbidden',
  message: string,
): AgentOrchestrationMutationResult<T> {
  return { ok: false, error, message };
}

function boundedSummary(value: string): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, 'utf8') <= MAX_WORKER_RESULT_BYTES) return trimmed;
  const bytes = Buffer.from(trimmed, 'utf8');
  let start = bytes.byteLength - MAX_WORKER_RESULT_BYTES;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function taskWithPatch(
  task: CollaborationTask,
  patch: Partial<CollaborationTask>,
  now: number,
): CollaborationTask {
  return {
    ...task,
    ...patch,
    taskId: task.taskId,
    revision: task.revision + 1,
    updatedAt: now,
  };
}

function runWithTasks(
  run: CollaborationRun,
  tasks: readonly CollaborationTask[],
  now: number,
  state = run.state,
): CollaborationRun {
  return {
    ...run,
    revision: run.revision + 1,
    state,
    tasks,
    updatedAt: now,
    ...(isTerminalCollaborationRun(state) ? { finishedAt: run.finishedAt ?? now } : {}),
  };
}

function reaches(tasks: readonly CollaborationTask[], from: string, target: string): boolean {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  const visit = (taskId: string): boolean => {
    if (taskId === target) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    return byId.get(taskId)?.dependsOn.some(visit) ?? false;
  };
  return visit(from);
}

export class AgentOrchestrationService {
  private readonly listeners = new Set<(snapshot: AgentOrchestrationSnapshot) => void>();
  private readonly scheduling = new Map<string, Promise<void>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private revision = 0;
  private disposed = false;

  constructor(private readonly deps: {
    readonly store: AgentOrchestrationStore;
    readonly providers: () => readonly AgentProviderRef[];
    readonly profiles: () => readonly AgentProfile[];
    readonly launchWorker: (
      run: CollaborationRun,
      task: CollaborationTask,
      profile: AgentProfile,
      prompt: string,
    ) => Promise<WorkerLaunchResult>;
    readonly stopSession: (sessionId: string) => void;
    readonly promptActivity: (activityId: string, text: string) => Promise<{ readonly ok: boolean }>;
    readonly readActivity: (activityId: string) => Promise<string | null>;
    readonly activity: (activityId: string) => AgentActivity | null;
    readonly inspectWorkerSource: (task: CollaborationTask) => Promise<WorkerSourceState | null>;
    readonly evaluateMergePolicy: (
      task: CollaborationTask,
      policy: CollaborationPolicy,
      targetBranch: string,
    ) => Promise<WorkerMergePolicyResult>;
    readonly grantPolicyMerge: (
      task: CollaborationTask,
      targetBranch: string,
    ) => AgentCoordinationMutationResult<{ readonly expiresAt: number }>;
    readonly requestMerge: (
      activityId: string,
      targetBranch: string,
    ) => Promise<AgentCoordinationMutationResult<ManagedMergeRequest>>;
    readonly projectExists: (projectId: string) => boolean;
    readonly newId?: () => string;
    readonly now?: () => number;
  }) {}

  getSnapshot(): AgentOrchestrationSnapshot {
    return {
      revision: this.revision,
      providers: this.deps.providers(),
      profiles: this.deps.profiles(),
      policies: this.deps.store.listPolicies(),
      runs: this.deps.store.listRuns(),
      events: this.deps.store.listEvents(),
      migration: this.deps.store.migrationStatus,
    };
  }

  onSnapshot(listener: (snapshot: AgentOrchestrationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  profilesChanged(): void {
    this.publish();
  }

  async savePolicy(input: CollaborationPolicyInput): Promise<AgentOrchestrationMutationResult<CollaborationPolicy>> {
    if (!this.deps.projectExists(input.projectId)) return failure('not-found', 'Project not found.');
    const knownProfiles = new Set(this.deps.profiles().map((profile) => profile.profileId));
    if (input.allowedWorkerProfileIds.some((profileId) => !knownProfiles.has(profileId))) {
      return failure('invalid', 'The policy references an unavailable worker profile.');
    }
    const result = await this.deps.store.savePolicy(input);
    if (result.ok) this.publish();
    return result;
  }

  async confirmLegacyMigration(): Promise<LegacyTeamMigrationStatus> {
    const status = await this.deps.store.confirmLegacyMigration();
    this.publish();
    return status;
  }

  isWorkerSession(sessionId: string): boolean {
    return this.deps.store.workerRunForSession(sessionId) !== undefined;
  }

  canLead(source: AgentActivity): boolean {
    if (!source.live || !source.projectId || this.isWorkerSession(source.sessionId)) return false;
    const policy = this.deps.store.getPolicy(source.projectId);
    return Boolean(policy?.enabled && !this.deps.store.migrationStatus.required);
  }

  async createWorker(
    source: AgentActivity,
    input: CreateWorkerInput,
  ): Promise<AgentOrchestrationMutationResult<{ readonly run: CollaborationRun; readonly task: CollaborationTask }>> {
    if (!this.canLead(source) || !source.projectId) {
      return failure('forbidden', 'This session is not an enabled project Lead.');
    }
    const policy = this.deps.store.getPolicy(source.projectId)!;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
    const dependsOn = input.dependsOn ? [...input.dependsOn] : [];
    const writeScopes = input.mode === 'write'
      ? (input.writeScopes ?? []).map(normalizeWriteScope)
      : [];
    if (title.length < 1 || title.length > 160
      || !isSafeAgentPromptText(brief)
      || !['read-only', 'write', 'verify'].includes(input.mode)
      || dependsOn.length !== new Set(dependsOn).size
      || writeScopes.some((scope) => scope === null)
      || (input.mode === 'write' && writeScopes.length === 0)
      || (input.mode !== 'write' && (input.writeScopes?.length ?? 0) > 0)) {
      return failure('invalid', 'Worker title, brief, dependencies, mode, or write scopes are invalid.');
    }
    const profile = this.deps.profiles().find((candidate) => candidate.profileId === input.profileId);
    const neededCapability = input.mode === 'write' ? 'write' : input.mode === 'verify' ? 'verify' : 'read';
    if (!profile?.available
      || !profile.capabilities.includes('worker')
      || !profile.capabilities.includes(neededCapability)
      || !policy.allowedWorkerProfileIds.includes(profile.profileId)) {
      return failure('forbidden', 'The selected worker profile is not allowed for this task.');
    }

    let run = this.deps.store.activeRunForLead(source.sessionId);
    const now = this.now();
    if (!run) {
      const created: CollaborationRun = {
        schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION,
        runId: this.newId(),
        revision: 1,
        projectId: source.projectId,
        leadSessionId: source.sessionId,
        leadActivityId: source.id,
        policyRevision: policy.revision,
        state: 'active',
        tasks: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + policy.limits.maxDurationMs,
      };
      const saved = await this.deps.store.createRun(created);
      if (!saved.ok) return saved;
      run = saved.value;
      this.armExpiry(run);
    }
    this.armExpiry(run);
    if (run.projectId !== source.projectId || run.leadActivityId !== source.id) {
      return failure('conflict', 'The active run belongs to another Lead activity.');
    }
    if (run.policyRevision !== policy.revision) {
      return failure('stale', 'Project collaboration policy changed; complete or stop the current run.');
    }
    if (run.expiresAt <= now) {
      await this.stopRun(source, run.runId);
      return failure('unavailable', 'The Lead delegation cycle reached its two-hour limit.');
    }
    if (run.tasks.length >= policy.limits.maxCreated) {
      return failure('unavailable', 'The Lead delegation cycle reached its worker creation limit.');
    }
    if (dependsOn.some((taskId) => !run!.tasks.some((task) => task.taskId === taskId))) {
      return failure('invalid', 'Every dependency must belong to this Lead run.');
    }
    if (input.mode === 'verify') {
      const target = run.tasks.find((task) => task.taskId === input.verifiesTaskId);
      if (!target || target.mode !== 'write' || !dependsOn.includes(target.taskId)) {
        return failure('invalid', 'A verifier must depend on the write task it verifies.');
      }
    } else if (input.verifiesTaskId !== undefined) {
      return failure('invalid', 'Only verifier tasks may select a task to verify.');
    }
    const normalizedWriteScopes = writeScopes as string[];
    if (input.mode === 'write') {
      const overlap = run.tasks.find((task) => (
        task.mode === 'write'
        && !isTerminalCollaborationTask(task.state)
        && !dependsOn.some((dependency) => dependency === task.taskId || reaches(run!.tasks, dependency, task.taskId))
        && writeScopesOverlap(normalizedWriteScopes, task.writeScopes)
      ));
      if (overlap) {
        return failure('conflict', `Write scope overlaps runnable task “${overlap.title}”; replan the assignments.`);
      }
    }
    const task: CollaborationTask = {
      taskId: this.newId(),
      revision: 1,
      title,
      brief,
      mode: input.mode,
      dependsOn,
      writeScopes: normalizedWriteScopes,
      profileId: profile.profileId,
      ...(input.verifiesTaskId ? { verifiesTaskId: input.verifiesTaskId } : {}),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    const updated = await this.deps.store.updateRun(run.runId, (current) => {
      // Worker launch state can advance between the Lead request and this
      // serialized write. Revalidate against the current graph instead of
      // rejecting a sound dependency edit solely because `starting` landed.
      if (current.tasks.some((entry) => entry.taskId === task.taskId)
        || current.tasks.length >= policy.limits.maxCreated
        || dependsOn.some((taskId) => !current.tasks.some((entry) => entry.taskId === taskId))) return null;
      if (task.mode === 'write' && current.tasks.some((candidate) => (
        candidate.mode === 'write'
        && !isTerminalCollaborationTask(candidate.state)
        && !dependsOn.some((dependency) => dependency === candidate.taskId
          || reaches(current.tasks, dependency, candidate.taskId))
        && writeScopesOverlap(task.writeScopes, candidate.writeScopes)
      ))) return null;
      return { run: runWithTasks(current, [...current.tasks, task], now) };
    });
    if (!updated.ok) return updated;
    this.publish();
    this.schedule(updated.value.runId);
    return { ok: true, value: { run: updated.value, task } };
  }

  listWorkers(source: AgentActivity): AgentOrchestrationMutationResult<CollaborationRun | null> {
    if (!this.canLead(source)) return failure('forbidden', 'This session is not an enabled project Lead.');
    return { ok: true, value: this.deps.store.activeRunForLead(source.sessionId) ?? null };
  }

  listProfiles(source: AgentActivity): AgentOrchestrationMutationResult<readonly AgentProfile[]> {
    if (!this.canLead(source) || !source.projectId) {
      return failure('forbidden', 'This session is not an enabled project Lead.');
    }
    const allowed = new Set(this.deps.store.getPolicy(source.projectId)?.allowedWorkerProfileIds ?? []);
    return {
      ok: true,
      value: this.deps.profiles().filter((profile) => profile.available && allowed.has(profile.profileId)),
    };
  }

  readWorker(source: AgentActivity, taskId: string): AgentOrchestrationMutationResult<CollaborationTask> {
    const run = this.deps.store.activeRunForLead(source.sessionId)
      ?? this.deps.store.listRuns().find((candidate) => candidate.leadSessionId === source.sessionId);
    const task = run?.tasks.find((candidate) => candidate.taskId === taskId);
    return task ? { ok: true, value: task } : failure('not-found', 'Worker task not found.');
  }

  async promptWorker(
    source: AgentActivity,
    input: WorkerPromptInput,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>> {
    const taskResult = this.readWorker(source, input.taskId);
    if (!taskResult.ok) return taskResult;
    const task = taskResult.value;
    if (!task.worker?.activityId || isTerminalCollaborationTask(task.state) || !isSafeAgentPromptText(input.text)) {
      return failure('conflict', 'The worker is not ready for a Lead follow-up.');
    }
    const result = await this.deps.promptActivity(task.worker.activityId, input.text);
    return result.ok ? { ok: true, value: task } : failure('unavailable', 'The worker did not accept the follow-up.');
  }

  async cancelWorker(
    source: AgentActivity,
    taskId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>> {
    const run = this.deps.store.activeRunForLead(source.sessionId);
    const task = run?.tasks.find((candidate) => candidate.taskId === taskId);
    if (!run || !task) return failure('not-found', 'Worker task not found.');
    if (isTerminalCollaborationTask(task.state)) return { ok: true, value: task };
    const now = this.now();
    const result = await this.deps.store.updateRun(run.runId, (current) => {
      const currentTask = current.tasks.find((candidate) => candidate.taskId === taskId);
      if (!currentTask || isTerminalCollaborationTask(currentTask.state)) return null;
      const nextTask = taskWithPatch(currentTask, {
        state: 'canceled',
        error: 'Stopped by Lead or user.',
        ...(currentTask.worker ? { worker: { ...currentTask.worker, finishedAt: now } } : {}),
      }, now);
      return {
        run: runWithTasks(current, current.tasks.map((candidate) => candidate.taskId === taskId ? nextTask : candidate), now),
        events: [this.event(current, nextTask, 'worker-canceled', `${nextTask.title} was stopped.`)],
      };
    });
    if (!result.ok) return result;
    if (task.worker?.sessionId) this.deps.stopSession(task.worker.sessionId);
    this.publish();
    this.schedule(result.value.runId);
    void this.flushLead(result.value.runId);
    return { ok: true, value: result.value.tasks.find((candidate) => candidate.taskId === taskId)! };
  }

  async archiveWorker(
    source: AgentActivity,
    taskId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>> {
    const run = this.deps.store.listRuns().find((candidate) => candidate.leadSessionId === source.sessionId
      && candidate.tasks.some((task) => task.taskId === taskId));
    const task = run?.tasks.find((candidate) => candidate.taskId === taskId);
    if (!run || !task) return failure('not-found', 'Worker task not found.');
    if (!isTerminalCollaborationTask(task.state) && task.state !== 'awaiting-merge') {
      return failure('conflict', 'Stop or finish the worker before archiving it.');
    }
    if (task.archivedAt !== undefined) return { ok: true, value: task };
    const now = this.now();
    const result = await this.deps.store.updateRun(run.runId, (current) => {
      const target = current.tasks.find((candidate) => candidate.taskId === taskId);
      if (!target || target.archivedAt !== undefined) return null;
      const nextTask = taskWithPatch(target, {
        archivedAt: now,
        ...(target.worker ? { worker: { ...target.worker, archivedAt: now } } : {}),
      }, now);
      return { run: runWithTasks(current, current.tasks.map((candidate) => candidate.taskId === taskId ? nextTask : candidate), now) };
    });
    if (!result.ok) return result;
    if (task.worker?.sessionId) this.deps.stopSession(task.worker.sessionId);
    this.publish();
    return { ok: true, value: result.value.tasks.find((candidate) => candidate.taskId === taskId)! };
  }

  async stopRun(
    source: AgentActivity,
    runId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationRun>> {
    const run = this.deps.store.getRun(runId);
    if (!run || run.leadSessionId !== source.sessionId) return failure('not-found', 'Lead run not found.');
    if (isTerminalCollaborationRun(run.state)) return { ok: true, value: run };
    const now = this.now();
    const result = await this.deps.store.updateRun(runId, (current) => ({
      run: runWithTasks(current, current.tasks.map((task) => isTerminalCollaborationTask(task.state) ? task : taskWithPatch(task, {
        state: 'canceled',
        error: 'Lead run stopped.',
        ...(task.worker ? { worker: { ...task.worker, finishedAt: now } } : {}),
      }, now)), now, 'stopped'),
    }));
    if (!result.ok) return result;
    this.clearExpiry(runId);
    for (const task of result.value.tasks) {
      if (task.worker?.sessionId) this.deps.stopSession(task.worker.sessionId);
    }
    this.publish();
    return result;
  }

  async completeRun(
    source: AgentActivity,
    runId: string,
  ): Promise<AgentOrchestrationMutationResult<CollaborationRun>> {
    const run = this.deps.store.getRun(runId);
    if (!run || run.leadSessionId !== source.sessionId) return failure('not-found', 'Lead run not found.');
    if (run.tasks.some((task) => !isTerminalCollaborationTask(task.state) && task.state !== 'awaiting-merge')) {
      return failure('conflict', 'Workers are still active or waiting for verification.');
    }
    const now = this.now();
    const result = await this.deps.store.updateRun(runId, (current) => ({
      run: runWithTasks(current, current.tasks, now, 'completed'),
    }));
    if (result.ok) {
      this.clearExpiry(runId);
      this.publish();
    }
    return result;
  }

  async reportWorker(
    source: AgentActivity,
    taskId: string,
    input: WorkerReportInput,
  ): Promise<AgentOrchestrationMutationResult<CollaborationTask>> {
    const located = this.taskForWorkerSession(source.sessionId);
    if (!located) return failure('forbidden', 'This session is not an active worker.');
    const { run, task } = located;
    if (task.taskId !== taskId) return failure('forbidden', 'A worker may report only its own task.');
    if (isTerminalCollaborationTask(task.state) || task.state === 'awaiting-verification' || task.state === 'awaiting-merge') {
      return failure('conflict', 'This worker has already reported its result.');
    }
    if ((input.outcome !== 'succeeded' && input.outcome !== 'failed')
      || typeof input.summary !== 'string'
      || input.summary.trim().length === 0
      || !isSafeAgentPromptText(input.summary)
      || Buffer.byteLength(input.summary, 'utf8') > MAX_WORKER_RESULT_BYTES
      || (input.sourceHead !== undefined && (
        typeof input.sourceHead !== 'string' || !/^[0-9a-f]{40,64}$/u.test(input.sourceHead)
      ))
      || (input.verifiesTaskId !== undefined && typeof input.verifiesTaskId !== 'string')
      || (input.verifiesHead !== undefined && (
        typeof input.verifiesHead !== 'string' || !/^[0-9a-f]{40,64}$/u.test(input.verifiesHead)
      ))
      || ((input.verifiesTaskId === undefined) !== (input.verifiesHead === undefined))
      || (task.mode !== 'write' && input.sourceHead !== undefined)
      || (task.mode !== 'verify' && input.verifiesTaskId !== undefined)
      || (input.outcome === 'failed' && (
        input.sourceHead !== undefined || input.verifiesTaskId !== undefined
      ))) {
      return failure('invalid', 'Worker report outcome or summary is invalid.');
    }
    let sourceState: WorkerSourceState | null = null;
    if (task.mode === 'write' && input.outcome === 'succeeded') {
      sourceState = await this.deps.inspectWorkerSource(task);
      if (!sourceState?.clean) return failure('conflict', 'Commit or remove every worker change before reporting success.');
      if (input.sourceHead && input.sourceHead !== sourceState.head) {
        return failure('stale', 'The reported source revision does not match the worker worktree.');
      }
    }
    if (task.mode === 'verify' && input.outcome === 'succeeded') {
      const target = run.tasks.find((candidate) => candidate.taskId === input.verifiesTaskId);
      const targetHead = target?.result?.sourceHead;
      if (!target || target.mode !== 'write' || !targetHead
        || input.verifiesTaskId !== target.taskId
        || input.verifiesHead !== targetHead
        || target.state !== 'awaiting-verification'
        || target.worker?.sessionId === task.worker?.sessionId) {
        return failure('stale', 'Verifier approval must name the exact current writer revision.');
      }
      const verifiedSource = await this.deps.inspectWorkerSource(task);
      if (!verifiedSource?.clean || verifiedSource.head !== targetHead) {
        return failure('stale', 'The writer worktree changed after the revision selected for verification.');
      }
    }
    const now = this.now();
    const report: CollaborationTaskResult = {
      outcome: input.outcome,
      summary: boundedSummary(input.summary),
      ...(sourceState ? { sourceHead: sourceState.head } : {}),
      ...(input.verifiesTaskId ? { verifiesTaskId: input.verifiesTaskId } : {}),
      ...(input.verifiesHead ? { verifiesHead: input.verifiesHead } : {}),
      reportedAt: now,
    };
    const result = await this.deps.store.updateRun(run.runId, (current) => {
      const currentTask = current.tasks.find((candidate) => candidate.taskId === task.taskId);
      if (!currentTask || currentTask.revision !== task.revision) return null;
      let nextState: CollaborationTask['state'] = input.outcome === 'failed'
        ? 'failed'
        : currentTask.mode === 'write' ? 'awaiting-verification' : 'completed';
      let tasks = current.tasks.map((candidate) => candidate.taskId === currentTask.taskId
        ? taskWithPatch(currentTask, {
            state: nextState,
            result: report,
            ...(input.outcome === 'failed' ? { error: report.summary } : {}),
            ...(currentTask.worker ? { worker: { ...currentTask.worker, finishedAt: now } } : {}),
          }, now)
        : candidate);
      const events: CollaborationEvent[] = [];
      let nextTask = tasks.find((candidate) => candidate.taskId === currentTask.taskId)!;
      if (currentTask.mode === 'verify' && input.outcome === 'succeeded' && report.verifiesTaskId) {
        const currentWriter = current.tasks.find((candidate) => candidate.taskId === report.verifiesTaskId);
        if (!currentWriter
          || currentWriter.mode !== 'write'
          || currentWriter.state !== 'awaiting-verification'
          || currentWriter.result?.sourceHead !== report.verifiesHead
          || currentWriter.worker?.sessionId === currentTask.worker?.sessionId) return null;
        tasks = tasks.map((candidate) => candidate.taskId === report.verifiesTaskId
          ? taskWithPatch(candidate, { state: 'awaiting-merge' }, now)
          : candidate);
        nextState = 'completed';
        nextTask = tasks.find((candidate) => candidate.taskId === currentTask.taskId)!;
        const writer = tasks.find((candidate) => candidate.taskId === report.verifiesTaskId)!;
        events.push(this.event(current, writer, 'merge-ready', `${writer.title} passed independent verification and is ready to merge.`));
      }
      events.push(this.event(
        current,
        nextTask,
        input.outcome === 'succeeded' ? 'worker-completed' : 'worker-failed',
        report.summary,
      ));
      const runState = input.outcome === 'failed' ? 'needs-attention' : current.state;
      return { run: runWithTasks(current, tasks, now, runState), events };
    });
    if (!result.ok) return result;
    this.publish();
    this.schedule(result.value.runId);
    void this.flushLead(result.value.runId);
    const finished = result.value.tasks.find((candidate) => candidate.taskId === task.taskId)!;
    if (finished.mode !== 'write' && finished.worker?.sessionId) {
      const timer = setTimeout(() => this.deps.stopSession(finished.worker!.sessionId!), 750);
      timer.unref?.();
    }
    return { ok: true, value: finished };
  }

  async requestWorkerMerge(
    source: AgentActivity,
    taskId: string,
    targetBranch: string,
  ): Promise<AgentOrchestrationMutationResult<ManagedMergeRequest>> {
    const run = this.deps.store.activeRunForLead(source.sessionId)
      ?? this.deps.store.listRuns().find((candidate) => candidate.leadSessionId === source.sessionId && candidate.tasks.some((task) => task.taskId === taskId));
    const task = run?.tasks.find((candidate) => candidate.taskId === taskId);
    const policy = run ? this.deps.store.getPolicy(run.projectId) : undefined;
    if (!run || !task || !policy || task.state !== 'awaiting-merge' || !task.worker?.activityId) {
      return failure('conflict', 'This writer is not ready to merge.');
    }
    const verifier = run.tasks.find((candidate) => candidate.mode === 'verify'
      && candidate.result?.outcome === 'succeeded'
      && candidate.result.verifiesTaskId === task.taskId
      && candidate.result.verifiesHead === task.result?.sourceHead
      && candidate.worker?.sessionId !== task.worker?.sessionId);
    if (!verifier) return failure('conflict', 'An independent verifier has not approved this exact source revision.');
    if (!policy.mergePolicy.targetBranches.includes(targetBranch)) {
      return failure('forbidden', 'The target branch is outside project merge policy.');
    }
    const evaluation = await this.deps.evaluateMergePolicy(task, policy, targetBranch);
    if (policy.permissionMode === 'safe-auto' && evaluation.eligible) {
      const granted = this.deps.grantPolicyMerge(task, targetBranch);
      if (!granted.ok) return failure(granted.error, granted.message);
    }
    const requested = await this.deps.requestMerge(task.worker.activityId, targetBranch);
    if (!requested.ok) return failure(requested.error, requested.message);
    return { ok: true, value: requested.value };
  }

  handleActivityTransition(transition: AgentActivityTransitionLike): void {
    if (this.disposed) return;
    const located = this.taskForActivity(transition.activity.id);
    if (located && !isTerminalCollaborationTask(located.task.state)
      && located.task.state !== 'awaiting-verification'
      && located.task.state !== 'awaiting-merge') {
      if (transition.activity.state === 'blocked') {
        void this.transitionWorkerState(located.run, located.task, 'blocked', 'worker-blocked', `${located.task.title} needs permission or input.`);
      } else if (transition.activity.state === 'working' && located.task.state === 'blocked') {
        void this.transitionWorkerState(located.run, located.task, located.task.mode === 'verify' ? 'verifying' : 'working');
      } else if (transition.activity.state === 'error' || (!transition.activity.live && transition.activity.state === 'done')) {
        void this.failUnreportedWorker(located.run, located.task, transition.activity.state === 'error'
          ? 'Worker process ended with an error before reporting.'
          : 'Worker exited before sending a structured result.');
      } else if (transition.activity.state === 'done') {
        void this.failUnreportedWorker(located.run, located.task, 'Worker finished without sending a structured result.');
      }
    }
    const leadRun = this.deps.store.activeRunForLead(transition.activity.sessionId);
    if (leadRun && (transition.activity.state === 'done' || transition.activity.state === 'idle')) {
      void this.flushLead(leadRun.runId);
    }
  }

  handleSessionRemoved(sessionId: string): void {
    const worker = this.taskForWorkerSession(sessionId);
    if (worker && !isTerminalCollaborationTask(worker.task.state)
      && worker.task.state !== 'awaiting-verification'
      && worker.task.state !== 'awaiting-merge') {
      void this.failUnreportedWorker(worker.run, worker.task, 'Worker session ended before reporting.');
    }
    const lead = this.deps.store.activeRunForLead(sessionId);
    if (lead) {
      const source = this.deps.activity(lead.leadActivityId);
      if (source) void this.stopRun(source, lead.runId);
      else void this.stopRunById(lead.runId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.listeners.clear();
  }

  private schedule(runId: string): void {
    const previous = this.scheduling.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.startReadyTasks(runId)).finally(() => {
      if (this.scheduling.get(runId) === next) this.scheduling.delete(runId);
    });
    this.scheduling.set(runId, next);
  }

  private async startReadyTasks(runId: string): Promise<void> {
    if (this.disposed) return;
    let run = this.deps.store.getRun(runId);
    if (!run || isTerminalCollaborationRun(run.state)) return;
    this.armExpiry(run);
    const policy = this.deps.store.getPolicy(run.projectId);
    if (!policy || !policy.enabled || policy.revision !== run.policyRevision) return;
    if (run.expiresAt <= this.now()) {
      await this.stopRunById(runId);
      return;
    }
    while (run) {
      const activeCount = run.tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state)).length;
      if (activeCount >= policy.limits.maxConcurrent) return;
      const blocked = run.tasks.find((task) => task.state === 'queued' && task.dependsOn.some((dependency) => {
        const predecessor = run!.tasks.find((candidate) => candidate.taskId === dependency);
        return predecessor && (predecessor.state === 'failed' || predecessor.state === 'canceled' || predecessor.state === 'stale');
      }));
      if (blocked) {
        const now = this.now();
        const canceled = await this.deps.store.updateRun(runId, (current) => {
          const target = current.tasks.find((task) => task.taskId === blocked.taskId);
          if (!target || target.state !== 'queued') return null;
          const nextTask = taskWithPatch(target, { state: 'canceled', error: 'A dependency did not succeed.' }, now);
          return {
            run: runWithTasks(current, current.tasks.map((task) => task.taskId === target.taskId ? nextTask : task), now, 'needs-attention'),
            events: [this.event(current, nextTask, 'worker-canceled', `${target.title} was canceled because a dependency did not succeed.`)],
          };
        });
        if (!canceled.ok) return;
        run = canceled.value;
        this.publish();
        void this.flushLead(runId);
        continue;
      }
      const ready = run.tasks.find((task) => task.state === 'queued' && task.dependsOn.every((dependency) => {
        const predecessor = run!.tasks.find((candidate) => candidate.taskId === dependency);
        return predecessor?.result?.outcome === 'succeeded'
          && (predecessor.state === 'completed' || predecessor.state === 'awaiting-verification' || predecessor.state === 'awaiting-merge');
      }));
      if (!ready) return;
      const profile = this.deps.profiles().find((candidate) => candidate.profileId === ready.profileId);
      if (!profile?.available) {
        await this.failUnreportedWorker(run, ready, 'The selected worker profile is no longer available.');
        run = this.deps.store.getRun(runId);
        continue;
      }
      const now = this.now();
      const workerId = this.newId();
      const starting = await this.deps.store.updateRun(runId, (current) => {
        const target = current.tasks.find((task) => task.taskId === ready.taskId);
        if (!target || target.state !== 'queued') return null;
        const nextTask = taskWithPatch(target, {
          state: 'starting',
          worker: {
            workerId,
            taskId: target.taskId,
            profileId: profile.profileId,
            providerId: profile.providerId,
            startedAt: now,
          },
        }, now);
        return { run: runWithTasks(current, current.tasks.map((task) => task.taskId === target.taskId ? nextTask : task), now) };
      });
      if (!starting.ok) return;
      run = starting.value;
      this.publish();
      const startingTask = run.tasks.find((task) => task.taskId === ready.taskId)!;
      const dependencyResults = startingTask.dependsOn.map((dependency) => (
        run!.tasks.find((task) => task.taskId === dependency)?.result
      )).filter((result): result is CollaborationTaskResult => result !== undefined);
      try {
        const launch = await this.deps.launchWorker(
          run,
          startingTask,
          profile,
          composeWorkerBrief(run, startingTask, dependencyResults),
        );
        const launchedAt = this.now();
        const launched = await this.deps.store.updateRun(runId, (current) => {
          const target = current.tasks.find((task) => task.taskId === startingTask.taskId);
          if (!target || target.state !== 'starting' || target.worker?.workerId !== workerId) return null;
          const nextTask = taskWithPatch(target, {
            state: target.mode === 'verify' ? 'verifying' : 'working',
            worker: {
              ...target.worker,
              profileId: launch.profileId,
              providerId: launch.providerId,
              sessionId: launch.sessionId,
              activityId: launch.activityId,
              ...(launch.worktreeId ? { worktreeId: launch.worktreeId } : {}),
              ...(launch.worktreePath ? { worktreePath: launch.worktreePath } : {}),
              ...(launch.branch ? { branch: launch.branch } : {}),
            },
          }, launchedAt);
          return {
            run: runWithTasks(current, current.tasks.map((task) => task.taskId === target.taskId ? nextTask : task), launchedAt),
            events: [this.event(current, nextTask, 'worker-started', `${nextTask.title} started with ${profile.name}.`)],
          };
        });
        if (!launched.ok) {
          this.deps.stopSession(launch.sessionId);
          return;
        }
        run = launched.value;
        this.publish();
        try {
          await launch.start?.();
        } catch (error) {
          await this.failUnreportedWorker(
            run,
            run.tasks.find((task) => task.taskId === startingTask.taskId)!,
            error instanceof Error ? error.message : 'Worker task delivery failed.',
          );
          run = this.deps.store.getRun(runId);
        }
      } catch (error) {
        await this.failUnreportedWorker(
          run,
          startingTask,
          error instanceof Error ? error.message.slice(0, 500) : 'Worker launch failed.',
        );
        run = this.deps.store.getRun(runId);
      }
    }
  }

  private async transitionWorkerState(
    run: CollaborationRun,
    task: CollaborationTask,
    state: CollaborationTask['state'],
    eventKind?: CollaborationEventKind,
    summary?: string,
  ): Promise<void> {
    const now = this.now();
    const result = await this.deps.store.updateRun(run.runId, (current) => {
      const target = current.tasks.find((candidate) => candidate.taskId === task.taskId);
      if (!target || target.revision !== task.revision || isTerminalCollaborationTask(target.state)) return null;
      const nextTask = taskWithPatch(target, { state }, now);
      return {
        run: runWithTasks(current, current.tasks.map((candidate) => candidate.taskId === target.taskId ? nextTask : candidate), now),
        ...(eventKind && summary ? { events: [this.event(current, nextTask, eventKind, summary)] } : {}),
      };
    });
    if (!result.ok) return;
    this.publish();
    if (eventKind) void this.flushLead(run.runId);
  }

  private async failUnreportedWorker(
    run: CollaborationRun,
    task: CollaborationTask,
    error: string,
  ): Promise<void> {
    const terminalTail = task.worker?.activityId ? await this.deps.readActivity(task.worker.activityId) : null;
    const summary = boundedSummary(terminalTail?.trim() || error);
    const now = this.now();
    const result = await this.deps.store.updateRun(run.runId, (current) => {
      const target = current.tasks.find((candidate) => candidate.taskId === task.taskId);
      if (!target || target.revision !== task.revision
        || isTerminalCollaborationTask(target.state)
        || target.state === 'awaiting-verification'
        || target.state === 'awaiting-merge') return null;
      const nextTask = taskWithPatch(target, {
        state: 'failed',
        error: error.slice(0, 500),
        result: { outcome: 'failed', summary, reportedAt: now },
        ...(target.worker ? { worker: { ...target.worker, finishedAt: now } } : {}),
      }, now);
      return {
        run: runWithTasks(current, current.tasks.map((candidate) => candidate.taskId === target.taskId ? nextTask : candidate), now, 'needs-attention'),
        events: [this.event(current, nextTask, 'worker-failed', summary)],
      };
    });
    if (!result.ok) return;
    this.publish();
    this.schedule(run.runId);
    void this.flushLead(run.runId);
  }

  private async flushLead(runId: string): Promise<void> {
    const run = this.deps.store.getRun(runId);
    if (!run) return;
    const lead = this.deps.activity(run.leadActivityId);
    if (!lead?.live || !lead.interactiveReady || (lead.state !== 'done' && lead.state !== 'idle')) return;
    const pending = this.deps.store.listEvents()
      .filter((event) => event.runId === runId && event.deliveredAt === undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    const event = pending[0];
    if (!event) return;
    const task = run.tasks.find((candidate) => candidate.taskId === event.taskId);
    const message = [
      `[EZTerminal worker event: ${event.kind}]`,
      `Task: ${task?.title ?? event.taskId}`,
      event.summary,
      'Inspect the worker record if you need transcript or diff details. Continue managing the user request as Lead.',
    ].join('\n');
    const sent = await this.deps.promptActivity(run.leadActivityId, message);
    if (!sent.ok) return;
    await this.deps.store.markEventDelivered(event.eventId, this.now());
    this.publish();
  }

  private taskForWorkerSession(sessionId: string): { readonly run: CollaborationRun; readonly task: CollaborationTask } | null {
    for (const run of this.deps.store.listRuns()) {
      const task = run.tasks.find((candidate) => candidate.worker?.sessionId === sessionId);
      if (task) return { run, task };
    }
    return null;
  }

  private taskForActivity(activityId: string): { readonly run: CollaborationRun; readonly task: CollaborationTask } | null {
    for (const run of this.deps.store.listRuns()) {
      const task = run.tasks.find((candidate) => candidate.worker?.activityId === activityId);
      if (task) return { run, task };
    }
    return null;
  }

  private async stopRunById(runId: string): Promise<void> {
    const run = this.deps.store.getRun(runId);
    if (!run || isTerminalCollaborationRun(run.state)) {
      this.clearExpiry(runId);
      return;
    }
    const now = this.now();
    const result = await this.deps.store.updateRun(runId, (current) => ({
      run: runWithTasks(current, current.tasks.map((task) => isTerminalCollaborationTask(task.state) ? task : taskWithPatch(task, {
        state: 'canceled',
        error: 'Lead run ended.',
        ...(task.worker ? { worker: { ...task.worker, finishedAt: now } } : {}),
      }, now)), now, 'stopped'),
    }));
    if (!result.ok) return;
    this.clearExpiry(runId);
    for (const task of result.value.tasks) if (task.worker?.sessionId) this.deps.stopSession(task.worker.sessionId);
    this.publish();
  }

  private event(
    run: CollaborationRun,
    task: CollaborationTask,
    kind: CollaborationEventKind,
    summary: string,
  ): CollaborationEvent {
    return {
      eventId: this.newId(),
      runId: run.runId,
      taskId: task.taskId,
      taskRevision: task.revision,
      kind,
      summary: boundedSummary(summary),
      createdAt: this.now(),
    };
  }

  private armExpiry(run: CollaborationRun): void {
    if (isTerminalCollaborationRun(run.state) || this.expiryTimers.has(run.runId)) return;
    const timer = setTimeout(() => {
      this.expiryTimers.delete(run.runId);
      void this.stopRunById(run.runId);
    }, Math.max(0, run.expiresAt - this.now()));
    timer.unref?.();
    this.expiryTimers.set(run.runId, timer);
  }

  private clearExpiry(runId: string): void {
    const timer = this.expiryTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(runId);
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Level-triggered consumers recover on the next committed snapshot.
      }
    }
  }

  private newId(): string {
    return (this.deps.newId ?? randomUUID)();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
