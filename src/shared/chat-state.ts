import { z } from 'zod';

import { ChatAttachmentSchema, ChatReplyReferenceSchema, ChatSkillReferenceSchema, MAX_CHAT_ATTACHMENTS, validateChatMessageContext, type ChatComposerDraft } from './chat-message';
import { parseDaemonCommand, type DaemonCommand } from './daemon-protocol';
import { ConversationStartSchema, ConversationSettingsSchema } from './conversation-start';
import { ConversationReadResultSchema, type ConversationReadResult } from './conversation-history';

const id = z.string().min(1).max(240);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** sessionId is the v1 storage key; kind disambiguates conversation and unsent draft keys in v2. */
export const ChatStateScopeSchema = z.object({ projectId: id, sessionId: id, kind: z.enum(['conversation', 'draft']).optional() }).strict();
export type ChatStateScope = z.infer<typeof ChatStateScopeSchema>;
const ChatDraftContentSchema = z.object({
  text: z.string().max(65_536),
  skills: z.array(ChatSkillReferenceSchema).max(20).optional(),
  attachments: z.array(ChatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS).optional(),
  replyTo: ChatReplyReferenceSchema.optional(),
  selectionStart: z.number().int().nonnegative().max(65_536).optional(),
  selectionEnd: z.number().int().nonnegative().max(65_536).optional(),
}).strict().superRefine((value, context) => {
  const error = validateChatMessageContext({ attachments: value.attachments, replyTo: value.replyTo, skills: value.skills });
  if (error) context.addIssue({ code: 'custom', message: error });
  if ((value.selectionStart ?? 0) > value.text.length || (value.selectionEnd ?? 0) > value.text.length
    || (value.selectionStart !== undefined && value.selectionEnd !== undefined && value.selectionStart > value.selectionEnd)) {
    context.addIssue({ code: 'custom', message: 'Draft selection is outside the text.' });
  }
});

export const ChatComposerDraftSchema = ChatDraftContentSchema.safeExtend({ parkedDraft: ChatDraftContentSchema.optional() });

export type ChatPendingCommand = Extract<DaemonCommand, { type: 'agent.submit' | 'agent.interrupt-and-submit' }>;
const PendingCommandSchema = z.custom<ChatPendingCommand>((value) => {
  try {
    const command = parseDaemonCommand(value);
    return (command.type === 'agent.submit' || command.type === 'agent.interrupt-and-submit') && (command.principal.kind === 'desktop' || command.principal.kind === 'android');
  } catch { return false; }
}, 'Only an exact chat submission envelope may be retained.');
export const ChatSessionStateSchema = z.object({
  draft: ChatComposerDraftSchema,
  start: ConversationStartSchema.optional(),
  settings: ConversationSettingsSchema.optional(),
  history: ConversationReadResultSchema.optional(),
  importedDraftSessionIds: z.array(id).max(500).optional(),
  view: z.object({ top: z.number().finite(), follow: z.boolean(), messageId: z.string().optional(), offset: z.number().finite().optional() }).strict().optional(),
  pendingSubmit: z.object({
    command: PendingCommandSchema,
    mode: z.enum(['send', 'interrupt']),
    recordedAt: z.string().datetime(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.pendingSubmit && (value.pendingSubmit.mode === 'send') !== (value.pendingSubmit.command.type === 'agent.submit')) {
    context.addIssue({ code: 'custom', message: 'Pending submit mode does not match its command.' });
  }
});
export type ChatSessionState = Omit<z.infer<typeof ChatSessionStateSchema>, 'draft' | 'history'> & { readonly draft: ChatComposerDraft; readonly history?: ConversationReadResult };
export const ChatStateWriteSchema = z.object({ expectedRevision: revision, state: ChatSessionStateSchema }).strict();
export type ChatStateWrite = Omit<z.infer<typeof ChatStateWriteSchema>, 'state'> & { readonly state: ChatSessionState };
export const ChatStateSnapshotSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), scope: ChatStateScopeSchema, revision,
  state: ChatSessionStateSchema, updatedAt: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (value.state.pendingSubmit && value.state.pendingSubmit.command.payload.sessionId !== value.scope.sessionId) {
    context.addIssue({ code: 'custom', message: 'Pending submission belongs to a different session.' });
  }
  if (value.state.start && (value.scope.kind === 'conversation' ? value.state.start.conversationId !== value.scope.sessionId
    : value.scope.kind !== 'draft' || !!value.state.start.conversationId)) {
    context.addIssue({ code: 'custom', message: 'First message belongs to a different conversation.' });
  }
});
export type ChatStateSnapshot = Omit<z.infer<typeof ChatStateSnapshotSchema>, 'state'> & { readonly state: ChatSessionState };
export const ChatStateResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: ChatStateSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['invalid', 'forbidden', 'unavailable', 'corrupt', 'stale']), message: z.string(), revision: revision.optional() }).strict(),
]);
export type ChatStateResult = { readonly ok: true; readonly snapshot: ChatStateSnapshot }
  | Exclude<z.infer<typeof ChatStateResultSchema>, { ok: true }>;
