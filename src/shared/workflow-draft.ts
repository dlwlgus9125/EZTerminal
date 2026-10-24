import { z } from 'zod';
import { WorkflowGraphSchema, WorkflowNodeSchema, WorkflowCommandSchema, WorkflowIdSchema, WorkflowSnapshotSchema, type WorkflowSnapshot } from './workflow';
import { parseDaemonCommand, type DaemonCommand } from './daemon-protocol';
import { ChatComposerDraftSchema } from './chat-state';
const revision = z.number().int().nonnegative();
const createConversation = z.custom<Extract<DaemonCommand, { type: 'agent.create' }>>(value => {
  try { const command = parseDaemonCommand(value); return command.type === 'agent.create' && ['desktop', 'android'].includes(command.principal.kind); } catch { return false; }
});
const recoveryGraph = WorkflowGraphSchema.extend({ nodes: z.array(WorkflowNodeSchema.extend({
  title: z.string().max(300), acceptance: z.array(z.string().max(4_000)).max(200), allowedPaths: z.array(z.string().max(1_024)).max(200),
  condition: z.object({ sourceNodeId: z.string().max(160), field: z.literal('outcome'), equals: z.enum(['passed', 'failed']) }).strict().optional(),
})).max(128) });
export const WorkflowDraftStateSchema = z.object({
  projectId: WorkflowIdSchema, hostId: WorkflowIdSchema,
  snapshot: z.custom<WorkflowSnapshot>(value => WorkflowSnapshotSchema.safeParse(value).success).optional(),
  drafts: z.record(WorkflowIdSchema, z.object({ baseRevision: revision, graph: recoveryGraph }).strict()),
  pendingCommand: WorkflowCommandSchema.nullable(),
  /**
   * This recovery (its cached flow and every draft made from it) comes from an app before remote protocol
   * v17 and is not rebased on the host yet: kept across saves and restarts until it is.
   */
  olderVersion: z.literal(true).optional(),
  creation: z.object({ id: WorkflowIdSchema, title: z.string().max(300), goal: z.string().max(65_536), preset: z.enum(['feature', 'fix', 'research', 'parallel', 'custom']), mode: z.enum(['preset', 'conversation']), graph: recoveryGraph, previewSessionId: WorkflowIdSchema.optional(), previewRevision: revision.optional(), linkSessionId: WorkflowIdSchema.optional() }).strict().optional(),
  view: z.object({ subprojectId: WorkflowIdSchema.optional(), nodeId: WorkflowIdSchema.optional(), page: z.enum(['flow', 'stage', 'history', 'run', 'planning']), scrollTop: z.number().finite().nonnegative() }).strict().optional(),
  pendingConversation: z.object({ command: createConversation, subprojectId: WorkflowIdSchema.optional(), nodeId: WorkflowIdSchema.optional(), scope: z.enum(['stage', 'flow-edit']).optional(), previewId: WorkflowIdSchema.optional(), draft: ChatComposerDraftSchema.optional() }).strict().optional(),
}).strict().superRefine((state, context) => {
  if (state.snapshot && (state.snapshot.projectId !== state.projectId || state.snapshot.hostId !== state.hostId)) context.addIssue({ code: 'custom', message: 'The cached workflow belongs to another host or project.' });
  if (state.pendingCommand && (state.pendingCommand.projectId !== state.projectId || state.pendingCommand.hostId !== state.hostId)) context.addIssue({ code: 'custom', message: 'The pending workflow command belongs to another host or project.' });
});
export type WorkflowDraftState = z.infer<typeof WorkflowDraftStateSchema>;
export const WorkflowDraftWriteSchema = z.object({ expectedRevision: revision, state: WorkflowDraftStateSchema }).strict();
export type WorkflowDraftWrite = z.infer<typeof WorkflowDraftWriteSchema>;
export const WorkflowDraftResultSchema = z.union([
  /**
   * `olderVersion`: read from where an app before remote protocol v17 kept it. Its graphs cannot hold the
   * v17 stage fields, so they are a reduced view: rebase them on the host before saving (see WorkflowWorkspacePanel).
   */
  z.object({ ok: z.literal(true), snapshot: z.object({ projectId: WorkflowIdSchema, revision, state: WorkflowDraftStateSchema.nullable(), olderVersion: z.literal(true).optional() }).strict() }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['invalid', 'forbidden', 'unavailable', 'corrupt', 'stale']), message: z.string() }).strict(),
]);
export type WorkflowDraftResult = z.infer<typeof WorkflowDraftResultSchema>;
export interface WorkflowDraftAccess {
  workflowDraftRead(projectId: string): Promise<WorkflowDraftResult>;
  workflowDraftWrite(projectId: string, request: WorkflowDraftWrite): Promise<WorkflowDraftResult>;
}
