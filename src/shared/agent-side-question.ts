import { z } from 'zod';

/**
 * /btw — a side question about a live conversation. The provider answers once,
 * from the conversation's existing context, without tools; neither the question
 * nor the answer becomes a turn, a transcript item or stored state anywhere.
 * Earlier side questions of the same thread travel along as `history` (the
 * client owns that thread, in memory only).
 */

export const SIDE_QUESTION_MAX_QUESTION_CHARS = 4_000;
export const SIDE_QUESTION_MAX_ANSWER_CHARS = 20_000;
export const SIDE_QUESTION_HISTORY_LIMIT = 20;
/** Whole-history budget; ×3 UTF-8 bytes stays under the 1 MiB remote frame cap. */
export const SIDE_QUESTION_HISTORY_MAX_CHARS = 120_000;
export const SIDE_QUESTION_HOST_TIMEOUT_MS = 300_000;
/** Providers whose adapter answers side questions (renderer reason text only; the host decides). */
export const SIDE_QUESTION_PROVIDER_IDS: readonly string[] = ['claude', 'codex'];

export interface SideQuestionExchange {
  readonly question: string;
  readonly answer: string;
  readonly fallbackNotice?: string;
}

export interface AgentSideQuestionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly question: string;
  readonly history: readonly SideQuestionExchange[];
}

export type AgentSideQuestionErrorCode =
  | 'invalid'
  | 'not-live'
  | 'unsupported'
  | 'busy'
  | 'session-restarted'
  | 'cancelled'
  | 'timeout'
  | 'unavailable'
  | 'failed';

/** No error text: a provider message could echo the question. */
export type AgentSideQuestionResult =
  | { readonly ok: true; readonly answer: string | null; readonly synthetic: boolean; readonly fallbackNotice?: string }
  | { readonly ok: false; readonly code: AgentSideQuestionErrorCode };

export interface AgentSideQuestionClient {
  ask(input: Omit<AgentSideQuestionRequest, 'requestId'>, signal: AbortSignal): Promise<AgentSideQuestionResult>;
}

const historyChars = (history: readonly SideQuestionExchange[]): number =>
  history.reduce((total, entry) => total + entry.question.length + entry.answer.length + (entry.fallbackNotice?.length ?? 0), 0);

export const SideQuestionExchangeSchema = z.object({
  question: z.string().min(1).max(SIDE_QUESTION_MAX_QUESTION_CHARS),
  answer: z.string().max(SIDE_QUESTION_MAX_ANSWER_CHARS),
  fallbackNotice: z.string().max(400).optional(),
}).strict();

export const AgentSideQuestionRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256),
  question: z.string().max(SIDE_QUESTION_MAX_QUESTION_CHARS).refine((value) => value.trim().length > 0),
  history: z.array(SideQuestionExchangeSchema).max(SIDE_QUESTION_HISTORY_LIMIT)
    .refine((history) => historyChars(history) <= SIDE_QUESTION_HISTORY_MAX_CHARS),
}).strict();

export const AgentSideQuestionResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    answer: z.string().max(SIDE_QUESTION_MAX_ANSWER_CHARS).nullable(),
    synthetic: z.boolean(),
    fallbackNotice: z.string().max(400).optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid', 'not-live', 'unsupported', 'busy', 'session-restarted', 'cancelled', 'timeout', 'unavailable', 'failed']),
  }).strict(),
]);

/** The newest exchanges that fit: at most 20, then oldest dropped until within the budget. */
export function boundedSideQuestionHistory(entries: readonly SideQuestionExchange[]): SideQuestionExchange[] {
  const newest = entries.slice(-SIDE_QUESTION_HISTORY_LIMIT);
  while (newest.length && historyChars(newest) > SIDE_QUESTION_HISTORY_MAX_CHARS) newest.shift();
  return newest;
}
