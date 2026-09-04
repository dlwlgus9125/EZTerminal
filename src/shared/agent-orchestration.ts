import { z } from 'zod';

import { isSafeAgentPromptText, isSafeLocalBranch } from './agent-coordination';

export const AGENT_ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export const AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION = 1 as const;
export const MAX_ORCHESTRATION_RUNS = 128;
export const MAX_WORKERS_PER_RUN = 12;
export const MAX_CONCURRENT_WORKERS = 4;
export const MAX_ORCHESTRATION_DURATION_MS = 2 * 60 * 60_000;
export const MAX_WORKER_RESULT_BYTES = 8 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_SCOPE_SEGMENT = /^(?!\.\.?(?:\/|$))[^\0\\:*?"<>|]+$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

export type AgentProviderKind = 'builtin' | 'acp' | 'generic';

export interface AgentProviderRef {
  readonly providerId: string;
  readonly kind: AgentProviderKind;
  readonly displayName: string;
}

export type AgentProfileCapability =
  | 'lead'
  | 'worker'
  | 'read'
  | 'write'
  | 'verify'
  | 'permission-events'
  | 'parent-events';

export interface AgentProfile {
  readonly profileId: string;
  readonly providerId: string;
  readonly launcherId: string;
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode: string;
  readonly capabilities: readonly AgentProfileCapability[];
  readonly available: boolean;
  readonly revision: number;
}

export type CollaborationPermissionMode = 'ask' | 'safe-auto' | 'custom';

export interface CollaborationLimits {
  readonly maxConcurrent: number;
  readonly maxCreated: number;
  readonly maxDurationMs: number;
}

export interface CollaborationMergePolicy {
  readonly targetBranches: readonly string[];
  readonly allowPaths: readonly string[];
  readonly denyPaths: readonly string[];
  readonly requiredValidationIds: readonly string[];
  readonly maxChangedFiles: number;
  readonly maxChangedLines: number;
}

export interface CollaborationPolicy {
  readonly schemaVersion: typeof AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly permissionMode: CollaborationPermissionMode;
  readonly allowedWorkerProfileIds: readonly string[];
  readonly limits: CollaborationLimits;
  readonly mergePolicy: CollaborationMergePolicy;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface CollaborationPolicyInput {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly permissionMode: CollaborationPermissionMode;
  readonly allowedWorkerProfileIds: readonly string[];
  readonly limits?: Partial<CollaborationLimits>;
  readonly mergePolicy?: Partial<CollaborationMergePolicy>;
  readonly expectedRevision?: number;
}

export type CollaborationTaskMode = 'read-only' | 'write' | 'verify';
export type CollaborationTaskState =
  | 'queued'
  | 'starting'
  | 'working'
  | 'blocked'
  | 'awaiting-verification'
  | 'verifying'
  | 'awaiting-merge'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'stale';
export type CollaborationRunState = 'active' | 'needs-attention' | 'completed' | 'stopped' | 'interrupted';

export interface CollaborationWorker {
  readonly workerId: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly providerId: string;
  readonly sessionId?: string;
  readonly activityId?: string;
  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly archivedAt?: number;
}

export interface CollaborationTaskResult {
  readonly outcome: 'succeeded' | 'failed';
  readonly summary: string;
  readonly sourceHead?: string;
  readonly verifiesTaskId?: string;
  readonly verifiesHead?: string;
  readonly reportedAt: number;
}

export interface CollaborationTask {
  readonly taskId: string;
  readonly revision: number;
  readonly title: string;
  readonly brief: string;
  readonly mode: CollaborationTaskMode;
  readonly dependsOn: readonly string[];
  readonly writeScopes: readonly string[];
  readonly profileId: string;
  readonly verifiesTaskId?: string;
  readonly state: CollaborationTaskState;
  readonly worker?: CollaborationWorker;
  readonly result?: CollaborationTaskResult;
  readonly error?: string;
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollaborationRun {
  readonly schemaVersion: typeof AGENT_ORCHESTRATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly leadSessionId: string;
  readonly leadActivityId: string;
  readonly policyRevision: number;
  readonly state: CollaborationRunState;
  readonly tasks: readonly CollaborationTask[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly finishedAt?: number;
}

export type CollaborationEventKind =
  | 'worker-started'
  | 'worker-blocked'
  | 'worker-completed'
  | 'worker-failed'
  | 'worker-canceled'
  | 'merge-ready';

export interface CollaborationEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly kind: CollaborationEventKind;
  readonly summary: string;
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export interface LegacyTeamMigrationStatus {
  readonly required: boolean;
  readonly catalogItemCount: number;
  readonly runCount: number;
  readonly confirmedAt?: number;
}

export interface AgentOrchestrationSnapshot {
  readonly revision: number;
  readonly providers: readonly AgentProviderRef[];
  readonly profiles: readonly AgentProfile[];
  readonly policies: readonly CollaborationPolicy[];
  readonly runs: readonly CollaborationRun[];
  readonly events: readonly CollaborationEvent[];
  readonly migration: LegacyTeamMigrationStatus;
}

export const EMPTY_AGENT_ORCHESTRATION_SNAPSHOT: AgentOrchestrationSnapshot = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
  profiles: Object.freeze([]),
  policies: Object.freeze([]),
  runs: Object.freeze([]),
  events: Object.freeze([]),
  migration: Object.freeze({ required: false, catalogItemCount: 0, runCount: 0 }),
});

export interface CreateWorkerInput {
  readonly title: string;
  readonly brief: string;
  readonly mode: CollaborationTaskMode;
  readonly dependsOn?: readonly string[];
  readonly writeScopes?: readonly string[];
  readonly profileId: string;
  readonly verifiesTaskId?: string;
}

export interface WorkerPromptInput {
  readonly taskId: string;
  readonly text: string;
}

export interface WorkerReportInput {
  readonly outcome: 'succeeded' | 'failed';
  readonly summary: string;
  readonly sourceHead?: string;
  readonly verifiesTaskId?: string;
  readonly verifiesHead?: string;
}

export type AgentOrchestrationMutationError =
  | 'invalid'
  | 'not-found'
  | 'stale'
  | 'conflict'
  | 'unavailable'
  | 'forbidden';

export type AgentOrchestrationMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentOrchestrationMutationError; readonly message: string };

export const DEFAULT_COLLABORATION_LIMITS: CollaborationLimits = Object.freeze({
  maxConcurrent: MAX_CONCURRENT_WORKERS,
  maxCreated: MAX_WORKERS_PER_RUN,
  maxDurationMs: MAX_ORCHESTRATION_DURATION_MS,
});

export const DEFAULT_COLLABORATION_MERGE_POLICY: CollaborationMergePolicy = Object.freeze({
  targetBranches: Object.freeze([]),
  allowPaths: Object.freeze([]),
  denyPaths: Object.freeze([
    '.env', '.env.', '.github/', '.githooks/', '.gitlab-ci', 'release/', 'scripts/release',
  ]),
  requiredValidationIds: Object.freeze([]),
  maxChangedFiles: 20,
  maxChangedLines: 1_000,
});

const SingleLine = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !hasControlCharacter(value),
  'control characters are not allowed',
);

