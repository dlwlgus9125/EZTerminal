// FROZEN COPY of src/shared/planning-device-evidence.ts at ed32a40 (remote protocol v16). Do not edit:
// tests use it to prove what an already-installed v16 reader accepts.
import { z } from 'zod';

export const DEVICE_EVIDENCE_MAX_ITEM_BYTES = 512 * 1024;
export const DEVICE_EVIDENCE_MAX_REQUEST_BYTES = 700 * 1024;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fields = {
  runId: id, taskId: id, validationId: id, baselineFingerprint: hash,
  deviceId: z.string().trim().min(1).max(256), platformVersion: z.string().trim().min(1).max(256),
  appVersion: z.string().trim().min(1).max(256), command: z.string().trim().min(1).max(4_000),
  exitCode: z.number().int(), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  summary: z.string().trim().min(1).max(4_000), attest: z.literal(true),
  textLog: z.string().min(1).max(DEVICE_EVIDENCE_MAX_ITEM_BYTES),
  capture: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataBase64: z.string().min(4).max(Math.ceil(DEVICE_EVIDENCE_MAX_ITEM_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }).strict(),
};
export const PlanningDeviceEvidenceInputSchema = z.discriminatedUnion('scope', [
  z.object({ ...fields, scope: z.literal('attempt'), attemptId: id, artifactIds: z.array(z.string().min(1).max(200)).min(1).max(128) }).strict(),
  z.object({ ...fields, scope: z.literal('integration'), candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/u) }).strict(),
]).superRefine((value, context) => {
  const bytes = new TextEncoder();
  if (bytes.encode(value.textLog).length > DEVICE_EVIDENCE_MAX_ITEM_BYTES || bytes.encode(JSON.stringify(value)).length > DEVICE_EVIDENCE_MAX_REQUEST_BYTES) context.addIssue({ code: 'custom', message: 'Device evidence exceeds the upload limit.' });
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) context.addIssue({ code: 'custom', message: 'Evidence finish time must follow its start time.' });
});
export type PlanningDeviceEvidenceInput = z.infer<typeof PlanningDeviceEvidenceInputSchema>;
export const PlanningDeviceEvidenceRecordSchema = z.object({
  provenance: z.literal('user-attested'), proofId: hash, principalId: z.string(),
  deviceId: fields.deviceId, platformVersion: fields.platformVersion, appVersion: fields.appVersion,
  command: fields.command, exitCode: fields.exitCode, startedAt: fields.startedAt, finishedAt: fields.finishedAt,
  captureRefs: z.array(z.string()).length(1), captureHash: hash, logHash: hash,
}).strict();
