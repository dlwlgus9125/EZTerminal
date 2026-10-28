// FROZEN COPY of src/shared/workflow.ts at c74ac76 (remote protocol v17). Do not edit:
// tests use it to prove what an already-installed v17 reader accepts.
import { z } from 'zod';
import { PlanningExecutionSnapshotSchema, type ExecutionRun } from './planning-execution';
import { WorkflowGraphSchema, WorkflowIdSchema, WorkflowNodeSchema } from './workflow-graph';
import { WorkflowConversationContextSchema } from './workflow-conversation';
export * from './workflow-graph';
export { WORKFLOW_PRESETS as workflowPresets } from './workflow-graph';
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const LEGACY_SUBPROJECT_ID = 'legacy-default';
const id = WorkflowIdSchema;
const revision = z.number().int().nonnegative();
const actor = z.object({ kind: z.enum(['user', 'ai']), id, sessionId: id.optional() }).strict();
export type WorkflowActor = z.infer<typeof actor>;
export const WorkflowHistorySchema = z.object({
  id, commandId: id, revision, createdAt: z.string().datetime(), actor, summary: z.string().max(1_000),
  before: WorkflowGraphSchema, after: WorkflowGraphSchema, undoOf: id.optional(),
}).strict();
/** The review AI a flow is run with (실행 설정), saved on the subproject so 다시 실행 needs no dialog. */
export const WorkflowReviewerSchema = z.object({ providerId: id, model: z.string().min(1).max(256) }).strict();
export const WorkflowRunSettingsSchema = z.object({ reviewer: WorkflowReviewerSchema }).strict();
export type WorkflowRunSettings = z.infer<typeof WorkflowRunSettingsSchema>;
/**
 * 반복 (protocol v17): run the saved flow every day, or every week on one weekday, at a local time in an IANA zone.
 * Off keeps the settings. Turning it on needs a saved review AI; a copy or an import starts with it off.
 */
