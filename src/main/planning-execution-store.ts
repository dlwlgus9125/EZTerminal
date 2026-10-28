import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  PLANNING_AGENT_RUN_COMMANDS,
  PLANNING_AUTO_APPROVAL_PRINCIPAL,
  PLANNING_LAUNCH_PRINCIPAL,
  PLANNING_REPEAT_PRINCIPAL,
  blockingRunOf,
  runSubprojectId,
  PLANNING_EXECUTION_VERSION,
  PlanningExecutionCommandSchema,
  boundStageIssues,
  changedStageSettings,
  effectiveRun,
  stageInputsRebound,
  stageStructureChanged,
  taskMatchesStage,
  type ExecutionArtifact,
  type ExecutionAttempt,
  type ExecutionRun,
  type ExecutionTask,
  type PlanningExecutionCommand,
  type PlanningExecutionError,
  type PlanningExecutionReceipt,
  type PlanningExecutionSnapshot,
} from '../shared/planning-execution';
import type { DaemonStore } from './daemon-store';
import { advanceWorkflowRun } from './workflow-runtime';
import { validateWorkflowGraph } from '../shared/workflow-graph';
import { workflowDigest } from './workflow-service';
import { isRunReviewer } from './planning-review-identity';

interface RunRow {
  readonly preparation_json: string;
  readonly preparation_fingerprint: string;
  readonly state_json: string;
}

class ExecutionFailure extends Error {
  constructor(readonly code: PlanningExecutionError, message: string) { super(message); }
}

function requireState(condition: unknown, code: PlanningExecutionError, message: string): asserts condition {
  if (!condition) throw new ExecutionFailure(code, message);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sameArtifacts(left: readonly ExecutionArtifact[], right: readonly ExecutionArtifact[]): boolean {
  const sort = (values: readonly ExecutionArtifact[]) => [...values].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  return canonical(sort(left)) === canonical(sort(right));
}

function assertUniqueArtifacts(values: readonly ExecutionArtifact[]): void {
  requireState(new Set(values.map((entry) => entry.artifactId)).size === values.length,
    'invalid-reference', 'Artifact identities must be unique.');
}

function readRevision(database: DatabaseSync, projectId: string): number {
  const row = database.prepare('SELECT revision FROM planning_execution_projects WHERE project_id = ?').get(projectId);
  return Number(row?.revision ?? 0);
}

/**
 * A run as it executes: the stored preparation is verified against its fingerprint first, then
 * stage bindings recorded in run state replace their prepared tasks (see effectiveRun). `frozen`
 * returns the stored preparation untouched, for audit.
 */
function runFromRow(row: RunRow, frozen = false): ExecutionRun {
  const preparation = JSON.parse(row.preparation_json) as ExecutionRun['preparation'];
  if (fingerprint(preparation) !== row.preparation_fingerprint) throw new Error('Execution preparation integrity check failed.');
  const state = JSON.parse(row.state_json) as Omit<ExecutionRun, 'preparation' | 'preparationFingerprint'>;
  const run: ExecutionRun = {
    ...state,
    preparation,
    preparationFingerprint: row.preparation_fingerprint,
  };
  return frozen ? run : effectiveRun(run);
}

function readRun(database: DatabaseSync, projectId: string, runId: string, frozen = false): ExecutionRun | undefined {
  const row = database.prepare('SELECT * FROM planning_execution_runs WHERE project_id = ? AND run_id = ?')
    .get(projectId, runId) as unknown as RunRow | undefined;
  return row ? runFromRow(row, frozen) : undefined;
}

function writeRun(database: DatabaseSync, run: ExecutionRun): void {
  const { preparation, preparationFingerprint, ...state } = run;
  database.prepare(`
    INSERT INTO planning_execution_runs (run_id, project_id, preparation_json, preparation_fingerprint, state_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET state_json = excluded.state_json
  `).run(run.runId, run.projectId, canonical(preparation), preparationFingerprint, JSON.stringify(state));
}

function withTask(run: ExecutionRun, taskId: string, patch: Partial<ExecutionTask>): ExecutionRun {
  return { ...run, tasks: run.tasks.map((task) => task.taskId === taskId ? { ...task, ...patch } : task) };
}

function withAttempt(run: ExecutionRun, attemptId: string, patch: Partial<ExecutionAttempt>): ExecutionRun {
  return { ...run, attempts: run.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, ...patch } : attempt) };
}

function projectRunState(run: ExecutionRun, database: DatabaseSync): ExecutionRun {
  if (run.cancelRequested) {
    const activeReview = (database.prepare("SELECT t.session_id FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? AND t.state NOT IN ('completed', 'failed', 'interrupted')").all(run.projectId) as { session_id: string }[]).some(turn => isRunReviewer(run, turn.session_id));
    return { ...run, state: activeReview || run.attempts.some(attempt => ['running', 'delivery-uncertain'].includes(attempt.state)) ? 'paused' : 'cancelled' };
  }
  if (!run.startedAt) return run;
  if (run.preparation.workflow) return advanceWorkflowRun(run);
  const completed = new Set(run.tasks.filter((task) => task.state === 'completed').map((task) => task.taskId));
  const tasks = run.tasks.map((task): ExecutionTask => {
    const definition = run.preparation.tasks.find((entry) => entry.taskId === task.taskId)!;
    return task.state === 'waiting' && definition.dependsOn.every((id) => completed.has(id))
      ? { ...task, state: 'ready' }
      : task;
  });
  const acceptedTasks = tasks.filter((task) => {
    const group = run.preparation.tasks.find((entry) => entry.taskId === task.taskId)?.candidateGroupId;
    return !group || !run.selectedCandidates?.[group] || run.selectedCandidates[group] === task.taskId;
  });
  const candidatesSelected = run.preparation.tasks.every((task) => !task.candidateGroupId || run.selectedCandidates?.[task.candidateGroupId]);
  const state = acceptedTasks.every((task) => task.state === 'completed') && candidatesSelected
    && !run.attempts.some((attempt) => attempt.state === 'running' || attempt.state === 'delivery-uncertain') ? 'completed'
    : run.dispatchPaused ? 'paused'
    : tasks.some((task) => task.state === 'running' || task.state === 'ready') ? 'running'
      : tasks.some((task) => task.state === 'reconciling') ? 'reconciling'
        : tasks.some((task) => task.state === 'awaiting-review') ? 'awaiting-review'
          : 'paused';
  return { ...run, tasks, state };
}

