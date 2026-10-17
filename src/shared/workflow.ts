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
export const WorkflowSubprojectSchema = z.object({
  id, title: z.string().trim().min(1).max(300), goal: z.string().max(65_536), status: z.enum(['active', 'completed', 'archived']),
  revision, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), presetId: z.string().max(100),
  graph: WorkflowGraphSchema, history: z.array(WorkflowHistorySchema), archivedNodes: z.array(WorkflowNodeSchema),
  legacyPlanning: z.boolean().optional(),
  /** 자동 승인: runs prepared from now on approve stages and integrate without the person (person only). */
  autoApprove: z.boolean().optional(),
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
export const WorkflowSnapshotSchema = WorkflowRegistrySchema.extend({ hostId: id, runs: PlanningExecutionSnapshotSchema.shape.runs, managedSessionIds: z.array(id).optional() }).strict();
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
  z.object({ ...envelope, type: z.literal('subproject.update'), payload: z.object({ title: z.string().trim().min(1).max(300).optional(), goal: z.string().max(65_536).optional(), status: z.enum(['active', 'completed', 'archived']).optional(), autoApprove: z.boolean().optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('subproject.copy'), payload: z.object({ id, title: z.string().trim().min(1).max(300) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow.patch'), payload: z.object({ graph: WorkflowGraphSchema, summary: z.string().min(1).max(1_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow.undo'), payload: z.object({ changeId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.link'), payload: z.object({ sessionId: id, nodeId: id.optional(), scope: z.enum(['stage', 'flow-edit']) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.unlink'), payload: z.object({ sessionId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('session.refresh'), payload: z.object({ sessionId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.prepare'), payload: z.object({ runId: id, reviewer: z.object({ providerId: id, model: z.string().min(1).max(256) }).strict() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.start'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.pause'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.resume'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.cancel'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.integrate'), payload: z.object({ runId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('run.approve'), payload: z.object({ runId: id, activationId: id, decision: z.enum(['approve', 'reject']) }).strict() }).strict(),
]);
export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;
export type WorkflowPrincipal = { readonly kind: 'desktop' | 'android' | 'ai'; readonly id: string; readonly sessionId?: string };
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