export const WorkflowRepeatSchema = z.object({
  cadence: z.enum(['daily', 'weekly']),
  /** 0 = Sunday ... 6 = Saturday; weekly only. */
  weekday: z.number().int().min(0).max(6).optional(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: z.string().min(1).max(64),
  enabled: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.cadence === 'weekly') !== (value.weekday !== undefined)) context.addIssue({ code: 'custom', path: ['weekday'], message: 'A weekly repeat names its weekday, and only a weekly one.' });
});
export type WorkflowRepeat = z.infer<typeof WorkflowRepeatSchema>;
/** What the host's repeat schedule did and will do for one subproject (host-computed, protocol v17). */
export const WorkflowRepeatStatusSchema = z.object({
  /** The next occurrence it will run; absent while it cannot (see `blocked`) or is off. */
  nextAt: z.string().datetime().optional(),
  /** `unconfirmed`: on in the flow file, but the flow came or changed outside this host (with the project folder). */
  blocked: z.enum(['automation-off', 'missing-reviewer', 'unreadable', 'unconfirmed']).optional(),
  last: z.object({
    key: z.string().min(1).max(32), occurrenceAt: z.string().datetime(),
    state: z.enum(['claimed', 'started', 'skipped-running', 'missed', 'failed']), at: z.string().datetime(),
    runId: id.optional(), detail: z.string().max(500).optional(), missedCount: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type WorkflowRepeatStatus = z.infer<typeof WorkflowRepeatStatusSchema>;
/** Host capability: `run.launch` (prepare and start the saved flow as one durable request). */
export const WORKFLOW_LAUNCH_CAPABILITY = 'workflow-launch-v1';
/**
 * Host capability: 반복 (a subproject's `repeat` is saved and run by the host). Separate from launch: a host with
 * launch but without 반복 refuses `repeat` in its strict update schema.
 */
export const WORKFLOW_REPEAT_CAPABILITY = 'workflow-repeat-v1';
export const WorkflowSubprojectSchema = z.object({
  id, title: z.string().trim().min(1).max(300), goal: z.string().max(65_536), status: z.enum(['active', 'completed', 'archived']),
  revision, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), presetId: z.string().max(100),
  graph: WorkflowGraphSchema, history: z.array(WorkflowHistorySchema), archivedNodes: z.array(WorkflowNodeSchema),
  legacyPlanning: z.boolean().optional(),
  /** 자동 승인: runs prepared from now on approve stages and integrate without the person (person only). */
  autoApprove: z.boolean().optional(),
  /** Saved only once chosen (protocol v17). */
  runSettings: WorkflowRunSettingsSchema.optional(),
  /** Saved only once chosen (protocol v17). */
  repeat: WorkflowRepeatSchema.optional(),
}).strict();
export type WorkflowSubproject = z.infer<typeof WorkflowSubprojectSchema>;
export const WorkflowSessionLinkSchema = z.object({
  sessionId: id, subprojectId: id, nodeId: id.optional(), scope: z.enum(['stage', 'flow-edit']),
  linkedAt: z.string().datetime(), graphRevision: revision,
  referenceSnapshot: WorkflowConversationContextSchema.optional(),
  referenceStale: z.boolean().optional(),
}).strict();
export type WorkflowSessionLink = z.infer<typeof WorkflowSessionLinkSchema>;
export const WorkflowRegistrySchema = z.object({
  schemaVersion: z.literal(1), projectId: id, registryRevision: revision,
  subprojects: z.array(WorkflowSubprojectSchema).max(2_000), sessionLinks: z.array(WorkflowSessionLinkSchema),
  historicalSessionLinks: z.array(WorkflowSessionLinkSchema).optional(),
  legacyBaselineOwners: z.record(id, id.nullable()),
}).strict();
export type WorkflowRegistry = z.infer<typeof WorkflowRegistrySchema>;
export type WorkflowRun = ExecutionRun;
export const WorkflowSnapshotSchema = WorkflowRegistrySchema.extend({ hostId: id, runs: PlanningExecutionSnapshotSchema.shape.runs, managedSessionIds: z.array(id).optional(),
  /** Per subproject with a repeat (protocol v17). */
  repeatStatus: z.record(id, WorkflowRepeatStatusSchema).optional() }).strict();
export type WorkflowSnapshot = Omit<z.infer<typeof WorkflowSnapshotSchema>, 'runs'> & { readonly runs: readonly ExecutionRun[] };

/** Navigation projection excludes instructions, documents, graph edges, runs and edit history. */
export const WorkflowNavigationSnapshotSchema = z.object({
  projectId: id, registryRevision: revision,
  subprojects: z.array(z.object({ id, title: z.string(), status: z.enum(['active', 'completed', 'archived']), updatedAt: z.string(),
    stages: z.array(z.object({ id, title: z.string(), archived: z.boolean() }).strict()),
  }).strict()),
  sessionLinks: z.array(z.object({ sessionId: id, subprojectId: id, nodeId: id.optional(), scope: z.enum(['stage', 'flow-edit']) }).strict()),
}).strict();
export type WorkflowNavigationSnapshot = z.infer<typeof WorkflowNavigationSnapshotSchema>;
export const WorkflowNavigationResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: WorkflowNavigationSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }).strict(),
]);
export type WorkflowNavigationResult = z.infer<typeof WorkflowNavigationResultSchema>;
export interface WorkflowNavigationAccess { getWorkflowNavigation(projectId: string): Promise<WorkflowNavigationResult> }