function markRepairExhausted(run: ExecutionRun, taskId: string, now: string): ExecutionRun {
  const definition = run.preparation.tasks.find((task) => task.taskId === taskId)!;
  const task = run.tasks.find((entry) => entry.taskId === taskId)!;
  if (task.retriesUsed < definition.retryLimit + (task.extraRetriesGranted ?? 0)
    || run.gates.some((gate) => gate.kind === 'repair-exhausted' && gate.state === 'pending' && gate.taskIds.includes(taskId))) return run;
  return { ...run, gates: [...run.gates, {
    gateId: `repair-${taskId}-${task.retriesUsed}`,
    kind: 'repair-exhausted',
    taskIds: [taskId],
    state: 'pending',
    detail: 'The repair limit has been reached. Explicitly authorize one additional attempt or prepare a new run.',
    createdAt: now,
  }] };
}

/** Durable execution ledger. Provider dispatch is deliberately outside database transactions. */
export class PlanningExecutionStore {
  private readonly committed = new Set<(projectId: string) => void>();
  constructor(private readonly authority: DaemonStore, private readonly now: () => Date = () => new Date()) {}

  /**
   * Called after a ledger write commits: a new receipt (accepted or refused) or a restart recovery,
   * never a replayed receipt. Listeners run after the write, outside the ledger transaction.
   */
  onCommitted(listener: (projectId: string) => void): () => void {
    this.committed.add(listener);
    return () => { this.committed.delete(listener); };
  }