const SafePrompt = z.string().refine(isSafeAgentPromptText, 'unsafe prompt');
const Id = z.string().regex(SAFE_ID);
const Scope = z.string().max(512).refine((value) => normalizeWriteScope(value) !== null, 'unsafe scope');
const DenyScope = z.string().max(512).refine(
  (value) => value === '.env.' || normalizeWriteScope(value) !== null,
  'unsafe deny scope',
);

export const CollaborationPolicySchema = z.strictObject({
  schemaVersion: z.literal(AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION),
  projectId: Id,
  enabled: z.boolean(),
  permissionMode: z.enum(['ask', 'safe-auto', 'custom']),
  allowedWorkerProfileIds: z.array(Id).max(64),
  limits: z.strictObject({
    maxConcurrent: z.number().int().min(1).max(MAX_CONCURRENT_WORKERS),
    maxCreated: z.number().int().min(1).max(MAX_WORKERS_PER_RUN),
    maxDurationMs: z.number().int().min(60_000).max(MAX_ORCHESTRATION_DURATION_MS),
  }),
  mergePolicy: z.strictObject({
    targetBranches: z.array(z.string().refine(isSafeLocalBranch)).max(16),
    allowPaths: z.array(Scope).max(64),
    denyPaths: z.array(DenyScope).max(64),
    requiredValidationIds: z.array(Id).max(16),
    maxChangedFiles: z.number().int().min(1).max(1_000),
    maxChangedLines: z.number().int().min(1).max(1_000_000),
  }),
  revision: z.number().int().positive(),
  updatedAt: z.number().finite().nonnegative(),
});

