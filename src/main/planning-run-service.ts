import { createHash } from 'node:crypto';
import {
  createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonTurn,
} from '../shared/daemon-protocol';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL, PLANNING_LAUNCH_PRINCIPAL, type ExecutionArtifact, type ExecutionAttempt, type ExecutionRun, type PlanningExecutionCommand, type PlanningExecutionReceipt, type PreparedExecutionTask } from '../shared/planning-execution';
import { PlanningRunRequestSchema, type PlanningRunRequest, type PlanningRunResult } from '../shared/planning-run';
import { AsyncMutationGate } from './async-mutation-gate';
import type { DaemonStore } from './daemon-store';
import type { DaemonCommandRouter } from './daemon-command-router';
import type { PlanningService } from './planning-service';
import type { PlanningExecutionStore } from './planning-execution-store';
import type { AgentProviderRegistry } from './agent-provider-registry';
import type { WorktreeService, GitRunner } from './worktree-service';
import { preparePlanningExecution } from './planning-preparation';
import type { PlanningDraft } from '../shared/planning';
import type { PlanningEnvironmentService } from './planning-environment-service';
import { readPlanningFileReference } from './planning-file-reference';
import { workflowPrincipalIdentity, type WorkflowCommand, type WorkflowPrincipal, type WorkflowSubproject } from '../shared/workflow';
import { workflowDigest } from './workflow-service';
import { workflowPlanningInput } from './workflow-preparation';
import { workflowTaskInputs } from './workflow-runtime';
import { isRunReviewer } from './planning-review-identity';
import { decideStageBinding, type CommittedSubproject } from './workflow-stage-binding';

/** A failure whose outcome is not settled: the request stays pending and its retry replays it (see WorkflowService). */
type WorkflowExecution = { ok: true } | { ok: false; error: string; message: string; transient?: true };
/** A flow command that maps to one ledger command (`run.launch` is two of them). */
type WorkflowStepCommand = Exclude<Extract<WorkflowCommand, { type: `run.${string}` }>, { type: 'run.launch' }>;

/** The ledger id of a flow command: `workflow:<id>`, or a hash when that would exceed the ledger's 160 characters. */
export function workflowLedgerId(commandId: string): string {
  const plain = `workflow:${commandId}`;
  return plain.length <= 160 ? plain : `workflow:${createHash('sha256').update(commandId).digest('hex')}`;
}

/** The ids `run.launch` gives its prepare, start and clean-up (81 characters in the ledger, whatever its command id). */
export function workflowLaunchId(commandId: string): string {
  return `workflow-launch:${createHash('sha256').update(commandId).digest('hex').slice(0, 48)}`;
}

function meaning(value: unknown): string {
  return JSON.stringify(value, (key, entry) => key === 'revision' || key === 'status' ? undefined : entry);
}
function changedTaskIds(baseline: PlanningDraft, current: PlanningDraft): ReadonlySet<string> {
  const impacted = new Set<string>();
  for (const link of [...baseline.links, ...current.links]) {
    if (meaning(baseline.links.find((entry) => entry.id === link.id)) !== meaning(current.links.find((entry) => entry.id === link.id))) {
      impacted.add(link.fromId); impacted.add(link.toId);
    }
  }
  for (const key of ['items', 'scenes', 'components', 'assets', 'tasks'] as const) {
    for (const entry of baseline[key]) if (meaning(entry) !== meaning(current[key].find((candidate) => candidate.id === entry.id))) impacted.add(entry.id);
  }
  let size = -1;
  while (size !== impacted.size) {
    size = impacted.size;
    for (const link of baseline.links) if (impacted.has(link.toId)) impacted.add(link.fromId);
    for (const scene of baseline.scenes) if (scene.featureIds.some((id) => impacted.has(id))) impacted.add(scene.id);
    for (const task of baseline.tasks) if ([...task.featureIds, ...task.screenIds, ...task.dependencyIds,
      ...task.inputRefs.filter((ref) => !ref.baselineId).map((ref) => ref.id),
      ...task.interfaceRefs.filter((ref) => !ref.baselineId).map((ref) => ref.id)].some((id) => impacted.has(id))) impacted.add(task.id);
  }
  return impacted;
}