  private notifyCommitted(projectIds: Iterable<string>): void {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0 || this.committed.size === 0) return;
    queueMicrotask(() => {
      for (const projectId of ids) for (const listener of this.committed) {
        try { listener(projectId); } catch { /* a listener failure never reaches the ledger */ }
      }
    });
  }

  /** Runs as they execute (stage bindings applied); `{ frozen: true }` returns the stored preparations. */
  read(projectId: string, options: { readonly frozen?: boolean } = {}): PlanningExecutionSnapshot {
    return this.authority.readPlanningExecution((database) => ({
      version: PLANNING_EXECUTION_VERSION,
      projectId,
      revision: readRevision(database, projectId),
      runs: (database.prepare('SELECT * FROM planning_execution_runs WHERE project_id = ? ORDER BY rowid')
        .all(projectId) as unknown as RunRow[]).map((row) => runFromRow(row, options.frozen)),
    }));
  }

  /** Projects that have execution runs (for the host's own reads, such as what waits on the person). */
  projectIds(): string[] {
    return this.authority.readPlanningExecution((database) => (database.prepare('SELECT DISTINCT project_id FROM planning_execution_runs ORDER BY project_id')
      .all() as unknown as Array<{ project_id: string }>).map((row) => String(row.project_id)));
  }

  /** Read-only reconciliation; clients never resend an uncertain command under a new ID. */
  getReceipt(projectId: string, commandId: string): PlanningExecutionReceipt | null {
    return this.authority.readPlanningExecution((database) => {
      const row = database.prepare('SELECT receipt_json FROM planning_execution_receipts WHERE project_id = ? AND command_id = ?')
        .get(projectId, commandId);
      return row ? JSON.parse(String(row.receipt_json)) as PlanningExecutionReceipt : null;
    });
  }

  execute(input: unknown): Promise<PlanningExecutionReceipt> {
    const parsed = PlanningExecutionCommandSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({
      ok: false, commandId: '', projectId: '', revision: 0,
      error: 'invalid-command', message: 'The execution command is invalid.',
    });
    const command = parsed.data;
    let written = false;
    return this.authority.writePlanningExecution<PlanningExecutionReceipt>((database) => {
      const revision = readRevision(database, command.projectId);
      const digest = fingerprint(command);
      const previous = database.prepare('SELECT command_fingerprint, receipt_json FROM planning_execution_receipts WHERE command_id = ?')
        .get(command.commandId);
      if (previous) {
        if (previous.command_fingerprint !== digest) return {
          ok: false, commandId: command.commandId, projectId: command.projectId, revision,
          error: 'command-conflict', message: 'This command ID belongs to a different request.',
        };
        return { ...JSON.parse(String(previous.receipt_json)) as PlanningExecutionReceipt, replayed: true };
      }
      let receipt: PlanningExecutionReceipt;
      // Domain validation uses a savepoint so a rejected command cannot leave partial refs or rows.
      database.exec('SAVEPOINT planning_execution_command');
      try {
        requireState(command.expectedRevision === revision, 'revision-conflict', 'The execution state changed. Reload before creating a new command.');
        const project = database.prepare('SELECT archived_at FROM projects WHERE id = ?').get(command.projectId);
        requireState(project && project.archived_at === null, 'invalid-reference', 'The owning project is unavailable.');
        this.checkPrincipal(command);
        const now = this.now().toISOString();
        const changed = this.apply(database, command, now);
        const nextRevision = revision + 1;
        database.prepare(`INSERT INTO planning_execution_projects (project_id, revision) VALUES (?, ?)
          ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision`).run(command.projectId, nextRevision);
        writeRun(database, { ...projectRunState(changed, database), revision: nextRevision, updatedAt: now });
        receipt = { ok: true, commandId: command.commandId, projectId: command.projectId, revision: nextRevision, runId: changed.runId };
        database.exec('RELEASE planning_execution_command');
      } catch (error) {
        database.exec('ROLLBACK TO planning_execution_command');
        database.exec('RELEASE planning_execution_command');
        if (!(error instanceof ExecutionFailure)) throw error;
        receipt = { ok: false, commandId: command.commandId, projectId: command.projectId, revision, error: error.code, message: error.message };
      }
      database.prepare('INSERT INTO planning_execution_receipts (command_id, project_id, command_fingerprint, receipt_json) VALUES (?, ?, ?, ?)')
        .run(command.commandId, command.projectId, digest, JSON.stringify(receipt));
      written = true;
      return receipt;
    }).then((receipt) => {
      if (written) this.notifyCommitted([command.projectId]);
      return receipt;
    });
  }

  /** Restart never means successful delivery or permission to repeat a provider call. */
  recoverInterrupted(): Promise<number> {
    return this.authority.writePlanningExecution((database) => {
      const rows = database.prepare('SELECT * FROM planning_execution_runs').all() as unknown as RunRow[];
      let recovered = 0;
      const projects: string[] = [];
      const now = this.now().toISOString();
      for (const row of rows) {
        const run = runFromRow(row);
        const running = new Set(run.attempts.filter((attempt) => attempt.state === 'running').map((attempt) => attempt.attemptId));
        if (running.size === 0) continue;
        const revision = readRevision(database, run.projectId) + 1;
        const next: ExecutionRun = {
          ...run, revision, updatedAt: now,
          attempts: run.attempts.map((attempt) => running.has(attempt.attemptId)
            ? { ...attempt, state: 'delivery-uncertain', reconciliation: 'Host restart requires provider reconciliation.' }
            : attempt),
          tasks: run.tasks.map((task) => task.currentAttemptId && running.has(task.currentAttemptId) && task.state === 'running'
            ? { ...task, state: 'reconciling' }
            : task),
        };
        writeRun(database, projectRunState(next, database));
        database.prepare('UPDATE planning_execution_projects SET revision = ? WHERE project_id = ?').run(revision, run.projectId);
        recovered += running.size;
        projects.push(run.projectId);
      }
      return { recovered, projects };
    }).then(({ recovered, projects }) => {
      this.notifyCommitted(projects);
      return recovered;
    });
  }

  private checkPrincipal(command: PlanningExecutionCommand): void {
    const runtime = ['attempt.start', 'attempt.finish', 'attempt.reconcile', 'evidence.record', 'task.block', 'task.bind', 'run.cancel-reconcile'].includes(command.type);
    // The host approves and integrates only for a run frozen with automatic approval (checked in apply).
    const autoApproval = command.principal.kind === 'runtime' && command.principal.id === PLANNING_AUTO_APPROVAL_PRINCIPAL
      && (command.type === 'workflow.approve' || command.type === 'workflow.integrate');
    // A launch whose start failed cancels the run it prepared (checked against its own prepare in apply), nothing else.
    const launchCleanup = command.principal.kind === 'runtime' && command.principal.id === PLANNING_LAUNCH_PRINCIPAL;
    requireState(!launchCleanup || command.type === 'run.cancel', 'user-required', 'A launch can only cancel the run it prepared and could not start.');
    // The repeat schedule prepares and starts a run; approvals, integration and everything else stay with the person.
    const repeat = command.principal.kind === 'runtime' && command.principal.id === PLANNING_REPEAT_PRINCIPAL;
    requireState(!repeat || command.type === 'run.prepare' || command.type === 'run.start', 'user-required', 'A repeat schedule can only prepare and start a run.');
    requireState(!runtime || command.principal.kind === 'runtime', 'runtime-required', 'Only the host execution adapter can record provider activity.');
    requireState(runtime || autoApproval || launchCleanup || repeat || ['run.pause-impact', 'review.decide', 'attempt.retry'].includes(command.type) || command.principal.kind !== 'runtime',
      'user-required', 'This decision requires an explicit user command.');
    requireState(command.principal.kind !== 'agent' || (PLANNING_AGENT_RUN_COMMANDS as readonly string[]).includes(command.type),
      'user-required', 'An agent can prepare, start, pause, continue or cancel a run; approvals, reviews and integration are the person’s.');
  }

  private apply(database: DatabaseSync, command: PlanningExecutionCommand, now: string): ExecutionRun {
    const { projectId, payload } = command;
    if (command.type === 'run.prepare') {
      const preparation = command.payload.preparation;
      if (preparation.workflow) {
        requireState(workflowDigest(preparation.workflow.graph) === preparation.workflow.fingerprint && preparation.subprojectId === preparation.workflow.subprojectId, 'invalid-reference', 'The frozen graph identity or fingerprint is invalid.');
        requireState(validateWorkflowGraph(preparation.workflow.graph, true).length === 0, 'invalid-reference', 'The frozen workflow is invalid.');
        requireState(preparation.workflow.graph.nodes.filter(node => node.operation === 'agent').every(node => preparation.tasks.some(task => task.taskId === node.id))
          && preparation.tasks.every(task => preparation.workflow!.graph.nodes.some(node => node.id === task.taskId && node.operation === 'agent')),
        'invalid-reference', 'Execution tasks must exactly match frozen AI stages.');
        requireState(preparation.tasks.every(task => taskMatchesStage(task, preparation.workflow!.graph.nodes.find(entry => entry.id === task.taskId)!)),
          'invalid-reference', 'Prepared settings must match the frozen graph stages.');
      }
      requireState(!database.prepare('SELECT run_id FROM planning_execution_runs WHERE run_id = ?').get(payload.runId),
        'invalid-transition', 'The run already exists; prepare a new run to change its configuration.');
      const ids = new Set(preparation.tasks.map((task) => task.taskId));
      requireState(ids.size === preparation.tasks.length, 'invalid-reference', 'Task IDs must be unique.');
      assertUniqueArtifacts(preparation.artifacts);
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (taskId: string): void => {
        requireState(!visiting.has(taskId), 'invalid-reference', 'Task dependencies contain a cycle.');
        if (visited.has(taskId)) return;
        const task = preparation.tasks.find((entry) => entry.taskId === taskId);
        requireState(task, 'invalid-reference', 'A task dependency is missing.');
        requireState(new Set(task.dependsOn).size === task.dependsOn.length, 'invalid-reference', 'Task dependencies must be unique.');
        const acceptanceIds = new Set(task.acceptance.map((entry) => entry.acceptanceId));
        requireState(acceptanceIds.size === task.acceptance.length
          && new Set(task.validations.map((entry) => entry.validationId)).size === task.validations.length
          && task.validations.every((validation) => validation.acceptanceIds.every((id) => acceptanceIds.has(id)))
          && [...acceptanceIds].every((id) => task.validations.some((validation) => validation.acceptanceIds.includes(id))),
        'invalid-reference', 'Every acceptance criterion needs an explicit validation plan.');
        visiting.add(taskId);
        for (const dependency of task.dependsOn) visit(dependency);
        visiting.delete(taskId);
        visited.add(taskId);
      };
      for (const taskId of ids) visit(taskId);
      if (preparation.supersedesRunId) requireState(readRun(database, projectId, preparation.supersedesRunId),
        'invalid-reference', 'The superseded run must belong to this project.');
      for (const dependency of preparation.externalDependencies ?? []) {
        const previous = readRun(database, projectId, dependency.runId);
        const task = previous?.tasks.find((entry) => entry.taskId === dependency.taskId);
        const attempt = previous?.attempts.find((entry) => entry.attemptId === dependency.attemptId);
        requireState(dependency.runId === preparation.supersedesRunId && task?.state === 'completed' && task.currentAttemptId === dependency.attemptId
          && attempt && sameArtifacts(attempt.artifacts, dependency.artifacts)
          && previous?.reviews.some((review) => review.attemptId === attempt.attemptId && review.decision === 'approve'),
        'stale-review', 'An external prerequisite is no longer the exact accepted result.');
      }
      return {
        runId: payload.runId, projectId, revision: 0, state: 'prepared',
        preparation, preparationFingerprint: fingerprint(preparation), createdAt: now, updatedAt: now,
        tasks: preparation.tasks.map((task) => ({ taskId: task.taskId, state: 'waiting', retriesUsed: 0 })),
        attempts: [], evidence: [], reviews: [], gates: [],
      };
    }
    const foundRun = readRun(database, projectId, payload.runId);
    requireState(foundRun, 'not-found', 'The execution run was not found.');
    let run: ExecutionRun = foundRun;
    requireState(!run.cancelRequested || ['attempt.finish', 'attempt.reconcile', 'run.cancel', 'run.cancel-reconcile'].includes(command.type), 'invalid-transition', 'This run is cancelled or waiting for cancellation acknowledgement.');
    switch (command.type) {
      case 'run.cancel-reconcile':
        requireState(run.cancelRequested, 'invalid-transition', 'Only requested cancellation can be reconciled.'); return run;
      case 'run.cancel':
        requireState(run.state !== 'completed', 'invalid-transition', 'Completed results are immutable.');
        if (command.principal.kind === 'runtime' && command.principal.id === PLANNING_LAUNCH_PRINCIPAL) {
          // Only `workflow:<launch>:cancel-<n>` for the run `workflow:<launch>:prepare` prepared, before it started.
          const launch = /^(workflow:workflow-launch:[0-9a-f]{48}):cancel-\d{1,5}$/u.exec(command.commandId)?.[1];
          const prepared = launch && database.prepare('SELECT receipt_json FROM planning_execution_receipts WHERE project_id = ? AND command_id = ?').get(projectId, `${launch}:prepare`);
          const receipt = prepared ? JSON.parse(String(prepared.receipt_json)) as PlanningExecutionReceipt : null;
          requireState(receipt?.ok === true && receipt.runId === run.runId && !run.startedAt, 'user-required', 'A launch can only cancel the run it prepared and could not start.');
        }
        return { ...run, cancelRequested: true, dispatchPaused: true, tasks: run.tasks.map(task => {
          if (task.state === 'completed') return task;
          const active = run.attempts.some(attempt => attempt.attemptId === task.currentAttemptId && ['running', 'delivery-uncertain'].includes(attempt.state));
          return { ...task, cancelRequested: true, state: active ? 'paused' : 'cancelled', pauseReason: active ? 'Cancellation acknowledgement pending.' : undefined };
        }) };
      case 'workflow.integrate':
        requireState(command.principal.kind !== 'runtime' || run.preparation.approvalPolicy === 'auto', 'user-required', 'This run waits for a person to allow integration.');
        requireState(run.preparation.workflow && run.state === 'completed' && !run.dispatchPaused && !run.gates.some(gate => gate.state === 'pending'), 'invalid-transition', 'Complete the workflow and resolve approvals before requesting integration.');
        return { ...run, integrationAuthorized: { by: command.principal.id, at: now } };
      case 'workflow.approve': {
        requireState(command.principal.kind !== 'runtime' || run.preparation.approvalPolicy === 'auto', 'user-required', 'This run waits for a person to approve.');
        const activation = run.workflowRuntime?.activations.find(entry => entry.id === command.payload.activationId);
        requireState(activation?.state === 'awaiting-approval', 'invalid-transition', 'This exact workflow approval is no longer pending.');
        requireState(run.preparation.workflow?.graph.nodes.find(node => node.id === activation.nodeId)?.operation === 'approval', 'invalid-reference', 'The stage is not an approval gate.');
        // A note goes back only with a rejection: it reaches the stage the rejection returns to.
        const comment = command.payload.decision === 'reject' ? command.payload.comment : undefined;
        return { ...run, workflowRuntime: { ...run.workflowRuntime!, activations: run.workflowRuntime!.activations.map(entry => entry.id === activation.id
          ? { ...entry, state: 'active', outcome: command.payload.decision === 'approve' ? 'approved' : 'rejected', resolvedBy: command.principal.id, resolvedAt: now, ...(comment ? { comment } : {}) } : entry) } };
      }
      case 'workflow.answer': {
        // Only a person answers: never 자동 승인, never an agent.
        requireState(command.principal.kind === 'desktop' || command.principal.kind === 'android', 'user-required', 'Only a person answers this stage.');
        const activation = run.workflowRuntime?.activations.find(entry => entry.id === command.payload.activationId);
        requireState(activation?.state === 'awaiting-answer', 'invalid-transition', 'This stage no longer waits for an answer.');
        requireState(run.preparation.workflow?.graph.nodes.find(node => node.id === activation.nodeId)?.operation === 'answer', 'invalid-reference', 'The stage does not ask for an answer.');
        return { ...run, workflowRuntime: { ...run.workflowRuntime!, activations: run.workflowRuntime!.activations.map(entry => entry.id === activation.id
          ? { ...entry, state: 'active', outcome: 'next', answer: command.payload.answer, resolvedBy: command.principal.id, resolvedAt: now } : entry) } };
      }
      case 'run.start': {
        requireState(run.state === 'prepared', 'invalid-transition', 'Only a prepared run can start.');
        // One unfinished run per flow (or per subproject a planning run is addressed to).
        const owner = runSubprojectId(run);
        const others = owner ? (database.prepare('SELECT * FROM planning_execution_runs WHERE project_id = ? ORDER BY rowid').all(projectId) as unknown as RunRow[]).map((row) => runFromRow(row)) : [];
        requireState(!owner || !blockingRunOf(others, owner, run.runId), 'active-run', 'This flow is still running. Finish or cancel that run before starting another.');
        for (const dependency of run.preparation.externalDependencies ?? []) {
          const previous = readRun(database, projectId, dependency.runId);
          const task = previous?.tasks.find((entry) => entry.taskId === dependency.taskId);
          const attempt = previous?.attempts.find((entry) => entry.attemptId === dependency.attemptId);
          requireState(task?.state === 'completed' && task.currentAttemptId === dependency.attemptId
            && attempt && sameArtifacts(attempt.artifacts, dependency.artifacts),
          'stale-review', 'An accepted prerequisite changed after preparation. Prepare the run again.');
        }
        if (run.preparation.supersedesRunId) {
          const previous = readRun(database, projectId, run.preparation.supersedesRunId)!;
          const sources = new Set(run.preparation.tasks.map((task) => task.sourceTaskId ?? task.taskId));
          const replacedIds = new Set(previous.preparation.tasks.filter((task) => sources.has(task.sourceTaskId ?? task.taskId)).map((task) => task.taskId));
          requireState(!previous.attempts.some((attempt) => replacedIds.has(attempt.taskId)
            && ['running', 'delivery-uncertain'].includes(attempt.state)),
          'invalid-transition', 'Stop and reconcile the previous assignment before starting its replacement.');
          writeRun(database, { ...projectRunState({ ...previous,
            tasks: previous.tasks.map((task) => replacedIds.has(task.taskId) ? { ...task, state: 'stale', pauseReason: `Replaced by ${run.runId}.` } : task),
          }, database), revision: readRevision(database, projectId) + 1, updatedAt: now });
        }
        return { ...run, startedAt: now, state: 'running' };
      }
      case 'run.pause':
        requireState(run.startedAt && run.state !== 'completed', 'invalid-transition', 'Only an active run can pause new dispatch.');
        return { ...run, dispatchPaused: true };
      case 'run.continue':
        requireState(run.startedAt && run.state !== 'completed', 'invalid-transition', 'Only an active run can continue.');
        return { ...run, dispatchPaused: false, tasks: run.tasks.map((task) =>
          task.state === 'paused' && !task.currentAttemptId && !task.cancelRequested
            && !run.gates.some((gate) => gate.state === 'pending' && gate.taskIds.includes(task.taskId))
            ? { ...task, state: 'waiting', pauseReason: undefined } : task) };
      case 'task.cancel': {
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(task && task.state !== 'completed', 'invalid-transition', 'This task cannot be cancelled.');
        const active = run.attempts.some((attempt) => attempt.attemptId === task.currentAttemptId
          && (attempt.state === 'running' || attempt.state === 'delivery-uncertain'));
        return withTask(run, task.taskId, { state: active ? 'paused' : 'cancelled', cancelRequested: true, pauseReason: active ? 'Cancellation acknowledgement pending.' : undefined });
      }
      case 'task.block': {
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(task?.state === 'ready', 'invalid-transition', 'Only an undispatched task can be blocked.');
        return withTask(run, task.taskId, { state: 'paused', pauseReason: command.payload.reason });
      }
      case 'task.bind': {
        // Recorded once, right before a not-yet-started workflow stage is sent to its provider.
        const { taskId, binding } = command.payload;
        const raw = readRun(database, projectId, payload.runId, true)!;
        const task = run.tasks.find((entry) => entry.taskId === taskId);
        const frozenTask = raw.preparation.tasks.find((entry) => entry.taskId === taskId);
        const frozenNode = raw.preparation.workflow?.graph.nodes.find((entry) => entry.id === taskId);
        requireState(raw.preparation.workflow && frozenTask && frozenNode?.operation === 'agent', 'invalid-reference', 'Only a workflow AI stage can be bound.');
        requireState(task?.state === 'ready' && !run.attempts.some((attempt) => attempt.taskId === taskId) && !run.stageBindings?.[taskId],
          'invalid-transition', 'A stage is bound once, before its first attempt.');
        if (binding.outcome === 'applied') {
          const node = binding.node!; const bound = binding.task!;
          requireState(node.id === taskId && !stageStructureChanged(frozenNode, node) && canonical(node.position) === canonical(frozenNode.position),
            'invalid-reference', 'A binding changes only the stage settings, never its structure.');
          requireState(bound.taskId === taskId && canonical(bound.dependsOn) === canonical(frozenTask.dependsOn)
            && canonical(bound.executionEnvironment ?? null) === canonical(frozenTask.executionEnvironment ?? null) && bound.stage === frozenTask.stage
            && taskMatchesStage(bound, node), 'invalid-reference', 'The bound task must match its bound stage and keep the prepared dependencies.');
          requireState(boundStageIssues(run.preparation.workflow!.graph, node).length === 0, 'invalid-reference', 'The bound stage is not runnable.');
          requireState(canonical([...(binding.changed ?? [])].sort()) === canonical(changedStageSettings(frozenNode, node).sort()), 'invalid-reference', 'The recorded changes must match the bound stage.');
          requireState(!binding.inputsChanged || stageInputsRebound(run, taskId), 'invalid-reference', 'No input document of this stage was rebound.');
        }
        return { ...run, stageBindings: { ...run.stageBindings, [taskId]: binding } };
      }
      case 'candidate.select': {
        const definition = run.preparation.tasks.find((entry) => entry.taskId === command.payload.taskId);
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(definition?.candidateGroupId && task?.state === 'completed', 'invalid-transition', 'Select a candidate only after its evidence and independent review are accepted.');
        requireState(!run.attempts.some((attempt) => {
          const group = run.preparation.tasks.find((entry) => entry.taskId === attempt.taskId)?.candidateGroupId;
          return group === definition.candidateGroupId && (attempt.state === 'running' || attempt.state === 'delivery-uncertain');
        }), 'invalid-transition', 'Reconcile all candidates before selecting one.');
        return { ...run, selectedCandidates: { ...run.selectedCandidates, [definition.candidateGroupId]: task.taskId } };
      }
      case 'attempt.start': {
        const input = command.payload;
        const task = run.tasks.find((entry) => entry.taskId === input.taskId);
        requireState(run.startedAt && !run.dispatchPaused && task?.state === 'ready', 'invalid-transition', 'This task is not ready to start.');
        requireState(!database.prepare('SELECT attempt_id FROM planning_execution_attempt_refs WHERE attempt_id = ? OR turn_id = ? OR dispatch_id = ?')
          .get(input.attemptId, input.turnId, input.dispatchId), 'invalid-reference', 'Attempt, dispatch, and turn IDs can be assigned only once.');
        const existingRuns = database.prepare('SELECT * FROM planning_execution_runs').all() as unknown as RunRow[];
        requireState(!existingRuns.some((row) => runFromRow(row).attempts.some((attempt) => attempt.sessionId === input.sessionId
          && (attempt.state === 'running' || attempt.state === 'delivery-uncertain'))),
        'invalid-transition', 'This session already owns a running or uncertain execution attempt.');
        const reference = database.prepare(`SELECT s.project_id, s.workspace_id, s.kind, s.source, t.session_id, t.state AS turn_state, a.provider_id, a.model, a.permission_preset
          FROM sessions s JOIN turns t ON t.session_id = s.id JOIN agents a ON a.session_id = s.id
          WHERE s.id = ? AND t.id = ?`).get(input.sessionId, input.turnId);
        const definition = run.preparation.tasks.find((entry) => entry.taskId === task.taskId)!;
        requireState(reference?.project_id === projectId && reference.kind === 'agent' && reference.source === 'structured'
          && reference.provider_id === definition.profile.providerId
          && ['submitting', 'working', 'blocked'].includes(String(reference.turn_state))
          && reference.permission_preset === definition.profile.permissionPreset
          && (definition.profile.model === undefined || definition.profile.model === reference.model),
        'invalid-reference', 'The session and turn must match the owning project and prepared provider settings.');
        const attempt: ExecutionAttempt = {
          attemptId: input.attemptId, taskId: input.taskId, taskRevision: definition.taskRevision,
          dispatchId: input.dispatchId, workspaceId: String(reference.workspace_id),
          number: run.attempts.filter((entry) => entry.taskId === task.taskId).length + 1,
          reason: task.nextAttemptKind ?? 'initial',
          sessionId: input.sessionId, turnId: input.turnId, state: 'running', startedAt: now, artifacts: [],
          requestedSettings: {
            providerId: definition.profile.providerId, model: definition.profile.model,
            reasoningEffort: definition.profile.reasoningEffort, permissionPreset: definition.profile.permissionPreset,
          },
          effectiveSettings: { providerId: String(reference.provider_id), ...(reference.model ? { model: String(reference.model) } : {}), permissionPreset: String(reference.permission_preset) },
        };
        database.prepare('INSERT INTO planning_execution_attempt_refs (attempt_id, dispatch_id, run_id, session_id, turn_id) VALUES (?, ?, ?, ?, ?)')
          .run(input.attemptId, input.dispatchId, run.runId, input.sessionId, input.turnId);
        return withTask({ ...run, attempts: [...run.attempts, attempt],
          ...(run.preparation.progressPolicy === 'manual' ? { dispatchPaused: true } : {}) },
        task.taskId, { state: 'running', currentAttemptId: attempt.attemptId, nextAttemptKind: undefined });
      }
      case 'attempt.finish':
      case 'attempt.reconcile': {
        const input = command.payload;
        const attempt = run.attempts.find((entry) => entry.attemptId === input.attemptId);
        const reconcile = command.type === 'attempt.reconcile';
        requireState(attempt && attempt.state === (reconcile ? 'delivery-uncertain' : 'running'),
          'invalid-transition', reconcile ? 'Only uncertain attempts can be reconciled.' : 'The attempt is no longer running.');
        const task = run.tasks.find((entry) => entry.taskId === attempt.taskId)!;
        requireState(task.currentAttemptId === attempt.attemptId, 'invalid-transition', 'A late result cannot replace a newer attempt.');
        assertUniqueArtifacts(input.artifacts);
        const outcome = input.outcome === 'not-applied' ? 'interrupted' : input.outcome;
        run = withAttempt(run, attempt.attemptId, {
          state: outcome,
          artifacts: input.artifacts,
          ...(outcome !== 'running' && outcome !== 'delivery-uncertain' ? { finishedAt: now } : {}),
          ...(command.type === 'attempt.reconcile' ? { reconciliation: command.payload.proof } : { summary: command.payload.summary }),
        });
        if (task.cancelRequested && !['running', 'delivery-uncertain'].includes(outcome)) {
          run = withTask(run, task.taskId, { state: 'cancelled', pauseReason: undefined });
        } else if (task.state !== 'paused' && task.state !== 'stale') {
          run = withTask(run, task.taskId, {
            state: outcome === 'succeeded' ? 'awaiting-review'
              : outcome === 'delivery-uncertain' ? 'reconciling'
                : outcome === 'running' ? 'running' : outcome === 'interrupted' ? 'cancelled' : 'failed',
          });
          if (outcome === 'failed') run = markRepairExhausted(run, task.taskId, now);
        }
        return run;
      }
      case 'attempt.retry': {
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(task?.state === 'failed', 'invalid-transition', 'Only a failed, reconciled task can be retried.');
        const definition = run.preparation.tasks.find((entry) => entry.taskId === task.taskId)!;
        if (command.principal.kind === 'runtime') {
          requireState(run.preparation.progressPolicy !== 'manual'
            && (run.evidence.some((entry) => entry.attemptId === task.currentAttemptId && entry.status === 'failed')
              || run.reviews.some((entry) => entry.attemptId === task.currentAttemptId && entry.decision === 'reject')),
          'user-required', 'Automatic repair needs a confirmed validation or independent-review failure and an enabled progression policy.');
        }
        requireState(task.retriesUsed < definition.retryLimit + (task.extraRetriesGranted ?? 0), 'retry-limit', 'The retry limit is exhausted. Prepare a newly reviewed run.');
        return withTask(run, task.taskId, { state: 'ready', retriesUsed: task.retriesUsed + 1, nextAttemptKind: 'repair' });
      }
      case 'attempt.extend': {
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        const definition = run.preparation.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(task?.state === 'failed' && definition
          && task.retriesUsed >= definition.retryLimit + (task.extraRetriesGranted ?? 0),
        'invalid-transition', 'Only a failed task at its repair limit can receive one additional attempt.');
        const pending = run.gates.find((gate) => gate.kind === 'repair-exhausted' && gate.state === 'pending' && gate.taskIds.includes(task.taskId));
        requireState(pending, 'invalid-transition', 'The repair-limit decision is not pending.');
        return withTask({ ...run, gates: run.gates.map((gate) => gate.gateId === pending.gateId
          ? { ...gate, state: 'approved', resolvedAt: now, resolvedBy: command.principal.id, detail: command.payload.reason } : gate) },
        task.taskId, { state: 'ready', extraRetriesGranted: (task.extraRetriesGranted ?? 0) + 1,
          retriesUsed: task.retriesUsed + 1, nextAttemptKind: 'repair' });
      }
      case 'attempt.resume': {
        const task = run.tasks.find((entry) => entry.taskId === command.payload.taskId);
        requireState(task?.state === 'cancelled', 'invalid-transition', 'Only a confirmed interrupted or unapplied attempt can resume.');
        return withTask(run, task.taskId, { state: 'ready', nextAttemptKind: 'resume', cancelRequested: false });
      }
      case 'run.pause-impact': {
        requireState(run.startedAt && !run.gates.some((gate) => gate.gateId === command.payload.gateId), 'invalid-transition', 'The run has not started or the gate already exists.');
        const impacted = new Set(command.payload.taskIds);
        requireState([...impacted].every((taskId) => run.tasks.some((task) => task.taskId === taskId)), 'invalid-reference', 'An affected task does not exist.');
        let size = -1;
        while (size !== impacted.size) {
          size = impacted.size;
          for (const task of run.preparation.tasks) if (task.dependsOn.some((id) => impacted.has(id))) impacted.add(task.taskId);
        }
        return {
          ...run,
          tasks: run.tasks.map((task) => impacted.has(task.taskId) ? { ...task, state: 'paused', pauseReason: command.payload.reason } : task),
          attempts: run.attempts.map((attempt) => impacted.has(attempt.taskId) && attempt.state === 'running'
            ? { ...attempt, state: 'delivery-uncertain', reconciliation: 'A requirements change requires stop acknowledgement and reconciliation.' } : attempt),
          gates: [...run.gates, { gateId: command.payload.gateId, kind: 'replan', taskIds: [...impacted], state: 'pending', detail: command.payload.reason, createdAt: now,
            ...(command.payload.sourcePlanningRevision === undefined ? {} : { sourcePlanningRevision: command.payload.sourcePlanningRevision }) }],
        };
      }
      case 'gate.keep-original': {
        const gate = run.gates.find((entry) => entry.gateId === command.payload.gateId);
        requireState(gate?.kind === 'replan' && gate.state === 'pending', 'invalid-transition', 'This change decision is no longer pending.');
        requireState(!run.attempts.some((attempt) => gate.taskIds.includes(attempt.taskId) && ['running', 'delivery-uncertain'].includes(attempt.state)),
          'invalid-transition', 'Reconcile affected execution before keeping the original baseline.');
        return {
          ...run, gates: run.gates.map((entry) => entry.gateId === gate.gateId
            ? { ...entry, state: 'rejected', resolvedAt: now, resolution: 'keep-original', detail: 'User explicitly retained the original frozen baseline.' } : entry),
          tasks: run.tasks.map((task) => {
            if (!gate.taskIds.includes(task.taskId) || run.gates.some((entry) => entry.gateId !== gate.gateId && entry.state === 'pending' && entry.taskIds.includes(task.taskId))) return task;
            const attempt = run.attempts.find((entry) => entry.attemptId === task.currentAttemptId);
            const accepted = attempt && run.reviews.some((review) => review.attemptId === attempt.attemptId && review.decision === 'approve');
            return { ...task, pauseReason: undefined, state: accepted ? 'completed' : attempt?.state === 'succeeded' ? 'awaiting-review' : attempt?.state === 'failed' ? 'failed' : 'waiting',
              ...(attempt?.state === 'interrupted' ? { nextAttemptKind: 'resume' } : {}) };
          }),
        };
      }
      case 'gate.resolve': {
        const gate = run.gates.find((entry) => entry.gateId === command.payload.gateId);
        requireState(gate?.state === 'pending', 'invalid-transition', 'The decision gate is no longer pending.');
        requireState(!run.attempts.some((attempt) => gate.taskIds.includes(attempt.taskId) && (attempt.state === 'running' || attempt.state === 'delivery-uncertain')),
          'invalid-transition', 'Reconcile affected attempts before resolving the gate.');
        // Approval authorizes a replacement preparation; it never mutates or restarts the frozen one.
        return {
          ...run,
          gates: run.gates.map((entry) => entry.gateId === gate.gateId
            ? { ...entry, state: command.payload.decision === 'approve' ? 'approved' : 'rejected', resolution: command.payload.decision === 'approve' ? 'replace' : 'decline', detail: command.payload.detail, resolvedAt: now } : entry),
          tasks: run.tasks.map((task) => gate.taskIds.includes(task.taskId) && command.payload.decision === 'approve'
            ? { ...task, state: 'stale' } : task),
        };
      }
      case 'evidence.record': {
        const input = command.payload;
        const attempt = run.attempts.find((entry) => entry.attemptId === input.attemptId);
        requireState(attempt && !run.evidence.some((entry) => entry.evidenceId === input.evidenceId), 'invalid-reference', 'The attempt is missing or evidence ID already exists.');
        requireState(canonical(input.baseline) === canonical(run.preparation.baseline) && sameArtifacts(input.artifacts, attempt.artifacts),
          'stale-review', 'Evidence must identify the exact attempt baseline and artifact revisions.');
        assertUniqueArtifacts(input.artifacts);
        const definition = run.preparation.tasks.find((entry) => entry.taskId === attempt.taskId)!;
        const validation = definition.validations.find((entry) => entry.validationId === input.validationId);
        requireState(validation && validation.environment === input.environment && validation.command === input.command
          && canonical([...validation.acceptanceIds].sort()) === canonical([...input.acceptanceIds].sort())
          && (input.status !== 'passed' || (validation.method === 'command' ? input.exitCode === 0 : input.exitCode === undefined)),
        'invalid-reference', 'Evidence must report the prepared validation, environment, acceptance criteria, and command result.');
        return { ...run, evidence: [...run.evidence, {
          evidenceId: input.evidenceId, attemptId: input.attemptId, kind: input.kind, status: input.status,
          validationId: input.validationId, acceptanceIds: input.acceptanceIds, environment: input.environment,
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }), logRefs: input.logRefs, captureRefs: input.captureRefs,
          baseline: input.baseline, artifacts: input.artifacts, summary: input.summary, recordedAt: now,
        }] };
      }
      case 'review.decide': {
        const input = command.payload;
        requireState(command.principal.kind !== 'runtime' || run.preparation.progressPolicy === 'autonomous',
          'user-required', 'This progression policy requires a user review decision.');
        const attempt = run.attempts.find((entry) => entry.attemptId === input.attemptId);
        const task = run.tasks.find((entry) => entry.currentAttemptId === input.attemptId);
        requireState(attempt?.state === 'succeeded' && task?.state === 'awaiting-review'
          && !run.reviews.some((entry) => entry.reviewId === input.reviewId), 'invalid-transition', 'Only the current successful attempt can be reviewed.');
        assertUniqueArtifacts(input.artifacts);
        const evidence = input.evidenceIds.map((id) => run.evidence.find((entry) => entry.evidenceId === id));
        const definition = run.preparation.tasks.find((entry) => entry.taskId === task.taskId)!;
        const reviewer = database.prepare(`SELECT s.project_id, s.kind, s.source, t.state FROM sessions s
          JOIN turns t ON t.session_id = s.id WHERE s.id = ? AND t.id = ?`).get(input.reviewerSessionId, input.reviewerTurnId);
        requireState(input.reviewerSessionId !== attempt.sessionId && reviewer?.project_id === projectId
          && reviewer.kind === 'agent' && reviewer.source === 'structured' && reviewer.state === 'completed',
        'invalid-reference', 'Independent review requires a completed turn in a different Agent session of this project.');
        requireState(new Set(input.evidenceIds).size === input.evidenceIds.length
          && canonical(input.baseline) === canonical(run.preparation.baseline)
          && sameArtifacts(input.artifacts, attempt.artifacts)
          && evidence.every((entry) => entry?.attemptId === attempt.attemptId
            && canonical(entry.baseline) === canonical(input.baseline) && sameArtifacts(entry.artifacts, input.artifacts)
            && (input.decision === 'reject' || entry.status === 'passed'))
          && (input.decision === 'reject' || definition.validations.every((validation) =>
            evidence.some((entry) => entry?.validationId === validation.validationId && entry.status === 'passed'))),
        'stale-review', 'Review requires exact baseline, artifacts, and passing evidence from this attempt.');
        run = withTask({ ...run, reviews: [...run.reviews, {
          reviewId: input.reviewId, attemptId: input.attemptId, baseline: input.baseline,
          reviewerSessionId: input.reviewerSessionId, reviewerTurnId: input.reviewerTurnId, decidedBy: command.principal.id,
          artifacts: input.artifacts, evidenceIds: input.evidenceIds, decision: input.decision, detail: input.detail, decidedAt: now,
        }] }, task.taskId, { state: input.decision === 'approve' ? 'completed' : 'failed' });
        return input.decision === 'reject' ? markRepairExhausted(run, task.taskId, now) : run;
      }
    }
  }
}