const WorkerSchema = z.strictObject({
  workerId: Id,
  taskId: Id,
  profileId: Id,
  providerId: Id,
  sessionId: Id.optional(),
  activityId: Id.optional(),
  worktreeId: Id.optional(),
  worktreePath: z.string().min(1).max(8_192).optional(),
  branch: z.string().refine(isSafeLocalBranch).optional(),
  startedAt: z.number().finite().nonnegative().optional(),
  finishedAt: z.number().finite().nonnegative().optional(),
  archivedAt: z.number().finite().nonnegative().optional(),
});

const TaskResultSchema = z.strictObject({
  outcome: z.enum(['succeeded', 'failed']),
  summary: z.string().trim().min(1).max(MAX_WORKER_RESULT_BYTES),
  sourceHead: z.string().regex(/^[0-9a-f]{40,64}$/u).optional(),
  verifiesTaskId: Id.optional(),
  verifiesHead: z.string().regex(/^[0-9a-f]{40,64}$/u).optional(),
  reportedAt: z.number().finite().nonnegative(),
});

export const CollaborationTaskSchema = z.strictObject({
  taskId: Id,
  revision: z.number().int().positive(),
  title: SingleLine(160),
  brief: SafePrompt,
  mode: z.enum(['read-only', 'write', 'verify']),
  dependsOn: z.array(Id).max(MAX_WORKERS_PER_RUN),
  writeScopes: z.array(Scope).max(64),
  profileId: Id,
  verifiesTaskId: Id.optional(),
  state: z.enum([
    'queued', 'starting', 'working', 'blocked', 'awaiting-verification', 'verifying',
    'awaiting-merge', 'completed', 'failed', 'canceled', 'stale',
  ]),
  worker: WorkerSchema.optional(),
  result: TaskResultSchema.optional(),
  error: z.string().trim().min(1).max(500).optional(),
  archivedAt: z.number().finite().nonnegative().optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

export const CollaborationRunSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_ORCHESTRATION_SCHEMA_VERSION),
  runId: Id,
  revision: z.number().int().positive(),
  projectId: Id,
  leadSessionId: Id,
  leadActivityId: Id,
  policyRevision: z.number().int().positive(),
  state: z.enum(['active', 'needs-attention', 'completed', 'stopped', 'interrupted']),
  tasks: z.array(CollaborationTaskSchema).max(MAX_WORKERS_PER_RUN),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative(),
  finishedAt: z.number().finite().nonnegative().optional(),
});

export const CollaborationEventSchema = z.strictObject({
  eventId: Id,
  runId: Id,
  taskId: Id,
  taskRevision: z.number().int().positive(),
  kind: z.enum([
    'worker-started', 'worker-blocked', 'worker-completed', 'worker-failed',
    'worker-canceled', 'merge-ready',
  ]),
  summary: z.string().trim().min(1).max(MAX_WORKER_RESULT_BYTES),
  createdAt: z.number().finite().nonnegative(),
  deliveredAt: z.number().finite().nonnegative().optional(),
});

export const AgentProviderRefSchema = z.strictObject({
  providerId: Id,
  kind: z.enum(['builtin', 'acp', 'generic']),
  displayName: SingleLine(120),
});

