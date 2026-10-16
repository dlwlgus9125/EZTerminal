import { z } from 'zod';
import { ChatMessageContextSchema } from './chat-message';
import { parseDaemonCommand, type DaemonCommandEnvelope } from './daemon-protocol';
import { HistoryResumeRequestSchema } from './conversation-history';

export const ConversationSettingsSchema = z.object({
  providerId: z.string().min(1), workspaceId: z.string().min(1), model: z.string().optional(),
  permissionPreset: z.enum(['plan', 'standard', 'full-access']),
}).strict();
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
const command = <T extends 'agent.create' | 'agent.submit'>(type: T) => z.custom<DaemonCommandEnvelope<T>>(value => {
  try { const parsed = parseDaemonCommand(value); return parsed.type === type && (parsed.principal.kind === 'desktop' || parsed.principal.kind === 'android'); }
  catch { return false; }
});
/** Exact envelopes survive each boundary. Loading this record never executes it. */
export const ConversationStartSchema = z.object({
  id: z.string().min(1), prompt: z.string().max(65_536), context: ChatMessageContextSchema.optional(),
  settings: ConversationSettingsSchema, conversationId: z.string().optional(), sessionId: z.string().optional(),
  create: command('agent.create').optional(), resume: HistoryResumeRequestSchema.optional(), submit: command('agent.submit').optional(),
  accepted: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.create && (value.conversationId || value.resume)) invalid('A continuation cannot create a new conversation.');
  if (value.resume && value.resume.conversationId !== value.conversationId) invalid('Continuation identity does not match.');
  if (value.create && (value.create.payload.initialPrompt !== undefined || value.create.payload.providerId !== value.settings.providerId
    || value.create.payload.workspaceId !== value.settings.workspaceId || value.sessionId && value.create.payload.sessionId !== value.sessionId)) invalid('Creation envelope does not match the conversation.');
  if (value.submit && (value.submit.payload.sessionId !== value.sessionId || value.submit.payload.prompt !== value.prompt
    || JSON.stringify(value.submit.payload.context) !== JSON.stringify(value.context))) invalid('Submission envelope does not match the saved message.');
  if (value.accepted && (!value.sessionId || !value.submit)) invalid('Accepted message is missing its receipt identity.');
});
export type ConversationStart = z.infer<typeof ConversationStartSchema>;
export function conversationOperationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}