function hash(value: unknown): string {
  const canonical = (entry: unknown): string => Array.isArray(entry) ? `[${entry.map(canonical).join(',')}]`
    : entry && typeof entry === 'object' ? `{${Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
      : JSON.stringify(entry);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/**
 * What the host resolves for a run frozen with 자동 승인: each approval stage it reached, and
 * integration once it completed with no pending gate. Nothing for a person's run, or one the
 * person paused or cancelled.
 */
/** The ledger command id of the host's automatic decision on one approval stage (its receipt records a refusal). */
export function autoApprovalCommandId(runId: string, activationId: string): string {
  return `auto-approve-${hash([runId, activationId]).slice(0, 32)}`;
}
/** How many times a runtime command is retried on a revision conflict, each under `<id>-<n>`. */
export const RUNTIME_COMMAND_RETRIES = 5;
/**
 * The host's automatic decision on an approval stage did not and will not happen: its first non-conflict answer was a
 * refusal, or every retry met a conflict (the runtime then gives up on it). Read from the recorded receipts.
 */
export function autoApprovalRefused(getReceipt: (projectId: string, commandId: string) => PlanningExecutionReceipt | null, projectId: string, runId: string, activationId: string): boolean {
  const commandId = autoApprovalCommandId(runId, activationId);
  for (let retry = 0; retry < RUNTIME_COMMAND_RETRIES; retry += 1) {
    const receipt = getReceipt(projectId, `${commandId}-${retry}`);
    if (!receipt || receipt.ok) return false;
    if (receipt.error !== 'revision-conflict') return true;
  }
  return true;
}
export function autoApprovalCommands(run: ExecutionRun): Array<{ readonly commandId: string; readonly type: 'workflow.approve' | 'workflow.integrate'; readonly payload: Record<string, unknown> }> {
  if (run.preparation.approvalPolicy !== 'auto' || run.cancelRequested || run.dispatchPaused) return [];
  const approvals = (run.workflowRuntime?.activations ?? []).filter((activation) => activation.state === 'awaiting-approval')
    .map((activation) => ({ commandId: autoApprovalCommandId(run.runId, activation.id), type: 'workflow.approve' as const,
      payload: { activationId: activation.id, decision: 'approve' } }));
  const integrate = run.preparation.workflow && run.state === 'completed' && !run.integrationAuthorized && !run.gates.some((gate) => gate.state === 'pending')
    ? [{ commandId: `auto-integrate-${hash([run.runId]).slice(0, 32)}`, type: 'workflow.integrate' as const, payload: {} }]
    : [];
  return [...approvals, ...integrate];
}

export function planningAttemptIdentity(runId: string, taskId: string, number: number) {
  const suffix = hash([runId, taskId, number]).slice(0, 32);
  return { attemptId: `attempt-${suffix}`, dispatchId: `dispatch-${suffix}`, sessionId: `planning-${suffix}`, workspaceId: `planning-workspace-${suffix}` };
}

export interface PlanningRunServiceOptions {
  readonly planning: Pick<PlanningService, 'read'> & Partial<Pick<PlanningService, 'captureWorkflowBaseline'>>;
  readonly ledger: PlanningExecutionStore;
  readonly daemon: DaemonCommandRouter;
  readonly store: DaemonStore;
  readonly providers: AgentProviderRegistry;
  readonly worktrees: Pick<WorktreeService, 'execute'>;
  readonly git: Pick<GitRunner, 'run'>;
  readonly wakeQueuedTurns: () => void;
  readonly captureResult: (run: ExecutionRun, task: PreparedExecutionTask, attempt: ExecutionAttempt) => Promise<readonly ExecutionArtifact[]>;
  readonly capturePartialResult?: (run: ExecutionRun, task: PreparedExecutionTask, attempt: ExecutionAttempt) => Promise<readonly ExecutionArtifact[]>;
  readonly prepareWorkspace?: (run: ExecutionRun, task: PreparedExecutionTask, workspaceRoot: string) => Promise<void>;
  readonly workflowResultContext?: (run: ExecutionRun, task: PreparedExecutionTask, maximumCharacters: number) => Promise<string>;
  readonly processReview: (run: ExecutionRun, task: PreparedExecutionTask, attempt: ExecutionAttempt) => Promise<void>;
  readonly processIntegration?: (run: ExecutionRun) => Promise<void>;
  readonly cancelReviews?: (run: ExecutionRun) => Promise<boolean>;
  readonly decideReview: (request: Extract<PlanningRunRequest, { type: 'review' }>, principal: { kind: 'desktop' | 'android'; id: string }) => Promise<PlanningExecutionReceipt>;
  readonly retryReview?: (request: Extract<PlanningRunRequest, { type: 'retry-review' }>, principal: { kind: 'desktop' | 'android'; id: string }) => Promise<PlanningExecutionReceipt>;
  readonly recordDeviceEvidence?: (request: Extract<PlanningRunRequest, { type: 'record-device-evidence' }>, principal: { kind: 'desktop' | 'android'; id: string }) => Promise<PlanningExecutionReceipt>;
  readonly reportError?: (error: unknown) => void;
  readonly ownsSubproject?: (projectId: string, subprojectId: string, writing: boolean) => Promise<boolean>;
  /** The last committed subproject, read without the workflow gate (this service holds its own gate while asking). */
  readonly committedSubproject?: (projectId: string, subprojectId: string) => Promise<CommittedSubproject>;
  readonly environments?: PlanningEnvironmentService;
}

/** PC-owned dispatch. Navigation/read never starts a provider; an explicit run start does. */
export class PlanningRunService {
  private readonly gate = new AsyncMutationGate();
  private stopped = true;
  private initializing = false;
  private requested = false;
  private pumping: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly refusedAutoApprovals = new Set<string>();

  constructor(private readonly options: PlanningRunServiceOptions) {}

  async start(): Promise<void> {
    this.initializing = true;
    try {
      await this.options.ledger.recoverInterrupted();
      this.stopped = false;
      for (const lease of this.options.environments?.list() ?? []) {
        const attempt = this.allRuns().flatMap((run) => run.attempts).find((entry) => entry.sessionId === lease.sessionId);
        if (attempt && !['running', 'delivery-uncertain'].includes(attempt.state)) await this.options.environments!.release(lease.sessionId);
        else if (!attempt) {
          const turns = this.options.daemon.getSnapshot().turns.filter((turn) => turn.sessionId === lease.sessionId);
          if (turns.every((turn) => turn.state === 'queued' || ['failed', 'interrupted', 'completed'].includes(turn.state))) await this.options.environments!.suspend(lease.sessionId);
        }
      }
      for (const project of this.options.daemon.getSnapshot().projects.filter((entry) => !entry.archivedAt)) {
        await this.planningChanged(project.id);
      }
      this.unsubscribe = this.options.daemon.onEvent(() => this.wake());
    } catch (error) {
      this.stopped = true;
      throw error;
    } finally {
      this.initializing = false;
    }
    this.wake();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.pumping;
    await this.gate.runExclusive(() => undefined);
  }

  requestTick(): void { this.wake(); }

  read(projectId: string): PlanningRunResult {
    const project = this.options.daemon.getSnapshot().projects.find((entry) => entry.id === projectId && !entry.archivedAt);
    return project ? { ok: true, snapshot: this.options.ledger.read(projectId) }
      : { ok: false, error: 'not-found', message: 'The project is unavailable.' };
  }

  executeWorkflow(command: WorkflowCommand, subproject: WorkflowSubproject, principal: WorkflowPrincipal): Promise<WorkflowExecution> {
    return this.gate.runExclusive(async () => {
      if (this.stopped) return { ok: false, error: 'user-required', message: 'An available host and explicit user execution command are required.', transient: true };
      if (principal.kind === 'ai' && !['run.prepare', 'run.launch', 'run.start', 'run.pause', 'run.resume', 'run.cancel'].includes(command.type)) {
        return { ok: false, error: 'user-required', message: 'Approvals and integration require an explicit user command.' };
      }
      if (!command.type.startsWith('run.')) return { ok: false, error: 'invalid-command', message: 'This is not an execution command.' };
      if (command.type === 'run.launch') return this.launchWorkflow(command, subproject, principal);
      return this.workflowStep(command as WorkflowStepCommand, subproject, principal);
    });
  }

  /**
   * 다시 실행: prepare and start one run under one hold of the execution gate, with ids derived from the
   * request so a retry replays exactly what it did. When the start is refused for good, the run it
   * prepared is cancelled by the launch principal (the ledger allows it nothing else).
   */
  private async launchWorkflow(command: Extract<WorkflowCommand, { type: 'run.launch' }>, subproject: WorkflowSubproject, principal: WorkflowPrincipal): Promise<WorkflowExecution> {
    const { reviewer, runId } = command.payload;
    if (!reviewer) return { ok: false, error: 'missing-reviewer', message: 'Choose the review AI for this flow before running it.' };
    const launchId = workflowLaunchId(command.commandId);
    const envelope = { hostId: command.hostId, projectId: command.projectId, expectedRevision: command.expectedRevision, ...(command.subprojectId ? { subprojectId: command.subprojectId } : {}) };
    const prepared = await this.workflowStep({ ...envelope, commandId: `${launchId}:prepare`, type: 'run.prepare', payload: { runId, reviewer } }, subproject, principal);
    if (!prepared.ok) return prepared;
    const started = await this.workflowStep({ ...envelope, commandId: `${launchId}:start`, type: 'run.start', payload: { runId } }, subproject, principal);
    if (!started.ok && !started.transient) {
      const run = this.options.ledger.read(command.projectId).runs.find(entry => entry.runId === runId);
      if (run && !run.startedAt && run.state !== 'cancelled') {
        // The refused start is recorded, so a retry never starts this run: it only finishes the clean-up.
        // The launch settles once its prepared run is cancelled; until then the request stays open.
        const cancelled = await this.cancelLaunchRun(run, launchId);
        if (cancelled === 'conflicting') return { ok: false, error: 'execution-unavailable', message: `${started.message} The run it prepared could not be cancelled yet; retry the same request.`, transient: true };
        if (cancelled !== 'cancelled') this.options.reportError?.(new Error(`The run prepared by launch ${launchId} was not cancelled: ${cancelled.refused}`));
      }
    }
    return started;
  }

  /**
   * Cancels the run a launch prepared and could not start. Each try has its own id after the last one
   * recorded as conflicting, so recorded conflicts never use the attempts up.
   */
  private async cancelLaunchRun(run: ExecutionRun, launchId: string): Promise<'cancelled' | 'conflicting' | { readonly refused: string }> {
    const settled = (receipt: PlanningExecutionReceipt) => receipt.ok ? 'cancelled' as const : { refused: receipt.message };
    for (let index = 0, tries = 0; index < 10_000 && tries < 5; index += 1) {
      const commandId = `workflow:${launchId}:cancel-${index}`;
      const existing = this.options.ledger.getReceipt(run.projectId, commandId);
      if (existing) { if (existing.ok || existing.error !== 'revision-conflict') return settled(existing); continue; }
      tries += 1;
      const receipt = await this.options.ledger.execute({ commandId, projectId: run.projectId, expectedRevision: this.options.ledger.read(run.projectId).revision,
        principal: { kind: 'runtime', id: PLANNING_LAUNCH_PRINCIPAL }, type: 'run.cancel', payload: { runId: run.runId } });
      if (receipt.ok || receipt.error !== 'revision-conflict') return settled(receipt);
    }
    return 'conflicting';
  }

  /** One flow execution command against the ledger (called under the execution gate). */
  private async workflowStep(request: WorkflowStepCommand, subproject: WorkflowSubproject, principal: WorkflowPrincipal): Promise<WorkflowExecution> {
    const command = request;
    {
      const ledgerId = workflowLedgerId(request.commandId);
      // Read the original durable receipt before any preparation side effect on a retry.
      const previous = this.options.ledger.getReceipt(command.projectId, ledgerId);
      // An agent is recorded by its conversation.
      const ledgerPrincipal = principal.kind === 'ai'
        ? { kind: 'agent' as const, id: principal.sessionId ?? principal.id }
        : { kind: principal.kind, id: principal.id };
      const common = { commandId: ledgerId, projectId: command.projectId,
        expectedRevision: this.options.ledger.read(command.projectId).revision,
        principal: ledgerPrincipal };
      try {
        let receipt: PlanningExecutionReceipt;
        if (previous) {
          if (request.type === 'run.prepare') {
            // A refused prepare has no run: its retry answers the original refusal below.
            const original = this.options.ledger.read(command.projectId).runs.find(run => run.runId === request.payload.runId);
            if (previous.ok && (!original || original.preparation.requestFingerprint !== workflowDigest({ command, principal: workflowPrincipalIdentity(principal) }))) return { ok: false, error: 'command-conflict', message: 'This workflow command ID belongs to different execution inputs.' };
          } else {
            const types = { 'run.start': 'run.start', 'run.pause': 'run.pause', 'run.resume': 'run.continue', 'run.approve': 'workflow.approve', 'run.cancel': 'run.cancel', 'run.integrate': 'workflow.integrate' } as const;
            const replay = await this.options.ledger.execute({ ...common, expectedRevision: previous.ok ? previous.revision - 1 : previous.revision, type: types[request.type], payload: request.payload });
            if (!replay.ok) return { ok: false, error: replay.error, message: replay.message };
          }
          if (previous.ok) { await this.workflowEffects(command.projectId, request); this.wake(); }
          return previous.ok ? { ok: true } : { ok: false, error: previous.error, message: previous.message };
        }
        if (request.type === 'run.prepare') {
          const existing = this.options.ledger.read(command.projectId).runs.find(run => run.runId === request.payload.runId);
          if (existing) return { ok: false, error: 'command-conflict', message: 'This run ID is already used. Reconcile the original command.' };
          if (!this.options.planning.captureWorkflowBaseline) return { ok: false, error: 'unavailable', message: 'Workflow baseline storage is unavailable.' };
          const baselineId = `workflow-${workflowDigest([command.projectId, subproject.id, request.payload.runId]).slice(0, 32)}`;
          const generated = workflowPlanningInput(subproject, baselineId, request.payload.reviewer);
          // A registered provider that is down, or planning storage that cannot be read or written now, leaves
          // the outcome open (the same request is retried); a request whose own inputs are invalid settles.
          const providers = this.options.daemon.getSnapshot().providers;
          const down = [...generated.assignments, generated.reviewer].map(entry => providers.find(provider => provider.id === entry.providerId))
            .find(provider => provider?.enabled && (provider.health === 'unavailable' || provider.health === 'error'));
          if (down) return { ok: false, error: 'preparation-invalid', message: `Provider ${down.id} is not ready. Reconnect it, then retry the same request.`, transient: true };
          const planning = await this.options.planning.captureWorkflowBaseline(command.projectId, subproject.id, baselineId, subproject.title, generated.draft);
          if (!planning.ok) return planning.error === 'unavailable' ? { ...planning, transient: true } : planning;
          const root = this.projectRoot(command.projectId);
          const baseCommit = await this.options.git.run(root, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim()).catch(() => undefined);
          // A provider that cannot list its models, or a file that cannot be read for a reason other than
          // being absent, leaves the outcome open: the same request is retried, not settled as failed.
          let unsettled = false;
          const prepared = await preparePlanningExecution({ runId: request.payload.runId, baselineId, teamMode: 'division', progressPolicy: 'autonomous', assignments: generated.assignments, reviewer: generated.reviewer }, {
            snapshot: planning.snapshot, daemon: this.options.daemon.getSnapshot(), baseCommit,
            readFileReference: async reference => {
              try { return await readPlanningFileReference(root, reference); }
              catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unsettled = true; throw error; }
            },
            listModels: async providerId => {
              const result = await this.options.providers.listModels(this.options.daemon.getSnapshot(), providerId).catch((error: unknown) => { unsettled = true; throw error; });
              if (!result.ok) { unsettled = true; throw new Error(result.message); }
              return result.value;
            },
          });
          if (!prepared.ok) return unsettled ? { ...prepared, transient: true } : prepared;
          receipt = await this.options.ledger.execute({ ...common, type: 'run.prepare', payload: { runId: request.payload.runId, preparation: {
            ...prepared.preparation, subprojectId: subproject.id, requestFingerprint: workflowDigest({ command, principal: workflowPrincipalIdentity(principal) }),
            // Only an opted-in run carries the policy (absent reads as the person's), so older clients keep parsing runs.
            ...(subproject.autoApprove ? { approvalPolicy: 'auto' as const } : {}),
            ...(principal.kind === 'ai' && principal.sessionId ? { startedBy: { sessionId: principal.sessionId } } : {}),
            workflow: { subprojectId: subproject.id, revision: subproject.revision, fingerprint: workflowDigest(subproject.graph), graph: structuredClone(subproject.graph) },
          } } });
        } else {
          const types = { 'run.start': 'run.start', 'run.pause': 'run.pause', 'run.resume': 'run.continue', 'run.approve': 'workflow.approve', 'run.cancel': 'run.cancel', 'run.integrate': 'workflow.integrate' } as const;
          receipt = await this.options.ledger.execute({ ...common, type: types[request.type], payload: request.payload });
        }
        if (!receipt.ok) return { ok: false, error: receipt.error, message: receipt.message };
        await this.workflowEffects(command.projectId, request);
        this.wake(); this.options.wakeQueuedTurns(); return { ok: true };
      } catch (error) { return { ok: false, error: 'execution-unavailable', message: error instanceof Error ? error.message : 'Execution is unconfirmed. Reconcile the original command.', transient: true }; }
    }
  }

  private async workflowEffects(projectId: string, command: WorkflowCommand): Promise<void> {
    if (command.type !== 'run.cancel') return;
    const run = this.options.ledger.read(projectId).runs.find(entry => entry.runId === command.payload.runId);
    if (run) await this.options.cancelReviews?.(run);
    for (const task of run?.tasks ?? []) if (task.cancelRequested) await this.cancelCurrent(projectId, run!.runId, task.taskId);
  }

  execute(value: unknown, principal: { kind: 'desktop' | 'android'; id: string }): Promise<PlanningRunResult> {
    return this.gate.runExclusive(async () => {
      const parsed = PlanningRunRequestSchema.safeParse(value);
      if (!parsed.success) return { ok: false, error: 'invalid-command', message: 'Invalid execution request.' };
      if (this.stopped) return { ok: false, error: 'unavailable', message: 'Execution authority is unavailable.' };
      const request = parsed.data;
      if (request.subprojectId && !await this.options.ownsSubproject?.(request.projectId, request.subprojectId, true)) return { ok: false, error: 'forbidden', message: 'The subproject is unavailable.' };
      const snapshot = this.options.ledger.read(request.projectId);
      if (request.type !== 'prepare') {
        const owner = snapshot.runs.find(run => run.runId === request.payload.runId);
        if (owner && owner.preparation.subprojectId !== request.subprojectId) return { ok: false, error: 'forbidden', message: 'Explicitly address the subproject that owns this run.' };
      }
      const common = { commandId: request.commandId, projectId: request.projectId, expectedRevision: request.expectedRevision, principal };
      try {
        let receipt: PlanningExecutionReceipt;
        if (request.type === 'prepare') {
          const existing = snapshot.runs.find((run) => run.runId === request.payload.runId);
          const requestFingerprint = hash({ ...request, principal });
          if (existing) {
            if (existing.preparation.requestFingerprint !== requestFingerprint) throw new Error('The preparation request differs from the frozen run.');
            receipt = await this.options.ledger.execute({ ...common, type: 'run.prepare', payload: { runId: existing.runId, preparation: existing.preparation } });
          } else {
            const planning = await this.options.planning.read(request.projectId, request.subprojectId);
            if (!planning.ok) return planning;
            const root = this.projectRoot(request.projectId);
            const baseCommit = await this.options.git.run(root, ['rev-parse', '--verify', 'HEAD']).then((value) => value.trim()).catch(() => undefined);
            const result = await preparePlanningExecution(request.payload, {
              snapshot: planning.snapshot, daemon: this.options.daemon.getSnapshot(), baseCommit, previousRuns: snapshot.runs,
              readFileReference: reference => readPlanningFileReference(root, reference),
              listModels: async (providerId) => {
                const models = await this.options.providers.listModels(this.options.daemon.getSnapshot(), providerId);
                if (!models.ok) throw new Error(models.message);
                return models.value;
              },
            });
            if (!result.ok) return result;
            receipt = await this.options.ledger.execute({ ...common, type: 'run.prepare',
              payload: { runId: request.payload.runId, preparation: { ...result.preparation, requestFingerprint, ...(request.subprojectId ? { subprojectId: request.subprojectId } : {}) } } });
          }
        } else if (request.type === 'review') {
          receipt = await this.options.decideReview(request, principal);
        } else if (request.type === 'retry-review') {
          if (!this.options.retryReview) throw new Error('Independent review recovery is unavailable.');
          receipt = await this.options.retryReview(request, principal);
        } else if (request.type === 'record-device-evidence') {
          if (!this.options.recordDeviceEvidence) throw new Error('Device evidence recording is unavailable.');
          receipt = await this.options.recordDeviceEvidence(request, principal);
        } else {
          const types = { start: 'run.start', pause: 'run.pause', continue: 'run.continue', retry: 'attempt.retry', 'extend-retry': 'attempt.extend', 'resume-task': 'attempt.resume', 'cancel-task': 'task.cancel', 'select-candidate': 'candidate.select', 'keep-original': 'gate.keep-original', 'resolve-change': 'gate.resolve' } as const;
          receipt = await this.options.ledger.execute({ ...common, type: types[request.type], payload: request.payload });
          if (receipt.ok && request.type === 'cancel-task') await this.cancelCurrent(request.projectId, request.payload.runId, request.payload.taskId);
        }
        if (!receipt.ok) return { ok: false, error: receipt.error, message: receipt.message };
        this.wake();
        this.options.wakeQueuedTurns();
        return { ok: true, commandId: request.commandId, snapshot: this.options.ledger.read(request.projectId) };
      } catch (error) {
        return { ok: false, error: 'execution-unavailable', message: error instanceof Error ? error.message : 'Execution request failed. Reconcile before retrying.' };
      }
    });
  }

  preparedSessionSettings(sessionId: string): { reasoningEffort?: string; environment?: Readonly<Record<string, string>>; managedExecution: true } | undefined {
    const binding = this.bindingForSession(sessionId);
    return binding ? { reasoningEffort: binding.task.profile.reasoningEffort, managedExecution: true,
      ...(this.options.environments?.read(sessionId) ? { environment: this.options.environments.read(sessionId)!.environment } : {}) } : undefined;
  }

  /** Called after a durable planning mutation; profile edits do not rewrite active attempts. */
  planningChanged(projectId: string): Promise<void> {
    return this.gate.runExclusive(async () => {
      if (this.stopped) return;
      for (const run of this.options.ledger.read(projectId).runs) {
        if (!run.startedAt || run.state === 'completed') continue;
        // Workflow edits target the next immutable graph snapshot, never pause or rewrite this run.
        if (run.preparation.workflow) continue;
        const planning = await this.options.planning.read(projectId, run.preparation.subprojectId);
        if (!planning.ok) throw new Error(planning.message);
        const baseline = planning.snapshot.baselines.find((entry) => entry.id === run.preparation.baseline.baselineId);
        if (!baseline) throw new Error('The active execution baseline is unavailable.');
        if (baseline.purpose === 'quick-task') continue;
        const retainedRevision = Math.max(0, ...run.gates.filter((gate) => gate.resolution === 'keep-original').map((gate) => gate.sourcePlanningRevision ?? 0));
        const comparison = retainedRevision > 0
          ? planning.snapshot.history.find((entry) => entry.revision > retainedRevision)?.before ?? planning.snapshot.draft
          : baseline.draft;
        const impacted = changedTaskIds(comparison, planning.snapshot.draft);
        const taskIds = run.preparation.tasks.filter((task) => impacted.has(task.sourceTaskId ?? task.taskId)).map((task) => task.taskId);
        const gateId = `change-${hash([run.runId, planning.snapshot.revision]).slice(0, 32)}`;
        if (!taskIds.length || run.gates.some((gate) => gate.gateId === gateId)) continue;
        const receipt = await this.runtimeCommand(run, gateId, 'run.pause-impact', {
          gateId, taskIds, sourcePlanningRevision: planning.snapshot.revision,
          reason: `Planning revision ${planning.snapshot.revision} changed inputs used by this execution. Review the affected tasks before resuming.`,
        });
        if (!receipt.ok) throw new Error(receipt.message);
        const impactedIds = this.options.ledger.read(projectId).runs.find((entry) => entry.runId === run.runId)!
          .gates.find((entry) => entry.gateId === gateId)!.taskIds;
        for (const taskId of impactedIds) await this.cancelCurrent(projectId, run.runId, taskId);
      }
      this.wake();
    });
  }

  canDispatchTurn(turn: DaemonTurn): boolean {
    if (/^planning-review-[a-f0-9]{32}(?:-g\d+)?$/u.test(turn.sessionId)) return !this.stopped && !this.initializing && !this.allRuns().some(run => run.cancelRequested && isRunReviewer(run, turn.sessionId));
    if (!/^planning-[a-f0-9]{32}$/u.test(turn.sessionId)) return true;
    const binding = this.bindingForSession(turn.sessionId);
    return Boolean(!this.stopped && !this.initializing && binding && !binding.run.dispatchPaused
      && (!this.options.environments || this.options.environments.canActivate(turn.sessionId))
      && binding.run.tasks.find((task) => task.taskId === binding.task.taskId)?.state === 'ready');
  }

  async beforeProviderDispatch(turn: DaemonTurn): Promise<boolean> {
    if (/^planning-review-[a-f0-9]{32}(?:-g\d+)?$/u.test(turn.sessionId)) return this.canDispatchTurn(turn);
    if (!/^planning-[a-f0-9]{32}$/u.test(turn.sessionId)) return true;
    if (!this.canDispatchTurn(turn)) return false;
    const binding = this.bindingForSession(turn.sessionId)!;
    await this.options.environments?.activate(turn.sessionId);
    const receipt = await this.runtimeCommand(binding.run, `bind-${turn.id}`, 'attempt.start', {
      taskId: binding.task.taskId, attemptId: binding.identity.attemptId, dispatchId: binding.identity.dispatchId,
      sessionId: binding.identity.sessionId, turnId: turn.id,
    });
    if (!receipt.ok) {
      await this.options.environments?.suspend(turn.sessionId);
      if (receipt.error === 'invalid-transition') return false;
      throw new Error(receipt.message);
    }
    return true;
  }

  private projectRoot(projectId: string): string {
    const snapshot = this.options.daemon.getSnapshot();
    const project = snapshot.projects.find((entry) => entry.id === projectId && !entry.archivedAt);
    const root = project?.rootPath ?? snapshot.workspaces.find((entry) => project && entry.projectId === projectId && !entry.archivedAt && entry.kind === 'local')?.rootPath;
    if (!root) throw new Error('The project has no active local root.');
    return root;
  }

  private allRuns(): readonly ExecutionRun[] {
    return this.options.daemon.getSnapshot().projects.filter((project) => !project.archivedAt)
      .flatMap((project) => this.options.ledger.read(project.id).runs);
  }

  private bindingForSession(sessionId: string) {
    if (!/^planning-[a-f0-9]{32}$/u.test(sessionId)) return undefined;
    for (const run of this.allRuns()) for (const task of run.preparation.tasks) {
      const existing = run.attempts.find((attempt) => attempt.sessionId === sessionId);
      const number = existing?.number ?? run.attempts.filter((attempt) => attempt.taskId === task.taskId).length + 1;
      const identity = planningAttemptIdentity(run.runId, task.taskId, number);
      if (identity.sessionId === sessionId) return { run, task, identity };
    }
    return undefined;
  }

  private wake(): void {
    if (this.stopped || this.initializing) return;
    this.requested = true;
    if (this.pumping) return;
    this.pumping = Promise.resolve().then(async () => {
      while (this.requested && !this.stopped) {
        this.requested = false;
        await this.gate.runExclusive(() => this.pump());
      }
    }).catch((error) => this.options.reportError?.(error)).finally(() => {
      this.pumping = undefined;
      if (this.requested && !this.stopped) this.wake();
    });
  }

  private async pump(): Promise<void> {
    for (const run of this.allRuns()) {
      if (this.stopped || !run.startedAt) continue;
      // 자동 승인 was frozen into this run: the host answers its approvals and allows integration.
      let advanced = false;
      for (const command of autoApprovalCommands(run)) {
        const receipt = await this.runtimeCommand(run, command.commandId, command.type, command.payload, PLANNING_AUTO_APPROVAL_PRINCIPAL);
        if (receipt.ok) advanced = true;
        else if (!this.refusedAutoApprovals.has(command.commandId)) {
          // A refused automatic decision is left to the person: reported once, never retried in a loop.
          this.refusedAutoApprovals.add(command.commandId);
          this.options.reportError?.(new Error(`Auto-approval ${command.type} for run ${run.runId} was refused: ${receipt.message}`));
        }
      }
      if (advanced) { this.wake(); continue; }
      // A workflow completion/approval is not permission to integrate the worktree.
      if (!run.preparation.workflow || run.integrationAuthorized) await this.options.processIntegration?.(run);
      if (run.state === 'completed' || run.state === 'cancelled') continue;
      await this.reconcile(run);
      const current = this.options.ledger.read(run.projectId).runs.find((entry) => entry.runId === run.runId)!;
      if (current.cancelRequested) {
        const pendingReview = await this.options.cancelReviews?.(current);
        if (!pendingReview && current.state !== 'cancelled' && !current.attempts.some(attempt => ['running', 'delivery-uncertain'].includes(attempt.state))) await this.runtimeCommand(current, `cancel-reconcile-${current.revision}`, 'run.cancel-reconcile', {});
        continue;
      }
      for (const state of current.tasks) {
        const task = current.preparation.tasks.find((entry) => entry.taskId === state.taskId)!;
        const attempt = current.attempts.find((entry) => entry.attemptId === state.currentAttemptId);
        if (state.state === 'awaiting-review' && attempt) await this.options.processReview(current, task, attempt);
        if (state.state === 'failed' && !current.preparation.workflow && current.preparation.progressPolicy !== 'manual' && state.retriesUsed < task.retryLimit + (state.extraRetriesGranted ?? 0)
          && (current.evidence.some((entry) => entry.attemptId === state.currentAttemptId && entry.status === 'failed')
            || current.reviews.some((entry) => entry.attemptId === state.currentAttemptId && entry.decision === 'reject'))) {
          const receipt = await this.runtimeCommand(current, `repair-${state.currentAttemptId}`, 'attempt.retry', { taskId: task.taskId });
          if (receipt.ok) this.requested = true;
        }
      }
      if (current.dispatchPaused) continue;
      const active = current.tasks.filter((task) => task.state === 'running').length;
      const limit = current.preparation.teamMode === 'single' ? 1 : 4;
      let admitted = active;
      let target = current;
      for (const state of current.tasks) {
        if (this.stopped || state.state !== 'ready' || admitted >= limit) continue;
        // Admission depends only on the execution environment, which a binding never changes.
        const admittedTask = target.preparation.tasks.find((entry) => entry.taskId === state.taskId)!;
        const activeTasks = this.allRuns().flatMap((entry) => entry.tasks.filter((value) => value.state === 'running')
          .map((value) => entry.preparation.tasks.find((definition) => definition.taskId === value.taskId)!));
        if (activeTasks.length && (admittedTask.executionEnvironment?.mode !== 'namespaced'
          || activeTasks.some((entry) => entry.executionEnvironment?.mode !== 'namespaced'))) continue;
        if (admitted > active && admittedTask.executionEnvironment?.mode !== 'namespaced') continue;
        // Now this stage is sent: a workflow stage edited before it starts runs with the edited settings
        // (decided and recorded once, here, before any session or turn exists for it).
        const bound = await this.bindStage(target, state.taskId);
        if (!bound) continue;
        target = bound;
        const task = target.preparation.tasks.find((entry) => entry.taskId === state.taskId)!;
        try { await this.dispatch(target, task); admitted += 1; }
        catch (error) {
          await this.runtimeCommand(target, `block-${task.taskId}-${target.revision}`, 'task.block', {
            taskId: task.taskId, reason: error instanceof Error ? error.message : 'Provider dispatch is unavailable.',
          });
        }
      }
    }
  }

  /**
   * Before a workflow stage's first attempt: record whether its edited settings bind for this run.
   * Returns the run to dispatch from (re-read after a binding), or null when the stage is held.
   */
  /** Runs `work` under this service's gate (see WorkflowServiceOptions.executionGate). */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.gate.runExclusive(work);
  }

  private async bindStage(run: ExecutionRun, taskId: string): Promise<ExecutionRun | null> {
    const workflow = run.preparation.workflow;
    if (!workflow || !this.options.committedSubproject || run.stageBindings?.[taskId] || run.attempts.some((attempt) => attempt.taskId === taskId)) return run;
    const committed = await this.options.committedSubproject(run.projectId, workflow.subprojectId)
      .catch((): CommittedSubproject => ({ ok: false, reason: 'unreadable' }));
    const decision = await decideStageBinding(run, taskId, committed, {
      daemon: this.options.daemon.getSnapshot(), now: () => new Date(),
      listModels: async (providerId) => { const result = await this.options.providers.listModels(this.options.daemon.getSnapshot(), providerId); if (!result.ok) throw new Error(result.message); return result.value; },
      handoff: (task) => this.handoff(run, task),
      outputContext: (task) => this.options.workflowResultContext ? this.options.workflowResultContext(run, task, Number.MAX_SAFE_INTEGER) : Promise.resolve(''),
    });
    if (decision.kind !== 'record') {
      const reason = decision.kind === 'retry' ? `The edited stage settings could not be checked: ${decision.reason}`
        : `${decision.reason} Edit this stage or cancel the run, then continue.`;
      await this.runtimeCommand(run, `block-${taskId}-${run.revision}`, 'task.block', { taskId, reason: reason.slice(0, 65_536) });
      return null;
    }
    const receipt = await this.runtimeCommand(run, `bind-stage-${workflowDigest([run.runId, taskId]).slice(0, 40)}`, 'task.bind', { taskId, binding: decision.binding });
    if (!receipt.ok) { this.options.reportError?.(new Error(`Stage binding for ${taskId} in run ${run.runId} was refused: ${receipt.message}`)); return null; }
    return this.options.ledger.read(run.projectId).runs.find((entry) => entry.runId === run.runId) ?? null;
  }

  /** The previous attempt of this stage (in this run or the run it replaces), quoted in the turn as preserved evidence. */
  private handoff(run: ExecutionRun, task: PreparedExecutionTask): string {
    const previousRun = run.preparation.supersedesRunId
      ? this.options.ledger.read(run.projectId).runs.find(entry => entry.runId === run.preparation.supersedesRunId) : undefined;
    const previousTask = previousRun?.preparation.tasks.find(entry => (entry.sourceTaskId ?? entry.taskId) === (task.sourceTaskId ?? task.taskId));
    const localPrevious = run.attempts.filter((entry) => entry.taskId === task.taskId).at(-1);
    const previous = localPrevious ?? previousRun?.attempts.filter(entry => entry.taskId === previousTask?.taskId).at(-1);
    const previousOwner = localPrevious ? run : previousRun;
    return previous ? `\n\nPrevious attempt context (preserved evidence, not new authority):\n${JSON.stringify({
      runId: previousOwner?.runId, baseline: previousOwner?.preparation.baseline, attempt: previous,
      evidence: previousOwner?.evidence.filter((entry) => entry.attemptId === previous.attemptId),
      reviews: previousOwner?.reviews.filter((entry) => entry.attemptId === previous.attemptId),
    })}` : '';
  }

  private async dispatch(run: ExecutionRun, task: PreparedExecutionTask): Promise<void> {
    const inputs = workflowTaskInputs(run, task);
    const number = run.attempts.filter((entry) => entry.taskId === task.taskId).length + 1;
    const identity = planningAttemptIdentity(run.runId, task.taskId, number);
    const root = this.projectRoot(run.projectId);
    let workspace = this.options.daemon.getSnapshot().workspaces.find((entry) => entry.id === identity.workspaceId && !entry.archivedAt);
    if (!workspace) {
      let workspaceRoot = root;
      if (run.preparation.baseCommit) {
        const branch = `ezterminal/${identity.attemptId}`;
        const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
        if (!listed.ok) throw new Error(listed.message);
        const existing = listed.worktrees.find((entry) => entry.branch === branch || entry.branch === `refs/heads/${branch}`);
        if (existing && !existing.managed) throw new Error('The task branch exists outside EZTerminal managed worktrees.');
        if (existing) workspaceRoot = existing.path;
        else {
          const created = await this.options.worktrees.execute({ action: 'create', cwd: root, branch, base: run.preparation.baseCommit, allowDirtyBase: true }, 'desktop');
          if (!created.ok || !created.opened) throw new Error(created.ok ? 'The worktree was not returned.' : created.message);
          workspaceRoot = created.opened.path;
        }
      }
      if (this.stopped) throw new Error('Execution authority is stopping.');
      // Dependencies are the accepted activations actually selected by this frozen graph.
      const inputRun = run.preparation.workflow ? { ...run,
        tasks: run.tasks.map(state => { const source = inputs.acceptedResults.find(entry => entry.nodeId === state.taskId); return source ? { ...state, state: 'completed' as const, currentAttemptId: source.attemptId } : state; }),
        preparation: { ...run.preparation, tasks: run.preparation.tasks.map(definition => ({ ...definition, dependsOn: definition.taskId === task.taskId ? inputs.task.dependsOn : [] })) } } : run;
      await this.options.prepareWorkspace?.(inputRun, inputs.task, workspaceRoot);
      await this.daemonCommand(`${identity.dispatchId}-workspace`, 'workspace.create', {
        workspaceId: identity.workspaceId, projectId: run.projectId, name: task.title,
        kind: run.preparation.baseCommit ? 'worktree' : 'local', rootPath: workspaceRoot,
      });
      workspace = this.options.daemon.getSnapshot().workspaces.find((entry) => entry.id === identity.workspaceId);
    }
    if (!workspace) throw new Error('Task workspace registration is incomplete.');
    const environment = await this.options.environments?.reserve({ runId: run.runId, taskId: task.taskId, attemptId: identity.attemptId,
      sessionId: identity.sessionId, workspaceId: workspace.id, workspaceRoot: workspace.rootPath! }, task.executionEnvironment?.portCount ?? 1, task.executionEnvironment?.mode ?? 'serial');
    if (!this.options.daemon.getSnapshot().sessions.some((entry) => entry.id === identity.sessionId)) {
      await this.daemonCommand(`${identity.dispatchId}-session`, 'agent.create', {
        sessionId: identity.sessionId, workspaceId: workspace.id, title: task.title,
        providerId: task.profile.providerId, model: task.profile.model, permissionPreset: task.profile.permissionPreset,
      });
    }
    const handoff = this.handoff(run, task);
    const environmentBrief = environment ? `\n\nExecution environment: ${JSON.stringify(environment.environment)}\nUse the assigned PORT and output/temp directories. When namespaced parallel execution is enabled, use EZTERMINAL_TEST_NAMESPACE for test databases and fixtures. If a tool cannot isolate its shared resources, stop and report the conflict. Never terminate processes you did not start. Stop your temporary preview/test servers before submitting the result.` : '';
    const prompt = `${task.profile.prompt}\n\n${task.brief}${inputs.context}${environmentBrief}${handoff}`;
    if (inputs.acceptedResults.length && !this.options.workflowResultContext) throw new Error('The captured workflow result authority is unavailable. No stage was submitted.');
    const outputContext = inputs.acceptedResults.length ? await this.options.workflowResultContext!(run, task, 100_000 - prompt.length) : '';
    if (prompt.length + outputContext.length > 100_000) throw new Error('The exact stage prompt exceeds the 100,000 character turn limit. All source documents and results were preserved; no truncated prompt was submitted.');
    await this.daemonCommand(`${identity.dispatchId}-submit`, 'agent.submit', {
      sessionId: identity.sessionId, prompt: `${prompt}${outputContext}`,
    });
  }

  private async reconcile(run: ExecutionRun): Promise<void> {
    for (const attempt of run.attempts) {
      if (attempt.state !== 'running' && attempt.state !== 'delivery-uncertain') continue;
      const turn = this.options.daemon.getSnapshot().turns.find((entry) => entry.id === attempt.turnId);
      if (!turn) continue;
      if (['queued', 'submitting', 'working', 'blocked'].includes(turn.state)) {
        if (attempt.state === 'delivery-uncertain' && turn.state !== 'queued') {
          await this.runtimeCommand(run, `reconcile-live-${attempt.attemptId}-${run.revision}`, 'attempt.reconcile', {
            attemptId: attempt.attemptId, outcome: 'running', artifacts: attempt.artifacts,
            proof: `Provider reconciliation confirmed daemon turn ${turn.id} is ${turn.state}.`,
          });
        }
        continue;
      }
      if (turn.state === 'delivery-uncertain' && attempt.state === 'delivery-uncertain') continue;
      const task = run.preparation.tasks.find((entry) => entry.taskId === attempt.taskId)!;
      let outcome: 'succeeded' | 'interrupted' | 'delivery-uncertain' | 'failed' = turn.state === 'completed' ? 'succeeded' : turn.state === 'interrupted' ? 'interrupted'
        : turn.state === 'delivery-uncertain' ? 'delivery-uncertain' : 'failed';
      let artifacts: readonly ExecutionArtifact[] = [];
      let captureFailure: string | undefined;
      if (outcome === 'succeeded') {
        try { artifacts = await this.options.captureResult(run, task, attempt); }
        catch (error) { outcome = 'failed'; captureFailure = error instanceof Error ? error.message : 'Result capture failed. Source worktree was preserved.'; }
      } else if (outcome !== 'delivery-uncertain' && this.options.capturePartialResult) {
        try { artifacts = await this.options.capturePartialResult(run, task, attempt); }
        catch (error) { captureFailure = `Partial worktree was preserved in place. ${error instanceof Error ? error.message : 'Snapshot capture was unavailable.'}`; }
      }
      const finished = await this.runtimeCommand(run, `finish-${attempt.attemptId}-${turn.state}`, attempt.state === 'delivery-uncertain' ? 'attempt.reconcile' : 'attempt.finish', {
        attemptId: attempt.attemptId, outcome, artifacts,
        ...(attempt.state === 'delivery-uncertain' ? { proof: captureFailure ?? `Authoritative daemon turn ${turn.id}: ${turn.state}.` }
          : { summary: captureFailure ?? `Daemon turn ${turn.id}: ${turn.state}${turn.errorCode ? ` (${turn.errorCode})` : ''}.` }),
      });
      if (finished.ok) {
        if (outcome !== 'delivery-uncertain') await this.options.environments?.release(attempt.sessionId);
        this.requested = true;
      } else this.options.reportError?.(new Error(`Result reconciliation failed: ${finished.message}`));
    }
  }

  private async cancelCurrent(projectId: string, runId: string, taskId: string): Promise<void> {
    const run = this.options.ledger.read(projectId).runs.find((entry) => entry.runId === runId);
    const current = run?.tasks.find((entry) => entry.taskId === taskId)?.currentAttemptId;
    const attempt = run?.attempts.find((entry) => entry.attemptId === current);
    if (attempt) await this.daemonCommand(`cancel-${attempt.attemptId}`, 'agent.cancel', { sessionId: attempt.sessionId });
    else if (run) {
      const identity = planningAttemptIdentity(runId, taskId, run.attempts.filter((entry) => entry.taskId === taskId).length + 1);
      if (this.options.daemon.getSnapshot().sessions.some(session => session.id === identity.sessionId)) await this.daemonCommand(`cancel-${identity.attemptId}`, 'agent.cancel', { sessionId: identity.sessionId });
      await this.options.environments?.release(identity.sessionId);
    }
  }

  private async runtimeCommand(run: ExecutionRun, commandId: string, type: PlanningExecutionCommand['type'], payload: Record<string, unknown>, principalId = 'planning-runtime'): Promise<PlanningExecutionReceipt> {
    for (let retry = 0; retry < RUNTIME_COMMAND_RETRIES; retry += 1) {
      const id = `${commandId}-${retry}`;
      const existing = this.options.ledger.getReceipt(run.projectId, id);
      if (existing && (existing.ok || existing.error !== 'revision-conflict')) return existing;
      if (existing) continue;
      const result = await this.options.ledger.execute({ commandId: id, projectId: run.projectId,
        expectedRevision: this.options.ledger.read(run.projectId).revision, principal: { kind: 'runtime', id: principalId },
        type, payload: { runId: run.runId, ...payload } });
      if (result.ok || result.error !== 'revision-conflict') return result;
    }
    throw new Error('Execution state changed repeatedly; no duplicate dispatch was issued.');
  }

  private async daemonCommand(id: string, type: DaemonCommand['type'], payload: unknown): Promise<DaemonCommandReceipt> {
    if (this.stopped) throw new Error('Execution authority is stopping.');
    for (let retry = 0; retry < 5; retry += 1) {
      const commandId = `${id}-${retry}`;
      const previous = this.options.store.findCommand(commandId);
      if (previous?.receipt && !previous.receipt.ok && previous.receipt.error.code === 'revision-conflict') continue;
      const command = previous?.command ?? createDaemonCommand({ commandId, idempotencyKey: commandId,
        expectedRevision: this.options.daemon.getSnapshot().revision, issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'planning-runtime' }, type, payload } as Parameters<typeof createDaemonCommand>[0]);
      const receipt = previous?.receipt ?? await this.options.daemon.execute(command);
      if (receipt.ok) return receipt;
      if (receipt.error.code !== 'revision-conflict') throw new Error(receipt.error.message);
    }
    throw new Error('The daemon changed repeatedly; reconcile before dispatching again.');
  }
}