export const AgentProfileSchema = z.strictObject({
  profileId: Id,
  providerId: Id,
  launcherId: Id,
  name: SingleLine(120),
  description: z.string().trim().min(1).max(500),
  model: SingleLine(128).optional(),
  effort: SingleLine(64).optional(),
  permissionMode: SingleLine(64),
  capabilities: z.array(z.enum([
    'lead', 'worker', 'read', 'write', 'verify', 'permission-events', 'parent-events',
  ])).max(7),
  available: z.boolean(),
  revision: z.number().int().positive(),
});

export const LegacyTeamMigrationStatusSchema = z.strictObject({
  required: z.boolean(),
  catalogItemCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  confirmedAt: z.number().finite().nonnegative().optional(),
});

export const AgentOrchestrationSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  providers: z.array(AgentProviderRefSchema).max(128),
  profiles: z.array(AgentProfileSchema).max(128),
  policies: z.array(CollaborationPolicySchema).max(1_024),
  runs: z.array(CollaborationRunSchema).max(MAX_ORCHESTRATION_RUNS),
  events: z.array(CollaborationEventSchema).max(1_024),
  migration: LegacyTeamMigrationStatusSchema,
});

export function normalizeWriteScope(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
  if (!trimmed) return null;
  if (trimmed === '.') return '.';
  if (trimmed.startsWith('/') || /^[A-Za-z]:/u.test(trimmed)) return null;
  const directory = trimmed.endsWith('/');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => (
    !SAFE_SCOPE_SEGMENT.test(part)
    || hasControlCharacter(part)
    || part.endsWith('.')
    || part.endsWith(' ')
    || WINDOWS_DEVICE_NAME.test(part)
  ))) return null;
  return `${parts.join('/')}${directory ? '/' : ''}`;
}

function scopeKey(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\/$/u, '');
}

export function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const leftScope of left) {
    const a = scopeKey(leftScope);
    for (const rightScope of right) {
      const b = scopeKey(rightScope);
      if (a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

/** Activities launched as orchestration workers are managed through the Lead
 * surface. They must not reappear as directly-chatable agents elsewhere. */
export function orchestrationWorkerActivityIds(
  snapshot: Pick<AgentOrchestrationSnapshot, 'runs'>,
): ReadonlySet<string> {
  return new Set(snapshot.runs.flatMap((run) => run.tasks.flatMap((task) => (
    task.worker?.activityId ? [task.worker.activityId] : []
  ))));
}

export function isTerminalCollaborationTask(state: CollaborationTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'stale';
}

export function isTerminalCollaborationRun(state: CollaborationRunState): boolean {
  return state === 'completed' || state === 'stopped' || state === 'interrupted';
}

export function composeWorkerBrief(
  run: CollaborationRun,
  task: CollaborationTask,
  dependencyResults: readonly CollaborationTaskResult[],
): string {
  const scope = task.mode === 'write'
    ? `You may write only within: ${task.writeScopes.join(', ')}.`
    : 'Treat the workspace as read-only. Do not modify project files.';
  const dependencies = dependencyResults.length > 0
    ? `\n\nCompleted dependency results:\n${dependencyResults.map((result) => `- ${result.summary}`).join('\n')}`
    : '';
  const reportCommand = task.mode === 'verify'
    ? `ezterminal-agent worker report ${task.taskId} --outcome succeeded --verifies-task ${task.verifiesTaskId ?? '<writer-task-id>'} --verifies-head <exact-source-head> --stdin`
    : `ezterminal-agent worker report ${task.taskId} --outcome succeeded${task.mode === 'write' ? ' --source-head <git-head>' : ''} --stdin`;
  const report = [
    'When finished, report through the EZTerminal worker command; do not create subagents.',
    'Pipe one UTF-8 summary to:',
    reportCommand,
    'Use --outcome failed when the assignment cannot be completed.',
  ].join(' ');
  return [
    `You are a depth-1 worker managed by Lead run ${run.runId}.`,
    `Assignment: ${task.title}`,
    task.brief,
    scope,
    report,
  ].join('\n\n') + dependencies;
}
