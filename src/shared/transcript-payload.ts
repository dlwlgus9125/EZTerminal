import { z } from 'zod';

import { REVIEW_LIMITS, REVIEW_SEVERITIES, REVIEW_STATES } from './review-findings';

/**
 * Structured metadata that rides next to a transcript item's `text`.
 *
 * `text` stays the authoritative, human-readable body (command output, diff
 * envelope, message markdown) so old hosts, old clients and the archive keep
 * working unchanged. The payload only adds what a renderer needs to present a
 * tool call well: identity for call/result pairing, a category for the icon and
 * verb, a short target, and status/exit/timing. Hosts advertise it with the
 * `transcript-payload-v1` capability; clients must treat a missing or invalid
 * payload as "legacy item" and fall back to decoding `text`.
 */

export const TOOL_CATEGORIES = [
  'read', 'search', 'list', 'command', 'edit', 'write', 'web', 'mcp', 'agent', 'todo', 'question', 'plan', 'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const TOOL_STATUSES = ['running', 'completed', 'failed', 'denied', 'interrupted'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

const ShortText = z.string().max(2_000);

const ToolFileSchema = z.object({
  path: ShortText,
  kind: z.enum(['add', 'update', 'delete', 'rename']).optional(),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
}).strict();

const ToolPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('tool'),
  /** Provider tool-use id; pairs the call row with its result row. */
  callId: ShortText,
  /** Provider tool name, e.g. `Bash`, `Read`, `mcp__github__search`, `commandExecution`. */
  name: ShortText,
  category: z.enum(TOOL_CATEGORIES),
  phase: z.enum(['call', 'result']),
  status: z.enum(TOOL_STATUSES).optional(),
  /** Short subject: a path, a pattern, a URL host+path, or a command summary. */
  target: ShortText.optional(),
  command: z.string().max(8_000).optional(),
  cwd: ShortText.optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  files: z.array(ToolFileSchema).max(200).optional(),
  query: ShortText.optional(),
  server: ShortText.optional(),
  /** Output was cut at the host before storage. */
  truncated: z.boolean().optional(),
}).strict();

const TodoItemSchema = z.object({
  text: ShortText,
  status: z.enum(['pending', 'in_progress', 'completed']),
  active: ShortText.optional(),
}).strict();

const TodoPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('todo'),
  source: z.enum(['claude-todowrite', 'codex-plan']),
  items: z.array(TodoItemSchema).max(100),
  explanation: ShortText.optional(),
}).strict();

const ReasoningPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('reasoning'),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

const PlanPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('plan'),
  markdown: z.string().max(64_000).optional(),
  filePath: ShortText.optional(),
}).strict();

/**
 * A provider-native subagent's place in its parent and its own transcript:
 * `link` (parent: the child started, joined to the call that started it),
 * `result` (parent: the child's bounded final answer) and `instruction` (the
 * child's first row: what the parent asked). Clients without this variant drop
 * the payload and show the row's text, which is written to read on its own.
 */
const SubagentPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('subagent'),
  role: z.enum(['link', 'result', 'instruction']),
  /** Provider call that started the child (Claude Agent tool use, Codex spawn item). */
  callId: ShortText.optional(),
  childSessionId: ShortText.optional(),
  parentSessionId: ShortText.optional(),
  title: ShortText.optional(),
  /** Provider's agent kind, e.g. Claude `Explore`. */
  subagentType: ShortText.optional(),
  background: z.boolean().optional(),
  state: z.enum(['done', 'error']).optional(),
  /** A delegated child's first row: send its first finished result to the parent once. */
  reportBack: z.boolean().optional(),
}).strict();

const ReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }).strict(),
  z.object({ kind: z.literal('base-branch'), baseRef: ShortText }).strict(),
]);

const ReviewFindingSchema = z.object({
  id: ShortText,
  file: ShortText,
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().max(REVIEW_LIMITS.title),
  body: z.string().max(REVIEW_LIMITS.body),
  scenario: z.string().max(REVIEW_LIMITS.scenario).optional(),
  category: z.string().max(REVIEW_LIMITS.category).optional(),
  severity: z.enum(REVIEW_SEVERITIES).optional(),
  excerpt: z.object({
    startLine: z.number().int().positive(),
    lines: z.array(z.string().max(REVIEW_LIMITS.excerptLineChars)).max(REVIEW_LIMITS.excerptLines),
  }).strict().optional(),
}).strict();

/**
 * One review card (review loop, `review-loop-v1`). The host appends rows with the
 * same `reviewId` as the review moves on (queued → running → complete/failed/…);
 * clients show one card per id from its latest row. The row's `text` reads on its own.
 */
const ReviewPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('review'),
  reviewId: ShortText,
  reviewer: z.object({
    mode: z.enum(['self', 'other']),
    providerId: ShortText,
    sessionId: ShortText.optional(),
    model: ShortText.optional(),
  }).strict(),
  target: ReviewTargetSchema,
  state: z.enum(REVIEW_STATES),
  reason: ShortText.optional(),
  focus: z.string().max(REVIEW_LIMITS.focus).optional(),
  findings: z.array(ReviewFindingSchema).max(REVIEW_LIMITS.findings).optional(),
  overall: z.string().max(REVIEW_LIMITS.overall).optional(),
  truncated: z.boolean().optional(),
  dropped: z.number().int().nonnegative().optional(),
  rawText: z.string().max(REVIEW_LIMITS.rawText).optional(),
  wroteFiles: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

const FindingIdsSchema = z.array(ShortText).min(1).max(REVIEW_LIMITS.findings);

/** A person dismissed or reopened findings on a card; nothing is sent to the AI. */
const ReviewStatusPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('review-status'),
  reviewId: ShortText,
  findingIds: FindingIdsSchema,
  state: z.enum(['dismissed', 'open']),
}).strict();

/** The user row of a fix turn ("fix this one" / "fix all"); the fix's state is that turn's. */
const ReviewFixPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('review-fix'),
  reviewId: ShortText,
  findingIds: FindingIdsSchema,
}).strict();

/** The first user row of an other-AI reviewer conversation. */
const ReviewRequestPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('review-request'),
  reviewId: ShortText,
  target: ReviewTargetSchema,
  focus: z.string().max(REVIEW_LIMITS.focus).optional(),
}).strict();

export const TranscriptPayloadSchema = z.discriminatedUnion('type', [
  ToolPayloadSchema,
  TodoPayloadSchema,
  ReasoningPayloadSchema,
  PlanPayloadSchema,
  SubagentPayloadSchema,
  ReviewPayloadSchema,
  ReviewStatusPayloadSchema,
  ReviewFixPayloadSchema,
  ReviewRequestPayloadSchema,
]);

export type TranscriptPayload = z.infer<typeof TranscriptPayloadSchema>;
export type ToolPayload = z.infer<typeof ToolPayloadSchema>;
export type TodoPayload = z.infer<typeof TodoPayloadSchema>;
export type ReasoningPayload = z.infer<typeof ReasoningPayloadSchema>;
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;
export type SubagentPayload = z.infer<typeof SubagentPayloadSchema>;
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;
export type ReviewStatusPayload = z.infer<typeof ReviewStatusPayloadSchema>;
export type ReviewFixPayload = z.infer<typeof ReviewFixPayloadSchema>;
export type ReviewRequestPayload = z.infer<typeof ReviewRequestPayloadSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** Tolerant parse: unknown versions and malformed values become `undefined`. */
export function parseTranscriptPayload(value: unknown): TranscriptPayload | undefined {
  const parsed = TranscriptPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const TRANSCRIPT_PAYLOAD_CAPABILITY = 'transcript-payload-v1';
