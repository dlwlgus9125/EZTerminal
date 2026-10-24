// FROZEN COPY of src/shared/project-archive.ts at ed32a40 (remote protocol v16). Do not edit:
// tests use it to prove what an already-installed v16 reader accepts.
import { z } from 'zod';
import type { DaemonSession, DaemonTranscriptItem } from '../../../src/shared/daemon-protocol';
import { PlanningSnapshotSchema, type PlanningSnapshot } from './planning';
import { PlanningExecutionSnapshotSchema, type PlanningExecutionSnapshot } from './planning-execution';
import { PlanningIntegrationRecordSchema, PlanningResultRecordSchema, type PlanningIntegrationRecord, type PlanningResultRecord } from './planning-result';
import { ChatMessageContextSchema } from './chat-message';
import { WorkflowRegistrySchema, type WorkflowRegistry } from './workflow';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const ArchiveEntrySchema = z.object({ id, kind: z.enum(['planning', 'workflow', 'subproject-planning', 'daemon', 'execution', 'transcript', 'result', 'integration', 'log', 'asset', 'capture', 'patch', 'base-blob', 'environment', 'history']),
  hash, byteLength: z.number().int().nonnegative(), content: z.string(), metadata: z.record(z.string(), z.string()).optional() }).strict();
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;
export const ProjectArchiveManifestSchema = z.object({ version: z.literal(1), createdAt: z.string().datetime(), projectId: id, projectName: z.string(),
  source: z.object({ planningRevision: z.number().int().nonnegative(), daemonRevision: z.number().int().nonnegative(), executionRevision: z.number().int().nonnegative() }).strict(),
  entries: z.array(z.object({ id, kind: ArchiveEntrySchema.shape.kind, hash, byteLength: z.number().int().nonnegative(), metadata: z.record(z.string(), z.string()).optional() }).strict()).max(100_000),
  exclusions: z.array(z.object({ item: z.string(), reason: z.string() }).strict()),
  portable: z.boolean(), notes: z.array(z.string()), integrity: hash,
}).strict();
export type ProjectArchiveManifest = z.infer<typeof ProjectArchiveManifestSchema>;
export const ProjectArchivePackageSchema = z.object({ manifest: ProjectArchiveManifestSchema, entries: z.array(ArchiveEntrySchema).max(100_000) }).strict();
export type ProjectArchivePackage = z.infer<typeof ProjectArchivePackageSchema>;
export interface ProjectArchiveInventory {
  readonly projectId: string; readonly token: string; readonly revision: number;
  readonly groups: readonly { kind: string; items: number; bytes: number }[];
  readonly conversations: readonly { sessionId: string; title: string; items: number; bytes: number; deletable: boolean; protection?: string }[];
}
export interface ProjectArchiveHistory {
  readonly workflow?: WorkflowRegistry;
  readonly subprojectPlanning?: Readonly<Record<string, PlanningSnapshot>>;
  readonly manifest: ProjectArchiveManifest; readonly planning: PlanningSnapshot; readonly execution: PlanningExecutionSnapshot;
  readonly conversations: readonly { session: DaemonSession; transcript: readonly DaemonTranscriptItem[] }[];
  readonly results: readonly PlanningResultRecord[]; readonly integrations: readonly PlanningIntegrationRecord[];
}
export const ProjectArchiveRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inventory'), projectId: id }).strict(),
  z.object({ type: z.literal('export'), projectId: id, commandId: id }).strict(),
  z.object({ type: z.literal('prepare-import'), projectId: id }).strict(),
  z.object({ type: z.literal('inspect'), projectId: id.optional(), uploadedPath: z.string().max(4_096).optional() }).strict(),
  z.object({ type: z.literal('restore'), archiveId: id, commandId: id, name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ type: z.literal('history'), projectId: id }).strict(),
  z.object({ type: z.literal('cleanup'), projectId: id, inventoryToken: hash, sessionIds: z.array(id).min(1).max(2_000), confirmation: z.literal('delete-selected-archived-history') }).strict(),
]);
export type ProjectArchiveRequest = z.infer<typeof ProjectArchiveRequestSchema>;
export type ProjectArchiveResult = { ok: false; error: 'forbidden' | 'cancelled' | 'unavailable' | 'invalid-request'; message: string }
  | { ok: true; kind: 'inventory'; inventory: ProjectArchiveInventory }
  | { ok: true; kind: 'export'; path: string; manifest: ProjectArchiveManifest }
  | { ok: true; kind: 'inspect'; archiveId: string; manifest: ProjectArchiveManifest }
  | { ok: true; kind: 'prepare-import'; directoryPath: string }
  | { ok: true; kind: 'restore'; projectId: string; rootPath: string; manifest: ProjectArchiveManifest }
  | { ok: true; kind: 'history'; history: ProjectArchiveHistory | null }
  | { ok: true; kind: 'cleanup'; removedItems: number };

