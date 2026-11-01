import { z } from 'zod';

import { ChatAgentProfileSchema } from './chat-agent-profiles';
import { APP_SENT_REASONS, STEER_FALLBACKS, USAGE_LIMIT_CHILD_KINDS, USAGE_LIMIT_FAILURES, USAGE_LIMIT_PHASES, USAGE_LIMIT_WINDOWS } from './long-run';
import { REVIEW_LIMITS, REVIEW_SEVERITIES, REVIEW_STATES } from './review-findings';
import {
  TASK_SUGGESTION_LIMITS, TASK_SUGGESTION_OUTCOMES, TURN_RECAP_FAILURES, TURN_RECAP_LIMITS, TURN_RECAP_STATES, TURN_RECAP_TRIGGERS,
  TURN_RECAP_WAITING,
} from './turn-wrap-up';

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
  /** Queued: behind this conversation's running turn, or for a free run slot (too many conversations running). */
  waitingFor: z.enum(['turn', 'slot']).optional(),
  reason: ShortText.optional(),
  focus: z.string().max(REVIEW_LIMITS.focus).optional(),
  findings: z.array(ReviewFindingSchema).max(REVIEW_LIMITS.findings).optional(),
  overall: z.string().max(REVIEW_LIMITS.overall).optional(),
  truncated: z.boolean().optional(),
  dropped: z.number().int().nonnegative().optional(),
  /** Some finding text was cut to the limits; `rawText` then holds the reviewer's own answer. */
  clipped: z.boolean().optional(),
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

/**
 * One recap card (turn wrap-up, `turn-wrap-up-v1`). The host appends rows for the same turn as it moves on
 * (generating → complete/failed); clients show its latest row. The row's `text` reads on its own.
 */
const RecapPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('recap'),
  turnId: ShortText,
  providerId: ShortText,
  trigger: z.enum(TURN_RECAP_TRIGGERS),
  state: z.enum(TURN_RECAP_STATES),
  text: z.string().max(TURN_RECAP_LIMITS.text).optional(),
  waiting: z.enum(TURN_RECAP_WAITING).optional(),
  /** The approval it stopped for: the card says the AI waits only while that one is pending. */
  decisionId: ShortText.optional(),
  failure: z.enum(TURN_RECAP_FAILURES).optional(),
}).strict();

/** One `suggest_task` call the host accepted; nothing runs until the person starts it. */
const TaskSuggestionPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('task-suggestion'),
  taskId: ShortText,
  turnId: ShortText,
  providerId: ShortText,
  title: z.string().max(TASK_SUGGESTION_LIMITS.title),
  rationale: z.string().max(TASK_SUGGESTION_LIMITS.rationale),
  prompt: z.string().max(TASK_SUGGESTION_LIMITS.prompt),
  worktree: z.boolean().optional(),
}).strict();

/** What a refused start asked for: 다시 시도 repeats exactly that. */
export const SuggestedTaskStartSchema = z.object({
  where: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('this-folder') }).strict(),
    z.object({ kind: z.literal('new-worktree'), branch: ShortText, workspaceId: ShortText.optional() }).strict(),
  ]),
  agent: ChatAgentProfileSchema.pick({ providerId: true, model: true, reasoningEffort: true, permissionPreset: true }).strict(),
  /** The same in words, as the person saw it. */
  settings: ShortText,
}).strict();

/** What became of a task; clients show its latest row. */
const TaskSuggestionStatusPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('task-suggestion-status'),
  taskId: ShortText,
  turnId: ShortText,
  outcome: z.enum(TASK_SUGGESTION_OUTCOMES),
  /** `started`: the sub-conversation. */
  sessionId: ShortText.optional(),
  /** `started` in a new worktree. */
  branch: ShortText.optional(),
  /** `start-failed`: the host's words, what was asked for, and whether the branch name is taken. */
  reason: ShortText.optional(),
  start: SuggestedTaskStartSchema.optional(),
  branchTaken: z.boolean().optional(),
}).strict();

/** Calls past TASK_SUGGESTION_LIMITS.perTurn, written once when the turn ends. */
const TaskSuggestionsDroppedPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('task-suggestions-dropped'),
  turnId: ShortText,
  count: z.number().int().positive(),
}).strict();

/** The user row of a task sent to this conversation (여기서 하기); its state is that turn's. */
const TaskSuggestionSendPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('task-suggestion-send'),
  taskId: ShortText,
  turnId: ShortText,
}).strict();

/**
 * One limit card (long-run continuity, `long-run-v1`). The host appends rows with the same `stopId` as the stop moves
 * on; clients show one card per id from its latest row, placed at that row's turn. The row's `text` reads on its own.
 */
const UsageLimitPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('usage-limit'),
  stopId: ShortText,
  turnId: ShortText,
  providerId: ShortText,
  phase: z.enum(USAGE_LIMIT_PHASES),
  window: z.enum(USAGE_LIMIT_WINDOWS),
  stoppedAt: ShortText,
  resetsAt: ShortText.optional(),
  resumeAt: ShortText.optional(),
  retryAt: ShortText.optional(),
  refusedAt: ShortText.optional(),
  triedAt: ShortText.optional(),
  offBy: z.enum(['card', 'setting']).optional(),
  childKind: z.enum(USAGE_LIMIT_CHILD_KINDS).optional(),
  failure: z.enum(USAGE_LIMIT_FAILURES).optional(),
  sendReason: z.enum(APP_SENT_REASONS).optional(),
  sentAt: ShortText.optional(),
  chainEnded: z.literal(true).optional(),
}).strict();

/** The user row of a "Continue." the app sent: the row shows that text and says why it went out. */
const AppSentPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('app-sent'),
  stopId: ShortText,
  reason: z.enum(APP_SENT_REASONS),
}).strict();

/** The user row of a message that landed in a running turn, written where it landed. */
const SteerPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('steer'),
  rewritten: z.boolean().optional(),
  newTurn: z.boolean().optional(),
}).strict();

/** The user row of a message meant for the running turn that went to the queue, and why. */
const SteerQueuedPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('steer-queued'),
  reason: z.enum(STEER_FALLBACKS),
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
  RecapPayloadSchema,
  TaskSuggestionPayloadSchema,
  TaskSuggestionStatusPayloadSchema,
  TaskSuggestionsDroppedPayloadSchema,
  TaskSuggestionSendPayloadSchema,
  UsageLimitPayloadSchema,
  AppSentPayloadSchema,
  SteerPayloadSchema,
  SteerQueuedPayloadSchema,
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
export type RecapPayload = z.infer<typeof RecapPayloadSchema>;
export type TaskSuggestionPayload = z.infer<typeof TaskSuggestionPayloadSchema>;
export type TaskSuggestionStatusPayload = z.infer<typeof TaskSuggestionStatusPayloadSchema>;
export type TaskSuggestionsDroppedPayload = z.infer<typeof TaskSuggestionsDroppedPayloadSchema>;
export type TaskSuggestionSendPayload = z.infer<typeof TaskSuggestionSendPayloadSchema>;
export type UsageLimitPayload = z.infer<typeof UsageLimitPayloadSchema>;
export type AppSentPayload = z.infer<typeof AppSentPayloadSchema>;
export type SteerPayload = z.infer<typeof SteerPayloadSchema>;
export type SteerQueuedPayload = z.infer<typeof SteerQueuedPayloadSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** Tolerant parse: unknown versions and malformed values become `undefined`. */
export function parseTranscriptPayload(value: unknown): TranscriptPayload | undefined {
  const parsed = TranscriptPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const TRANSCRIPT_PAYLOAD_CAPABILITY = 'transcript-payload-v1';
