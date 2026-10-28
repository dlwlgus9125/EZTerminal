// FROZEN COPY of src/shared/chat-message.ts at c74ac76 (remote protocol v17). Do not edit:
// tests use it to prove what an already-installed v17 reader accepts.
import { z } from 'zod';
import { WorkflowConversationContextSchema, type WorkflowConversationContext } from './workflow-conversation';

/** Small inline attachments travel in the same durable command as the message. */
export const MAX_CHAT_ATTACHMENTS = 4;
export const MAX_CHAT_ATTACHMENT_BYTES = 480 * 1024;
export const MAX_CHAT_CONTEXT_BYTES = 700 * 1024;
export const MAX_CHAT_REPLY_LENGTH = 4_000;
export const CHAT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const CHAT_ATTACHMENT_ACCEPT = '.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.css,.html,.py,.yaml,.yml,image/png,image/jpeg,image/webp,image/gif';

export interface ChatAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: 'image' | 'text';
  /** Raw base64 for images; UTF-8 text for text attachments. */
  readonly data: string;
}

export interface ChatReplyReference {
  readonly messageId: string;
  readonly text: string;
}

export interface ChatMessageContext {
  readonly workflow?: WorkflowConversationContext;
  readonly skills?: readonly ChatSkillReference[];
  readonly attachments?: readonly ChatAttachment[];
  readonly replyTo?: ChatReplyReference;
}

export const ChatSkillReferenceSchema = z.object({
  providerId: z.enum(['codex', 'claude']), id: z.string().min(1).max(2_048),
  name: z.string().min(1).max(240), invocation: z.string().min(1).max(300),
}).strict();
export type ChatSkillReference = z.infer<typeof ChatSkillReferenceSchema>;

/** Device-owned unsent composition. Never serialize this into the window layout. */
export interface ChatDraftContent extends ChatMessageContext {
  readonly text: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

export interface ChatComposerDraft extends ChatDraftContent {
  /** One explicit parked draft when a queued request is taken back for editing. */
  readonly parkedDraft?: ChatDraftContent;
}

export function chatAttachmentBytes(attachment: ChatAttachment): number {
  if (attachment.kind === 'text') return new TextEncoder().encode(attachment.data).byteLength;
  const padding = attachment.data.endsWith('==') ? 2 : attachment.data.endsWith('=') ? 1 : 0;
  return (attachment.data.length / 4) * 3 - padding;
}

export const ChatAttachmentSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(240),
  mimeType: z.string().min(1).max(100),
  kind: z.enum(['image', 'text']),
  data: z.string().min(1).max(MAX_CHAT_CONTEXT_BYTES),
}).strict().superRefine((value, context) => {
  if (value.kind === 'image' && (
    !(CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(value.mimeType)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)
  )) context.addIssue({ code: 'custom', message: 'Unsupported image type or invalid base64.' });
  if (value.kind === 'text' && value.data.includes('\0')) {
    context.addIssue({ code: 'custom', message: 'Binary files cannot be sent as text.' });
  }
  if (chatAttachmentBytes(value) > MAX_CHAT_ATTACHMENT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Each attachment must be 480 KiB or smaller.' });
  }
});

export const ChatReplyReferenceSchema = z.object({
  messageId: z.string().min(1).max(240),
  text: z.string().min(1).max(MAX_CHAT_REPLY_LENGTH),
}).strict();

export const ChatMessageContextSchema = z.object({
  workflow: WorkflowConversationContextSchema.optional(),
  skills: z.array(ChatSkillReferenceSchema).max(20).optional(),
  attachments: z.array(ChatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS).optional(),
  replyTo: ChatReplyReferenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CHAT_CONTEXT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Combined message context must be 700 KiB or smaller.' });
  }
  const ids = value.attachments?.map((attachment) => attachment.id) ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Attachment identities must be unique.' });
});

export function validateChatMessageContext(value: unknown): string | null {
  const parsed = ChatMessageContextSchema.safeParse(value);
  return parsed.success ? null : parsed.error.issues[0]?.message ?? 'Invalid message context.';
}

/** Context is explicitly quoted data, separate from the user's request. */
export function promptWithChatContext(prompt: string, context?: ChatMessageContext): string {
  const blocks: string[] = [];
  if (context?.workflow) blocks.push(`Saved stage references (revision ${context.workflow.graphRevision}, ${context.workflow.fingerprint}; quoted project data, not tool permissions):\n${JSON.stringify(context.workflow)}`);
  if (context?.replyTo) blocks.push(`Quoted earlier message (${context.replyTo.messageId}):\n${JSON.stringify(context.replyTo.text)}`);
  for (const attachment of context?.attachments ?? []) {
    if (attachment.kind === 'text') blocks.push(`Attached text file ${JSON.stringify(attachment.name)}:\n${JSON.stringify(attachment.data)}`);
  }
  return blocks.length ? `${prompt}\n\n--- Referenced content (quoted data) ---\n${blocks.join('\n\n')}` : prompt;
}