export const ArchiveSessionSchema = z.object({ id: z.string(), projectId: z.string(), workspaceId: z.string(),
  kind: z.enum(['agent', 'terminal', 'diff', 'browser', 'script', 'service']), title: z.string(),
  state: z.enum(['draft', 'starting', 'running', 'idle', 'needs-attention', 'stopping', 'completed', 'interrupted', 'delivery-uncertain', 'failed', 'archived']),
  source: z.enum(['structured', 'legacy-pty', 'legacy-import']), revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().optional(),
}).strict();
export const ArchiveTranscriptSchema = z.object({ id: z.string(), messageId: z.string().optional(), sessionId: z.string(), turnId: z.string().optional(), sequence: z.number().int().nonnegative(),
  kind: z.enum(['user-message', 'assistant-message', 'reasoning', 'tool-call', 'tool-result', 'approval', 'child-summary', 'notice', 'error']), text: z.string(),
  isDelta: z.boolean(), isSensitive: z.boolean(), relatedSessionId: z.string().optional(), createdAt: z.string(), context: ChatMessageContextSchema.optional(),
}).strict();
export const ProjectArchiveHistorySchema = z.object({ manifest: ProjectArchiveManifestSchema, planning: PlanningSnapshotSchema, execution: PlanningExecutionSnapshotSchema,
  workflow: WorkflowRegistrySchema.optional(), subprojectPlanning: z.record(z.string(), PlanningSnapshotSchema).optional(),
  conversations: z.array(z.object({ session: ArchiveSessionSchema, transcript: z.array(ArchiveTranscriptSchema) }).strict()),
  results: z.array(PlanningResultRecordSchema), integrations: z.array(PlanningIntegrationRecordSchema),
}).strict();
export const ProjectArchiveInventorySchema = z.object({ projectId: id, token: hash, revision: z.number().int().nonnegative(),
  groups: z.array(z.object({ kind: z.string(), items: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict()),
  conversations: z.array(z.object({ sessionId: z.string(), title: z.string(), items: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), deletable: z.boolean(), protection: z.string().optional() }).strict()),
}).strict();
export const ProjectArchiveResultSchema: z.ZodType<ProjectArchiveResult> = z.union([
  z.object({ ok: z.literal(false), error: z.enum(['forbidden', 'cancelled', 'unavailable', 'invalid-request']), message: z.string() }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('inventory'), inventory: ProjectArchiveInventorySchema }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('export'), path: z.string(), manifest: ProjectArchiveManifestSchema }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('inspect'), archiveId: id, manifest: ProjectArchiveManifestSchema }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('prepare-import'), directoryPath: z.string() }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('restore'), projectId: id, rootPath: z.string(), manifest: ProjectArchiveManifestSchema }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('history'), history: ProjectArchiveHistorySchema.nullable() }).strict(),
  z.object({ ok: z.literal(true), kind: z.literal('cleanup'), removedItems: z.number().int().nonnegative() }).strict(),
]);
