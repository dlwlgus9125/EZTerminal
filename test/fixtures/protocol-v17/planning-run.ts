// FROZEN COPY of src/shared/planning-run.ts at c74ac76 (remote protocol v17). Do not edit:
// tests use it to prove what an already-installed v17 reader accepts.
import { z } from 'zod';
import type { PlanningExecutionSnapshot, ExecutionPreparation } from './planning-execution';
import { PlanningExecutionSnapshotSchema } from './planning-execution';
import { PlanningDeviceEvidenceInputSchema } from './planning-device-evidence';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const PlanningTaskAssignmentSchema = z.object({
  taskId: id,
  profileId: id,
  providerId: id,
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(32).optional(),
  permissionPreset: z.enum(['plan', 'standard', 'full-access']),
}).strict();
export type PlanningTaskAssignment = z.infer<typeof PlanningTaskAssignmentSchema>;
export const PlanningRunPreparationInputSchema = z.object({
  runId: id,
  baselineId: id,
  teamMode: z.enum(['single', 'division', 'candidates', 'independent-review']),
  progressPolicy: z.enum(['manual', 'checkpoint', 'autonomous']),
  assignments: z.array(PlanningTaskAssignmentSchema).min(1).max(128),
  reviewer: PlanningTaskAssignmentSchema.omit({ taskId: true }).optional(),
  supersedesRunId: id.optional(),
}).strict();
export type PlanningRunPreparationInput = z.infer<typeof PlanningRunPreparationInputSchema>;

const envelope = { commandId: id, projectId: id, subprojectId: id.optional(), expectedRevision: z.number().int().nonnegative() };
const run = { runId: id };
const task = { ...run, taskId: id };
export const PlanningRunRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('prepare'), payload: PlanningRunPreparationInputSchema }).strict(),
  z.object({ ...envelope, type: z.literal('start'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('pause'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('continue'), payload: z.object(run).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('cancel-task'), payload: z.object(task).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('retry'), payload: z.object(task).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('extend-retry'), payload: z.object({ ...task, reason: z.string().min(1).max(4_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('resume-task'), payload: z.object(task).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('select-candidate'), payload: z.object(task).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('keep-original'), payload: z.object({ ...run, gateId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('resolve-change'), payload: z.object({ ...run, gateId: id, decision: z.enum(['approve', 'reject']), detail: z.string().min(1).max(10_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('review'), payload: z.object({ ...run, attemptId: id, decision: z.enum(['approve', 'reject']), detail: z.string().min(1).max(10_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('retry-review'), payload: z.object({ ...run, attemptId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('record-device-evidence'), payload: PlanningDeviceEvidenceInputSchema }).strict(),
]);
export type PlanningRunRequest = z.infer<typeof PlanningRunRequestSchema>;
export type PlanningRunResult = { readonly ok: true; readonly snapshot: PlanningExecutionSnapshot; readonly commandId?: string }
  | { readonly ok: false; readonly error: string; readonly message: string };
export type PlanningPreparationResult = { readonly ok: true; readonly preparation: ExecutionPreparation }
  | { readonly ok: false; readonly error: string; readonly message: string };

export const PlanningRunResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: PlanningExecutionSnapshotSchema, commandId: id.optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }).strict(),
]);
