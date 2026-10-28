import { z } from 'zod';
import { PlanningExecutionEnvironmentSchema } from './planning';
import { WorkflowFrozenSchema, WorkflowNodeSchema, WorkflowRuntimeSchema, validateWorkflowGraph, type WorkflowGraph, type WorkflowNode, type WorkflowRuntime } from './workflow-graph';

/** Planning execution shares the daemon database, but has a project-local revision. */
export const PLANNING_EXECUTION_VERSION = 1 as const;
export const DEFAULT_REPAIR_RETRY_LIMIT = 2;

const id = z.string().trim().min(1).max(160);
const revision = z.number().int().nonnegative();
const text = z.string().min(1).max(65_536);
export const ExecutionBaselineSchema = z.object({
  baselineId: id,
  revision,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type ExecutionBaseline = z.infer<typeof ExecutionBaselineSchema>;

export const ExecutionArtifactSchema = z.object({ artifactId: id, revision }).strict();
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

export const ExecutionProfileSchema = z.object({
  profileId: id,
  revision,
  role: id,
  providerId: id,
  model: z.string().max(256).optional(),
  prompt: text,
  permissionPreset: z.enum(['plan', 'standard', 'full-access']),
  capabilities: z.array(id).max(128),
  reasoningEffort: z.string().max(128).optional(),
}).strict();
export type ExecutionProfileSnapshot = z.infer<typeof ExecutionProfileSchema>;

export const PreparedExecutionTaskSchema = z.object({
  taskId: id,
  sourceTaskId: id.optional(),
  candidateGroupId: id.optional(),
  allowedPaths: z.array(z.string().min(1).max(1_024)).max(200).optional(),
  executionEnvironment: PlanningExecutionEnvironmentSchema.optional(),
  taskRevision: revision,
  stage: z.enum(['planning', 'design', 'implementation', 'review', 'integration']),
  title: z.string().min(1).max(512),
  brief: text,
  dependsOn: z.array(id).max(128),
  profile: ExecutionProfileSchema,
  retryLimit: z.number().int().min(0).max(20).default(DEFAULT_REPAIR_RETRY_LIMIT),
  acceptance: z.array(z.object({ acceptanceId: id, description: text }).strict()).min(1).max(200),
  validations: z.array(z.object({
    validationId: id,
    acceptanceIds: z.array(id).min(1).max(200),
    method: z.enum(['command', 'inspection', 'device']),
    environment: z.string().min(1).max(1_000),
    command: z.string().max(4_000).optional(),
  }).strict()).min(1).max(200),
}).strict();
export type PreparedExecutionTask = z.infer<typeof PreparedExecutionTaskSchema>;

/**
 * A prepared workflow task carries exactly its stage's settings: provider, model, reasoning effort,
 * permission, role, writable paths and completion criteria (in order).
 */
export function taskMatchesStage(task: PreparedExecutionTask, node: WorkflowNode): boolean {
  const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
  return task.profile.providerId === node.providerId && task.profile.model === node.model
    && (task.profile.reasoningEffort ?? null) === (node.reasoningEffort ?? null)
    && task.profile.permissionPreset === node.permissionPreset && task.stage === node.role
    && same(task.allowedPaths ?? [], node.allowedPaths) && same(task.acceptance.map((entry) => entry.description), node.acceptance);
}

/**
 * The stage settings a person may change after a run was prepared, up to the moment that stage
 * starts (remote protocol v17). Everything else about a stage is its structure and waits for the
 * next run: operation, role, inputs, condition, join policy and the connections around it.
 */
export const STAGE_BINDABLE_FIELDS = ['title', 'instructions', 'document', 'providerId', 'model', 'reasoningEffort',
  'permissionPreset', 'acceptance', 'allowedPaths', 'retryLimit'] as const;
export type StageBindableField = typeof STAGE_BINDABLE_FIELDS[number];
const STAGE_STRUCTURE_FIELDS = ['operation', 'role', 'inputs', 'condition', 'joinPolicy'] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Bindable settings that differ between two versions of the same stage. */
export function changedStageSettings(before: WorkflowNode, after: WorkflowNode): StageBindableField[] {
  return STAGE_BINDABLE_FIELDS.filter((field) => stable(before[field]) !== stable(after[field]));
}

/** True when the stage's structure differs (those edits always wait for the next run). */
export function stageStructureChanged(before: WorkflowNode, after: WorkflowNode): boolean {
  return STAGE_STRUCTURE_FIELDS.some((field) => stable(before[field]) !== stable(after[field]));
}

/** `frozen` with only the bindable settings of `current`: the stage as it would run now. */
export function withStageSettings(frozen: WorkflowNode, current: WorkflowNode): WorkflowNode {
  const next: Record<string, unknown> = { ...frozen };
  for (const field of STAGE_BINDABLE_FIELDS) {
    if (current[field] === undefined) delete next[field];
    else next[field] = structuredClone(current[field]);
  }
  return next as WorkflowNode;
}

/**
 * What happened to a not-yet-started stage's settings when it was about to start: `applied` binds
 * the rebuilt task (what was actually sent) and its stage; `kept` records why the prepared
 * settings stayed. Stored in run state; the prepared run itself never changes.
 */
export const StageBindingSchema = z.object({
  outcome: z.enum(['applied', 'kept']),
  boundAt: z.string().datetime(),
  sourceRevision: revision.optional(),
  reason: z.enum(['unchanged', 'structure-changed', 'invalid', 'unreadable', 'missing']).optional(),
  detail: z.string().max(2_000).optional(),
  changed: z.array(z.enum(STAGE_BINDABLE_FIELDS)).max(STAGE_BINDABLE_FIELDS.length).optional(),
  /** Rebuilt because a stage it reads documents from was rebound for this run. */
  inputsChanged: z.literal(true).optional(),
  task: PreparedExecutionTaskSchema.optional(),
  node: WorkflowNodeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'applied' && (!value.task || !value.node || !value.changed || (!value.changed.length && !value.inputsChanged))) context.addIssue({ code: 'custom', message: 'An applied binding carries its task, stage and what changed.' });
  if (value.outcome === 'kept' && (value.task || value.node || !value.reason)) context.addIssue({ code: 'custom', message: 'A kept binding carries only its reason.' });
});
export type StageBinding = z.infer<typeof StageBindingSchema>;

/**
 * The run as it actually executes: applied stage bindings replace their prepared task and their
 * stage in the frozen graph. The prepared run (and its fingerprint) stay as stored.
 */
export function effectiveRun<T extends ExecutionRun>(run: T): T {
  const bindings = run.stageBindings;
  if (!bindings || !Object.values(bindings).some((binding) => binding.outcome === 'applied')) return run;
  const applied = (taskId: string) => { const binding = bindings[taskId]; return binding?.outcome === 'applied' ? binding : undefined; };
  const workflow = run.preparation.workflow;
  return { ...run, preparation: { ...run.preparation,
    tasks: run.preparation.tasks.map((task) => applied(task.taskId)?.task ?? task),
    ...(workflow ? { workflow: { ...workflow, graph: { ...workflow.graph, nodes: workflow.graph.nodes.map((node) => applied(node.id)?.node ?? node) } } } : {}),
  } };
}

/**
 * Where an edit to this stage lands for this run: `this-run` before the stage started, `locked`
 * while it works, `next-run` once it started or finished (or when the run is not going).
 */
export function stageEditScope(run: ExecutionRun | undefined, nodeId: string): 'this-run' | 'next-run' | 'locked' {
  if (!run?.preparation.workflow || !run.startedAt || run.state === 'completed' || run.state === 'cancelled' || run.cancelRequested) return 'next-run';
  const node = run.preparation.workflow.graph.nodes.find((entry) => entry.id === nodeId);
  const task = run.tasks.find((entry) => entry.taskId === nodeId);
  if (!node || node.operation !== 'agent' || !task) return 'next-run';
  if (stageWorking(run, nodeId)) return 'locked';
  if (run.stageBindings?.[nodeId] || run.attempts.some((attempt) => attempt.taskId === nodeId)) return 'next-run';
  // Not sent yet: waiting for its inputs, about to be sent, or held (paused) before its first send.
  return ['waiting', 'ready', 'paused'].includes(task.state) ? 'this-run' : 'next-run';
}

/**
 * A stage is working from the moment its first dispatch was decided (its binding is recorded) until
 * it finishes, and whenever one of its attempts runs. Its settings are locked meanwhile.
 */
export function stageWorking(run: ExecutionRun, nodeId: string): boolean {
  const task = run.tasks.find((entry) => entry.taskId === nodeId);
  if (!task) return false;
  if (['running', 'reconciling', 'awaiting-review'].includes(task.state)) return true;
  return Boolean(run.stageBindings?.[nodeId]) && !['completed', 'failed', 'cancelled', 'stale'].includes(task.state);
}

/** True when a stage this one reads documents from was rebound for this run with a new title or document. */
export function stageInputsRebound(run: ExecutionRun, nodeId: string): boolean {
  const node = run.preparation.workflow?.graph.nodes.find((entry) => entry.id === nodeId);
  return Boolean(node?.inputs.some((input) => {
    const binding = input.kind === 'document' ? run.stageBindings?.[input.nodeId] : undefined;
    return binding?.outcome === 'applied' && binding.changed?.some((field) => field === 'document' || field === 'title');
  }));
}

/** Issues of `node` once spliced into `graph`, for that stage only. */
export function boundStageIssues(graph: WorkflowGraph, node: WorkflowNode): readonly string[] {
  const spliced = { ...graph, nodes: graph.nodes.map((entry) => entry.id === node.id ? node : entry) };
  return validateWorkflowGraph(spliced, true).filter((issue) => issue.nodeId === node.id).map((issue) => issue.message);
}

export const ExecutionPreparationSchema = z.object({
  workflow: WorkflowFrozenSchema.optional(),
  subprojectId: id.optional(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  baseline: ExecutionBaselineSchema,
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  reviewer: ExecutionProfileSchema.optional(),
  externalDependencies: z.array(z.object({
    taskId: id, runId: id, attemptId: id, artifacts: z.array(ExecutionArtifactSchema).min(1).max(256),
  }).strict()).max(128).optional(),
  artifacts: z.array(ExecutionArtifactSchema).max(256),
  teamMode: z.enum(['single', 'division', 'candidates', 'independent-review']),
  progressPolicy: z.enum(['manual', 'checkpoint', 'autonomous']),
  tasks: z.array(PreparedExecutionTaskSchema).min(1).max(128),
  supersedesRunId: id.optional(),
  /**
   * Frozen at preparation from the subproject's 자동 승인: `auto` lets the host resolve
   * approval stages and integration for this run (as `auto-approval`); absent means the person.
   */
  approvalPolicy: z.enum(['user', 'auto']).optional(),
  /** The conversation whose agent prepared this run, when an agent did. */
  startedBy: z.object({ sessionId: id }).strict().optional(),
}).strict();
export type ExecutionPreparation = z.infer<typeof ExecutionPreparationSchema>;

/** The host's principal id when a run's frozen policy lets it approve and integrate. */
export const PLANNING_AUTO_APPROVAL_PRINCIPAL = 'auto-approval';
/** The host's principal id that cancels a run its own launch prepared but could not start. */
export const PLANNING_LAUNCH_PRINCIPAL = 'workflow-launch';
/** The host's repeat schedule (I2-6): it may prepare and start a flow's run, nothing else. */
export const PLANNING_REPEAT_PRINCIPAL = 'workflow-schedule';
/** What an agent may do to a run; approvals, reviews and integration stay with the person. */
export const PLANNING_AGENT_RUN_COMMANDS = ['run.prepare', 'run.start', 'run.pause', 'run.continue', 'run.cancel'] as const;
export type RunDefinition = ExecutionPreparation;

export interface EnvironmentLease {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly processes: readonly { readonly pid: number; readonly startedAt: string }[];
  readonly ports: readonly number[];
  readonly previewOrigin?: string;
  readonly namespace: string;
  readonly temporaryPaths: readonly string[];
  readonly status: 'reserved' | 'active' | 'released' | 'orphaned';
}

export type ExecutionTaskState = 'waiting' | 'ready' | 'running' | 'awaiting-review'
  | 'completed' | 'failed' | 'cancelled' | 'paused' | 'reconciling' | 'stale';
export type ExecutionAttemptState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'delivery-uncertain';

export interface ExecutionAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly dispatchId: string;
  readonly workspaceId: string;
  readonly number: number;
  readonly reason: 'initial' | 'repair' | 'resume';
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: ExecutionAttemptState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly reconciliation?: string;
  readonly artifacts: readonly ExecutionArtifact[];
  readonly requestedSettings: Readonly<{ providerId: string; model?: string; reasoningEffort?: string; permissionPreset: string }>;
  readonly effectiveSettings: Readonly<{ providerId: string; model?: string; permissionPreset: string }>;
}

export interface ExecutionTask {
  readonly taskId: string;
  readonly state: ExecutionTaskState;
  readonly retriesUsed: number;
  readonly extraRetriesGranted?: number;
  readonly currentAttemptId?: string;
  readonly pauseReason?: string;
  readonly nextAttemptKind?: 'repair' | 'resume';
  readonly cancelRequested?: boolean;
}

export interface ReviewEvidence {
  readonly evidenceId: string;
  readonly attemptId: string;
  readonly validationId: string;
  readonly acceptanceIds: readonly string[];
  readonly environment: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly logRefs: readonly string[];
  readonly captureRefs: readonly string[];
  readonly kind: 'test' | 'diff' | 'preview' | 'artifact';
  readonly status: 'passed' | 'failed' | 'not-run';
  readonly baseline: ExecutionBaseline;
  readonly artifacts: readonly ExecutionArtifact[];
  readonly summary: string;
  readonly recordedAt: string;
}

export interface ExecutionReview {
  readonly reviewId: string;
  readonly attemptId: string;
  readonly reviewerSessionId: string;
  readonly reviewerTurnId: string;
  readonly decidedBy: string;
  readonly baseline: ExecutionBaseline;
  readonly artifacts: readonly ExecutionArtifact[];
  readonly evidenceIds: readonly string[];
  readonly decision: 'approve' | 'reject';
  readonly detail: string;
  readonly decidedAt: string;
}

export interface DecisionGate {
  readonly gateId: string;
  readonly kind: 'replan' | 'repair-exhausted';
  readonly taskIds: readonly string[];
  readonly state: 'pending' | 'approved' | 'rejected';
  readonly detail: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly sourcePlanningRevision?: number;
  readonly resolution?: 'keep-original' | 'replace' | 'decline';
}

export interface ExecutionRun {
  readonly runId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: 'prepared' | 'running' | 'paused' | 'reconciling' | 'awaiting-review' | 'completed' | 'cancelled';
  readonly cancelRequested?: boolean;
  readonly integrationAuthorized?: { readonly by: string; readonly at: string };
  /** Immutable after prepare, including retries, prompts, models, and baseline. */
  readonly preparation: ExecutionPreparation;
  readonly preparationFingerprint: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly dispatchPaused?: boolean;
  readonly selectedCandidates?: Readonly<Record<string, string>>;
  readonly tasks: readonly ExecutionTask[];
  readonly attempts: readonly ExecutionAttempt[];
  readonly evidence: readonly ReviewEvidence[];
  readonly reviews: readonly ExecutionReview[];
  readonly gates: readonly DecisionGate[];
  readonly workflowRuntime?: WorkflowRuntime;
  /** Not-yet-started stages whose settings were (re)bound when they were about to start (v17). */
  readonly stageBindings?: Readonly<Record<string, StageBinding>>;
}

export interface PlanningExecutionSnapshot {
  readonly version: typeof PLANNING_EXECUTION_VERSION;
  readonly projectId: string;
  readonly revision: number;
  readonly runs: readonly ExecutionRun[];
}

const envelope = {
  commandId: id,
  projectId: id,
  expectedRevision: revision,
  principal: z.object({ kind: z.enum(['desktop', 'android', 'runtime', 'agent']), id }).strict(),
};
const run = { runId: id };
const attempt = { ...run, attemptId: id };
export const PlanningExecutionCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('workflow.approve'), payload: z.object({ ...run, activationId: id, decision: z.enum(['approve', 'reject']), comment: z.string().trim().min(1).max(20_000).optional() }).strict() }).strict(),
  /** v18, host only: an AI stage with skipWhenUnchanged runs no model when the checks before it gave last run's result. */
  z.object({ ...envelope, type: z.literal('workflow.skip'), payload: z.object({ ...run, activationId: id, reason: z.string().min(1).max(2_000) }).strict() }).strict(),
  /** v18: a person answers an answer stage. */
  z.object({ ...envelope, type: z.literal('workflow.answer'), payload: z.object({ ...run, activationId: id, answer: z.string().trim().min(1).max(20_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.prepare'), payload: z.object({ ...run, preparation: ExecutionPreparationSchema }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.start'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.pause'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.continue'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.cancel'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.cancel-reconcile'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow.integrate'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('task.cancel'), payload: z.object({ ...run, taskId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('task.block'), payload: z.object({ ...run, taskId: id, reason: text }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('task.bind'), payload: z.object({ ...run, taskId: id, binding: StageBindingSchema }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('candidate.select'), payload: z.object({ ...run, taskId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.start'), payload: z.object({ ...attempt, taskId: id, dispatchId: id, sessionId: id, turnId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.finish'), payload: z.object({ ...attempt, outcome: z.enum(['succeeded', 'failed', 'interrupted', 'delivery-uncertain']), summary: text, artifacts: z.array(ExecutionArtifactSchema).max(256) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.retry'), payload: z.object({ ...run, taskId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.extend'), payload: z.object({ ...run, taskId: id, reason: text }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.resume'), payload: z.object({ ...run, taskId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('attempt.reconcile'), payload: z.object({ ...attempt, outcome: z.enum(['running', 'succeeded', 'failed', 'not-applied']), proof: text, artifacts: z.array(ExecutionArtifactSchema).max(256) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.pause-impact'), payload: z.object({ ...run, gateId: id, taskIds: z.array(id).min(1).max(128), reason: text, sourcePlanningRevision: revision.optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('gate.resolve'), payload: z.object({ ...run, gateId: id, decision: z.enum(['approve', 'reject']), detail: text }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('gate.keep-original'), payload: z.object({ ...run, gateId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('evidence.record'), payload: z.object({ ...attempt, evidenceId: id, validationId: id, acceptanceIds: z.array(id).min(1).max(200), environment: z.string().min(1).max(1_000), command: z.string().max(4_000).optional(), exitCode: z.number().int().optional(), logRefs: z.array(id).max(200).default([]), captureRefs: z.array(id).max(200).default([]), kind: z.enum(['test', 'diff', 'preview', 'artifact']), status: z.enum(['passed', 'failed', 'not-run']), baseline: ExecutionBaselineSchema, artifacts: z.array(ExecutionArtifactSchema).max(256), summary: text }).strict() }).strict(),
  /**
   * v18, host only: a stage with review off is accepted by its checks alone (`checks`), or — with no check — passed
   * on to the person, who accepts it at the approval right after (`person-gate`; 자동 승인 never answers that approval).
   */
  z.object({ ...envelope, type: z.literal('review.checks'), payload: z.object({ ...attempt, reviewId: id, basis: z.enum(['checks', 'person-gate']), evidenceIds: z.array(id).max(256), decision: z.enum(['approve', 'reject']), detail: text }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('review.decide'), payload: z.object({ ...attempt, reviewId: id, reviewerSessionId: id, reviewerTurnId: id, baseline: ExecutionBaselineSchema, artifacts: z.array(ExecutionArtifactSchema).max(256), evidenceIds: z.array(id).min(1).max(256), decision: z.enum(['approve', 'reject']), detail: text }).strict() }).strict(),
]);
export type PlanningExecutionCommand = z.infer<typeof PlanningExecutionCommandSchema>;

export type PlanningExecutionError = 'invalid-command' | 'revision-conflict' | 'command-conflict'
  | 'not-found' | 'invalid-transition' | 'invalid-reference' | 'retry-limit' | 'stale-review'
  | 'runtime-required' | 'user-required' | 'active-run';
export type PlanningExecutionReceipt = {
  readonly ok: true;
  readonly commandId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly runId: string;
  readonly replayed?: boolean;
} | {
  readonly ok: false;
  readonly commandId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly error: PlanningExecutionError;
  readonly message: string;
  readonly replayed?: boolean;
};

/** Full validation at remote-client boundaries; no executable content is evaluated. */
export const PlanningExecutionSnapshotSchema = z.object({
  version: z.literal(PLANNING_EXECUTION_VERSION), projectId: id, revision,
  runs: z.array(z.object({
    runId: id, projectId: id, revision,
    state: z.enum(['prepared', 'running', 'paused', 'reconciling', 'awaiting-review', 'completed', 'cancelled']),
    cancelRequested: z.boolean().optional(), integrationAuthorized: z.object({ by: id, at: z.string().datetime() }).strict().optional(),
    preparation: ExecutionPreparationSchema, preparationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime(), startedAt: z.string().datetime().optional(), updatedAt: z.string().datetime(),
    dispatchPaused: z.boolean().optional(), selectedCandidates: z.record(id, id).optional(),
    workflowRuntime: WorkflowRuntimeSchema.optional(),
    stageBindings: z.record(id, StageBindingSchema).optional(),
    tasks: z.array(z.object({
      taskId: id, state: z.enum(['waiting', 'ready', 'running', 'awaiting-review', 'completed', 'failed', 'cancelled', 'paused', 'reconciling', 'stale']),
      retriesUsed: revision, currentAttemptId: id.optional(), pauseReason: z.string().optional(),
      extraRetriesGranted: revision.optional(),
      nextAttemptKind: z.enum(['repair', 'resume']).optional(), cancelRequested: z.boolean().optional(),
    }).strict()),
    attempts: z.array(z.object({
      attemptId: id, taskId: id, taskRevision: revision, dispatchId: id, workspaceId: id, number: z.number().int().positive(),
      reason: z.enum(['initial', 'repair', 'resume']), sessionId: id, turnId: id,
      state: z.enum(['running', 'succeeded', 'failed', 'interrupted', 'delivery-uncertain']), startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(), summary: z.string().optional(), reconciliation: z.string().optional(),
      artifacts: z.array(ExecutionArtifactSchema),
      requestedSettings: z.object({ providerId: id, model: z.string().optional(), reasoningEffort: z.string().optional(), permissionPreset: z.string() }).strict(),
      effectiveSettings: z.object({ providerId: id, model: z.string().optional(), permissionPreset: z.string() }).strict(),
    }).strict()),
    evidence: z.array(z.object({
      evidenceId: id, attemptId: id, validationId: id, acceptanceIds: z.array(id), environment: z.string(),
      command: z.string().optional(), exitCode: z.number().int().optional(), logRefs: z.array(id), captureRefs: z.array(id),
      kind: z.enum(['test', 'diff', 'preview', 'artifact']), status: z.enum(['passed', 'failed', 'not-run']),
      baseline: ExecutionBaselineSchema, artifacts: z.array(ExecutionArtifactSchema), summary: z.string(), recordedAt: z.string().datetime(),
    }).strict()),
    reviews: z.array(z.object({
      reviewId: id, attemptId: id, reviewerSessionId: id, reviewerTurnId: id, decidedBy: z.string(),
      baseline: ExecutionBaselineSchema, artifacts: z.array(ExecutionArtifactSchema), evidenceIds: z.array(id),
      decision: z.enum(['approve', 'reject']), detail: z.string(), decidedAt: z.string().datetime(),
    }).strict()),
    gates: z.array(z.object({
      gateId: id, kind: z.enum(['replan', 'repair-exhausted']), taskIds: z.array(id), state: z.enum(['pending', 'approved', 'rejected']),
      detail: z.string(), createdAt: z.string().datetime(), resolvedAt: z.string().datetime().optional(),
      resolvedBy: z.string().optional(),
      sourcePlanningRevision: revision.optional(), resolution: z.enum(['keep-original', 'replace', 'decline']).optional(),
    }).strict()),
  }).strict()),
}).strict();

/** The subproject a run belongs to: a flow run, or a planning run addressed to a subproject. */
export function runSubprojectId(run: Pick<ExecutionRun, 'preparation'>): string | undefined {
  return run.preparation.workflow?.subprojectId ?? run.preparation.subprojectId;
}

/** A started run that has not finished. Paused, reconciling and cancelling runs are still going. */
export function runUnfinished(run: Pick<ExecutionRun, 'startedAt' | 'state'>): boolean {
  return Boolean(run.startedAt) && run.state !== 'completed' && run.state !== 'cancelled';
}

/** The run that keeps a subproject from starting another one (one unfinished run per flow). */
export function blockingRunOf<T extends Pick<ExecutionRun, 'runId' | 'preparation' | 'startedAt' | 'state'>>(runs: readonly T[], subprojectId: string, exceptRunId?: string): T | undefined {
  return runs.find((run) => run.runId !== exceptRunId && runSubprojectId(run) === subprojectId && runUnfinished(run));
}
