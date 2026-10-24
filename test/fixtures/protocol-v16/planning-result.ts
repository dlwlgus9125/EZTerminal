// FROZEN COPY of src/shared/planning-result.ts at ed32a40 (remote protocol v16). Do not edit:
// tests use it to prove what an already-installed v16 reader accepts.
import { z } from 'zod';
import type { DaemonTranscriptItem } from '../../../src/shared/daemon-protocol';
import { ExecutionArtifactSchema } from './planning-execution';
import { PlanningDeviceEvidenceRecordSchema } from './planning-device-evidence';

export const PlanningValidationRecordSchema = z.object({
  validationId: z.string().min(1).max(400), status: z.enum(['passed', 'failed', 'not-run']), exitCode: z.number().int().optional(),
  logRefs: z.array(z.string().max(200)).max(200), summary: z.string().max(65_536),
  device: PlanningDeviceEvidenceRecordSchema.optional(),
}).strict();
export type PlanningValidationRecord = z.infer<typeof PlanningValidationRecordSchema>;
export const PlanningReviewJudgmentSchema = z.object({ decision: z.enum(['approve', 'reject']), summary: z.string().max(65_536),
  inspections: z.array(z.object({ validationId: z.string(), status: z.enum(['passed', 'failed', 'not-run']), summary: z.string().max(10_000) }).strict()).max(200),
}).strict();
export type PlanningReviewJudgment = z.infer<typeof PlanningReviewJudgmentSchema>;
const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const PlanningResultRecordSchema = z.object({
  version: z.literal(1), projectId: z.string(), runId: z.string(), taskId: z.string(), attemptId: z.string(),
  baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), artifacts: z.array(ExecutionArtifactSchema), rootPath: z.string(),
  baseCommit: commit.optional(), commit: commit.optional(), changedPaths: z.array(z.string()),
  transcript: z.array(z.custom<DaemonTranscriptItem>((value) => typeof value === 'object' && value !== null
    && typeof (value as DaemonTranscriptItem).id === 'string' && typeof (value as DaemonTranscriptItem).text === 'string'
    && typeof (value as DaemonTranscriptItem).sessionId === 'string' && Number.isSafeInteger((value as DaemonTranscriptItem).sequence))).optional(),
  validationWorkspace: z.string().optional(), validations: z.array(PlanningValidationRecordSchema), reviewerSessionId: z.string().optional(),
  reviewerTurnId: z.string().optional(), review: PlanningReviewJudgmentSchema.optional(), error: z.string().optional(),
  reviewAttempt: z.number().int().nonnegative().optional(),
  disposition: z.enum(['completed', 'partial']).optional(),
}).strict();
export type PlanningResultRecord = z.infer<typeof PlanningResultRecordSchema>;
export const PlanningIntegrationRecordSchema = z.object({
  version: z.literal(1), projectId: z.string(), runId: z.string(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['validating', 'awaiting-evidence', 'passed', 'failed']), inputArtifacts: z.array(ExecutionArtifactSchema), workspacePath: z.string(),
  candidateCommit: commit, previousSuccessfulCommit: commit.optional(), successfulCommit: commit.optional(),
  validations: z.array(PlanningValidationRecordSchema), error: z.string().optional(),
}).strict();
export type PlanningIntegrationRecord = z.infer<typeof PlanningIntegrationRecordSchema>;
export const PlanningResultReadResultSchema = z.object({ ok: z.literal(true), result: PlanningResultRecordSchema.nullable() }).strict()
  .or(z.object({ ok: z.literal(false), message: z.string() }).strict());
export type PlanningResultReadResult = z.infer<typeof PlanningResultReadResultSchema>;
export const PlanningIntegrationReadResultSchema = z.object({ ok: z.literal(true), integration: PlanningIntegrationRecordSchema.nullable() }).strict()
  .or(z.object({ ok: z.literal(false), message: z.string() }).strict());
export type PlanningIntegrationReadResult = z.infer<typeof PlanningIntegrationReadResultSchema>;

const queryId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const PlanningResultQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attempt'), projectId: queryId, subprojectId: queryId.optional(), attemptId: queryId }).strict(),
  z.object({ kind: z.literal('diff'), projectId: queryId, subprojectId: queryId.optional(), attemptId: queryId }).strict(),
  z.object({ kind: z.literal('integration'), projectId: queryId, subprojectId: queryId.optional(), runId: queryId }).strict(),
  z.object({ kind: z.literal('log'), projectId: queryId, subprojectId: queryId.optional(), reference: queryId }).strict(),
  z.object({ kind: z.literal('capture'), projectId: queryId, subprojectId: queryId.optional(), reference: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
]);
export type PlanningResultQuery = z.infer<typeof PlanningResultQuerySchema>;
export const PlanningResultQueryResultSchema = z.union([
  z.object({ ok: z.literal(true), kind: z.literal('attempt'), result: PlanningResultRecordSchema.nullable() }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('integration'), integration: PlanningIntegrationRecordSchema.nullable() }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('log'), text: z.string().max(2_000_000) }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('diff'), text: z.string().max(2_000_000) }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('capture'), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), dataBase64: z.string().max(699_052) }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type PlanningResultQueryResult = z.infer<typeof PlanningResultQueryResultSchema>;
