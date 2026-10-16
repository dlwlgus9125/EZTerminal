import { z } from 'zod';

/**
 * What a pending approval is actually asking for, so the approval card can show
 * the command, the files and diff, the question options or the plan instead of
 * only "Claude requests Bash". `DaemonApproval.title`/`detail` stay populated
 * for hosts and clients that predate this (`approval-request-v1`).
 *
 * Every body is bounded: approvals travel inside the daemon snapshot.
 */

const Short = z.string().max(2_000);
const Body = z.string().max(16_000);

const ApprovalFileSchema = z.object({
  path: Short,
  kind: z.enum(['add', 'update', 'delete', 'rename']).optional(),
  diff: Body.optional(),
}).strict();

const QuestionOptionSchema = z.object({ label: Short, description: Short.optional() }).strict();
const QuestionSchema = z.object({
  question: Short,
  header: Short.optional(),
  multiSelect: z.boolean(),
  options: z.array(QuestionOptionSchema).max(8),
}).strict();

const Base = { v: z.literal(1), callId: Short.optional() };

export const ApprovalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('command'), command: Body, cwd: Short.optional(), reason: Short.optional() }).strict(),
  z.object({ ...Base, kind: z.literal('file-change'), files: z.array(ApprovalFileSchema).max(50), reason: Short.optional() }).strict(),
  z.object({ ...Base, kind: z.literal('tool'), toolName: Short, target: Short.optional(), input: Body.optional() }).strict(),
  z.object({ ...Base, kind: z.literal('question'), questions: z.array(QuestionSchema).min(1).max(4) }).strict(),
  z.object({ ...Base, kind: z.literal('plan'), markdown: Body.optional(), filePath: Short.optional() }).strict(),
]);

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalQuestion = z.infer<typeof QuestionSchema>;

export function parseApprovalRequest(value: unknown): ApprovalRequest | undefined {
  const parsed = ApprovalRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The richer answer a card can give beyond allow/deny. Sent only to hosts that
 * advertise `approval-response-v1`; older hosts reject unknown fields.
 */
export const ApprovalResponseSchema = z.discriminatedUnion('kind', [
  /** AskUserQuestion: question text → chosen label(s) or free text. */
  z.object({ kind: z.literal('answers'), answers: z.record(Short, Short) }).strict(),
  /** Plan approval: continue implementing in this permission mode. */
  z.object({ kind: z.literal('plan'), mode: z.enum(['standard', 'full-access']) }).strict(),
  /** Deny with guidance the agent receives as the tool result. */
  z.object({ kind: z.literal('feedback'), message: z.string().min(1).max(4_000) }).strict(),
]);

export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export const APPROVAL_REQUEST_CAPABILITY = 'approval-request-v1';
export const APPROVAL_RESPONSE_CAPABILITY = 'approval-response-v1';

/** Clip a body to the schema bound without splitting a surrogate pair. */
export function clipApprovalBody(value: string, limit = 16_000): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}
