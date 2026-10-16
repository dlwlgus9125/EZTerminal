import { z } from 'zod';
import { PlanningRunRequestSchema } from './planning-run';
import { ProjectArchiveRequestSchema } from './project-archive';
import { PlanningAiRequestSchema } from './planning-ai';
import {
  PlanningCommandSchema, PlanningComponentSchema, PlanningItemSchema, PlanningRoleProfileSchema,
  PlanningSnapshotSchema, PlanningTaskSchema, ScreenSceneSchema,
} from './planning';

const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const draftTitle = z.string().max(300);
const TaskDraftSchema = PlanningTaskSchema.extend({
  title: draftTitle,
  allowedPaths: z.array(z.string().max(1024)).max(200),
  acceptance: z.array(PlanningTaskSchema.shape.acceptance.element.extend({ description: z.string().max(4000) })).max(200),
  validationPlan: z.array(PlanningTaskSchema.shape.validationPlan.element.extend({ description: z.string().max(4000), environment: z.string().max(1000) })).max(200),
});
export const PlanningEntityDraftsSchema = z.object({
  tasks: z.record(z.string(), z.object({ value: TaskDraftSchema, dirty: z.boolean() }).strict()),
  profiles: z.record(z.string(), z.object({ value: PlanningRoleProfileSchema.extend({ title: draftTitle }), dirty: z.boolean() }).strict()),
  scenes: z.record(z.string(), z.object({ value: ScreenSceneSchema.extend({ title: draftTitle, states: z.array(ScreenSceneSchema.shape.states.element.extend({ title: draftTitle })).max(100) }), dirty: z.boolean() }).strict()),
  components: z.record(z.string(), z.object({ value: PlanningComponentSchema.extend({ title: draftTitle }), dirty: z.boolean() }).strict()),
}).strict();
export type PlanningEntityDrafts = z.infer<typeof PlanningEntityDraftsSchema>;
export const PlanningWorkspaceDraftSchema = z.object({
  version: z.literal(1), projectId,
  subprojectId: projectId.optional(),
  snapshot: PlanningSnapshotSchema.nullable(), selectedId: z.string().nullable(),
  edits: z.record(z.string(), z.object({ item: PlanningItemSchema.extend({ title: draftTitle }), acceptanceText: z.string().max(1_000_000), dirty: z.boolean() }).strict()),
  entityDrafts: PlanningEntityDraftsSchema.default({ tasks: {}, profiles: {}, scenes: {}, components: {} }),
  uncertain: PlanningCommandSchema.nullable(),
  pendingRun: PlanningRunRequestSchema.nullable().optional(),
  pendingArchive: ProjectArchiveRequestSchema.nullable().optional(),
  pendingAi: PlanningAiRequestSchema.nullable().optional(),
}).strict().superRefine((draft, context) => {
  if ((draft.snapshot && draft.snapshot.projectId !== draft.projectId)
    || (draft.uncertain && draft.uncertain.projectId !== draft.projectId)
    || (draft.pendingRun && draft.pendingRun.projectId !== draft.projectId)
    || (draft.pendingAi && (draft.pendingAi.type === 'start' ? draft.pendingAi.request.projectId : draft.pendingAi.projectId) !== draft.projectId)
    || (draft.pendingArchive && 'projectId' in draft.pendingArchive && draft.pendingArchive.projectId !== undefined && draft.pendingArchive.projectId !== draft.projectId)) context.addIssue({ code: 'custom', message: 'Planning recovery belongs to a different project.' });
  for (const [key, value] of Object.entries(draft.edits)) {
    if (key !== value.item.id) context.addIssue({ code: 'custom', message: 'Planning edit key must match its item.' });
  }
  for (const drafts of Object.values(draft.entityDrafts)) {
    for (const [key, value] of Object.entries(drafts)) {
      if (key !== value.value.id) context.addIssue({ code: 'custom', message: 'Planning entity edit key must match its value.' });
    }
  }
});
/** Missing entity maps from older clients are normalized by the schema. */
export type PlanningWorkspaceDraft = z.input<typeof PlanningWorkspaceDraftSchema>;
export interface PlanningDraftStorage {
  loadDraft(): Promise<PlanningWorkspaceDraft | null>;
  saveDraft(state: PlanningWorkspaceDraft): Promise<void>;
}

export const PlanningDraftSnapshotSchema = z.object({
  version: z.literal(1), projectId, revision, state: PlanningWorkspaceDraftSchema.nullable(), updatedAt: z.string().datetime().nullable(),
  subprojectId: projectId.optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.state && snapshot.state.projectId !== snapshot.projectId) context.addIssue({ code: 'custom', message: 'Planning recovery scope does not match.' });
});
export type PlanningDraftSnapshot = z.infer<typeof PlanningDraftSnapshotSchema>;
export const PlanningDraftWriteSchema = z.object({ expectedRevision: revision, state: PlanningWorkspaceDraftSchema }).strict();
export type PlanningDraftWrite = z.input<typeof PlanningDraftWriteSchema>;
export const PlanningDraftResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: PlanningDraftSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['invalid', 'forbidden', 'unavailable', 'corrupt', 'stale']), message: z.string(), revision: revision.optional() }).strict(),
]);
export type PlanningDraftResult = z.infer<typeof PlanningDraftResultSchema>;
export const PlanningDraftProjectIdSchema = projectId;
