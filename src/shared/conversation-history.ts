import { z } from 'zod';
import type { AgentTranscriptPage } from './agent-history';
import type { PermissionPreset } from './daemon-protocol';

/** An opaque history identity. Provider session IDs remain in the host. */
export interface ConversationEntry {
  readonly conversationId: string;
  readonly source: 'app' | 'native';
  readonly providerId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly roots: readonly string[];
  readonly workspaceId?: string;
  readonly linkedSessionId?: string;
  /** Historical public identities of this same conversation, never provider thread IDs. */
  readonly aliases?: readonly string[];
  readonly sessionAliases?: readonly string[];
  /** Opaque legacy history ID, only for the explicit CLI alternative. */
  readonly historyId?: string;
  readonly subprojectId?: string;
  readonly subprojectTitle?: string;
  readonly nodeId?: string;
  readonly nodeTitle?: string;
  readonly archived: boolean;
  readonly state: string;
  readonly action: 'open' | 'resume' | 'unavailable';
}

export type ConversationHistoryFailureReason = 'invalid' | 'not-found' | 'unavailable' | 'unsupported'
  | 'stale' | 'missing-root' | 'root-mismatch' | 'provider-unavailable' | 'conflict' | 'archived-project'
  | 'transcript-unavailable';
export interface ConversationHistoryFailure {
  readonly ok: false;
  readonly reason: ConversationHistoryFailureReason;
  readonly message: string;
}
const id = z.string().min(1).max(160);
export const ConversationQuerySchema = z.object({
  projectId: id.optional(), providerId: id.optional(), source: z.enum(['app', 'native']).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(), query: z.string().max(500).optional(),
  cursor: z.string().max(65_536).optional(), limit: z.number().int().min(1).max(100).optional(), force: z.boolean().optional(),
}).strict();
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;
export type ConversationPage = { readonly ok: true; readonly items: readonly ConversationEntry[]; readonly nextCursor: string | null } | ConversationHistoryFailure;
export type ConversationReadResult = { readonly ok: true; readonly entry: ConversationEntry; readonly transcript: AgentTranscriptPage } | ConversationHistoryFailure;
export const ConversationRefSchema = z.object({ kind: z.enum(['conversation', 'session', 'history', 'terminal']), id }).strict();
export type ConversationRef = z.infer<typeof ConversationRefSchema>;
export type ConversationResolveResult = { readonly ok: true; readonly entry: ConversationEntry } | ConversationHistoryFailure;

export const HistoryResumePreparationRequestSchema = z.object({
  conversationId: id, workspaceId: id.optional(), model: z.string().min(1).max(256).optional(),
  permissionPreset: z.enum(['plan', 'standard', 'full-access']).optional(),
}).strict();
export type HistoryResumePreparationRequest = z.infer<typeof HistoryResumePreparationRequestSchema>;
export type HistoryResumePreparation = {
  readonly ok: true;
  readonly entry: ConversationEntry;
  readonly revision: string;
  readonly workspaceId?: string;
  readonly canResume: boolean;
  readonly blockedReason?: ConversationHistoryFailureReason;
  readonly message?: string;
  readonly linkedSessionId?: string;
  readonly action: 'open' | 'resume' | 'unavailable';
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
} | ConversationHistoryFailure;
export const HistoryResumeRequestSchema = HistoryResumePreparationRequestSchema.extend({
  revision: z.string().min(1).max(128), commandId: id,
}).strict();
export type HistoryResumeRequest = z.infer<typeof HistoryResumeRequestSchema>;
export type HistoryResumeResult = { readonly ok: true; readonly sessionId: string; readonly alreadyLinked: boolean } | ConversationHistoryFailure;

export interface ConversationHistoryClient {
  resolveConversation?(ref: ConversationRef): Promise<ConversationResolveResult>;
  listConversations(query?: ConversationQuery): Promise<ConversationPage>;
  readConversation(conversationId: string, cursor?: string, limit?: number): Promise<ConversationReadResult>;
  prepareHistoryResume(request: HistoryResumePreparationRequest): Promise<HistoryResumePreparation>;
  resumeHistory(request: HistoryResumeRequest): Promise<HistoryResumeResult>;
}

const failureSchema = z.object({ ok: z.literal(false), reason: z.enum(['invalid', 'not-found', 'unavailable', 'unsupported', 'stale', 'missing-root', 'root-mismatch',
  'provider-unavailable', 'conflict', 'archived-project', 'transcript-unavailable']), message: z.string().max(4_000) }).strict();
export const ConversationEntrySchema = z.object({
  conversationId: id, source: z.enum(['app', 'native']), providerId: id, projectId: id, projectTitle: z.string().max(1_000),
  title: z.string().max(4_000), preview: z.string().max(65_536), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  roots: z.array(z.string().max(8_192)).max(32), workspaceId: id.optional(), linkedSessionId: id.optional(), historyId: id.optional(),
  aliases: z.array(id).optional(), sessionAliases: z.array(id).optional(),
  subprojectId: id.optional(), subprojectTitle: z.string().max(300).optional(), nodeId: id.optional(), nodeTitle: z.string().max(300).optional(),
  archived: z.boolean(), state: z.string().max(100), action: z.enum(['open', 'resume', 'unavailable']),
}).strict();
export const ConversationResolveResultSchema = z.union([z.object({ ok: z.literal(true), entry: ConversationEntrySchema }).strict(), failureSchema]);
const transcriptEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), id, role: z.enum(['user', 'assistant']), markdown: z.string() }).strict(),
  z.object({ type: z.literal('activity'), id, kind: z.enum(['command', 'tool', 'file-change', 'web-search', 'plan', 'subagent', 'image', 'reasoning']),
    summary: z.string(), status: z.string().optional(), changedPaths: z.array(z.string()).optional() }).strict(),
]);
export const ConversationPageSchema = z.union([z.object({ ok: z.literal(true), items: z.array(ConversationEntrySchema).max(100), nextCursor: z.string().max(65_536).nullable() }).strict(), failureSchema]);
export const ConversationReadResultSchema = z.union([z.object({ ok: z.literal(true), entry: ConversationEntrySchema,
  transcript: z.object({ historyId: id, provider: z.enum(['codex', 'claude']), turns: z.array(z.object({ id, status: z.string(), entries: z.array(transcriptEntrySchema) }).strict()), nextCursor: z.string().nullable() }).strict(),
}).strict(), failureSchema]);
export const HistoryResumePreparationSchema = z.union([z.object({ ok: z.literal(true), entry: ConversationEntrySchema, revision: z.string().max(128),
  workspaceId: id.optional(), canResume: z.boolean(), blockedReason: failureSchema.shape.reason.optional(), message: z.string().max(4_000).optional(),
  linkedSessionId: id.optional(), action: z.enum(['open', 'resume', 'unavailable']), model: z.string().optional(), permissionPreset: z.enum(['plan', 'standard', 'full-access']),
}).strict(), failureSchema]);
export const HistoryResumeResultSchema = z.union([z.object({ ok: z.literal(true), sessionId: id, alreadyLinked: z.boolean() }).strict(), failureSchema]);