const envelope = { commandId: id, projectId: id, hostId: id, expectedRevision: revision, subprojectId: id.optional() };
export const WorkflowCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('subproject.create'), payload: z.object({ id, title: z.string().trim().min(1).max(300), goal: z.string().max(65_536), presetId: z.enum(['feature', 'fix', 'research', 'parallel', 'custom']), graph: WorkflowGraphSchema.optional(), previewId: id.optional(), previewRevision: revision.optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('subproject.update'), payload: z.object({ title: z.string().trim().min(1).max(300).optional(), goal: z.string().max(65_536).optional(), status: z.enum(['active', 'completed', 'archived']).optional(), autoApprove: z.boolean().optional(), runSettings: WorkflowRunSettingsSchema.optional(), repeat: WorkflowRepeatSchema.optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('subproject.copy'), payload: z.object({ id, title: z.string().trim().min(1).max(300) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow.patch'), payload: z.object({ graph: WorkflowGraphSchema, summary: z.string().min(1).max(1_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow.undo'), payload: z.object({ changeId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.link'), payload: z.object({ sessionId: id, nodeId: id.optional(), scope: z.enum(['stage', 'flow-edit']) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.unlink'), payload: z.object({ sessionId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.refresh'), payload: z.object({ sessionId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.prepare'), payload: z.object({ runId: id, reviewer: WorkflowReviewerSchema }).strict() }).strict(),
  /** Prepare and start the saved flow (다시 실행). The review AI defaults to the subproject's run settings. */
  z.object({ ...envelope, type: z.literal('run.launch'), payload: z.object({ runId: id, reviewer: WorkflowReviewerSchema.optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.start'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.pause'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.resume'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.cancel'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.integrate'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.approve'), payload: z.object({ runId: id, activationId: id, decision: z.enum(['approve', 'reject']) }).strict() }).strict(),
]);
export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;
/** `reducedFlowView`: a remote reader on protocol v16 or older, which only sees flows without the v17 fields. */
/** `schedule`: the host's own repeat schedule, which may only launch a flow (never saved as an author). */
export type WorkflowPrincipal = { readonly kind: 'desktop' | 'android' | 'ai' | 'schedule'; readonly id: string; readonly sessionId?: string; readonly reducedFlowView?: true };
/** Who sent a command, for receipt fingerprints: how it was connected is not part of it, so a phone's retry still matches after an app update. */
export function workflowPrincipalIdentity(principal: WorkflowPrincipal): Omit<WorkflowPrincipal, 'reducedFlowView'> {
  return { kind: principal.kind, id: principal.id, ...(principal.sessionId ? { sessionId: principal.sessionId } : {}) };
}
export const WorkflowResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: WorkflowSnapshotSchema, commandId: id.optional(), duplicate: z.boolean().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string(), revision: revision.optional(),
    issues: z.array(z.object({ code: z.string(), message: z.string(), nodeId: id.optional(), edgeId: id.optional() }).strict()).optional() }).strict(),
]);
export type WorkflowResult = { readonly ok: true; readonly snapshot: WorkflowSnapshot; readonly commandId?: string; readonly duplicate?: boolean }
  | Extract<z.infer<typeof WorkflowResultSchema>, { ok: false }>;
export interface WorkflowAccess {
  getWorkflowSnapshot(projectId: string): Promise<WorkflowResult>;
  executeWorkflowCommand(command: WorkflowCommand): Promise<WorkflowResult>;
  workflowPreview?(request: WorkflowPreviewRequest): Promise<WorkflowPreviewResult>;
  /** Desktop only: a project's runs changed (a stage started, finished or waits for approval). */
  onWorkflowRunsChanged?(listener: (projectId: string) => void): () => void;
}

export const WorkflowPreviewSchema = z.object({ id, projectId: id, sessionId: id, revision, graph: WorkflowGraphSchema }).strict();
export type WorkflowPreview = z.infer<typeof WorkflowPreviewSchema>;
export const WorkflowPreviewRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), projectId: id, sessionId: id, previewId: id, graph: WorkflowGraphSchema }).strict(),
  z.object({ action: z.literal('read'), projectId: id, previewId: id }).strict(),
  z.object({ action: z.literal('discard'), projectId: id, previewId: id }).strict(),
]);
export type WorkflowPreviewRequest = z.infer<typeof WorkflowPreviewRequestSchema>;
export const WorkflowPreviewResultSchema = z.union([z.object({ ok: z.literal(true), preview: WorkflowPreviewSchema.nullable() }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]);
export type WorkflowPreviewResult = z.infer<typeof WorkflowPreviewResultSchema>;
