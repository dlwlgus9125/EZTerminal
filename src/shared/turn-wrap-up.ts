/**
 * Turn wrap-up's provider-neutral model (Claude desktop features, bundle 2).
 *
 * What a conversation shows when a turn ends: the AI's guess of the person's next message (ghost text in the
 * empty composer, a chip on the phone), a recap card for a turn nobody was watching (or one that stopped to
 * wait on the person), and the tasks the AI proposed outside its own work. The AI only proposes; nothing runs
 * until the person presses a button. Measured facts and decisions: docs/ux/overhaul/approvals.md ("턴 마무리").
 *
 * The instructions below are the source of truth; scripts/wrap-up-probe-kit.mjs keeps a copy because scripts
 * run as plain JavaScript, and the replay tests check recordings against these.
 */

import { z } from 'zod';

import type { ChatAgentSettings } from './chat-agent-profiles';

export const TURN_WRAP_UP_CAPABILITY = 'turn-wrap-up-v1';

/** What the host holds `suggest_task` calls to, and how many one turn may leave. */
export const TASK_SUGGESTION_LIMITS = { perTurn: 8, title: 120, prompt: 4_000, rationale: 500 } as const;

/** A recap is 3–4 lines; a longer answer is cut to this before it is stored. */
export const TURN_RECAP_LIMITS = { text: 2_000 } as const;

/** The AI is asked for 20 words at most; an answer past this is no next message. */
export const NEXT_PROMPT_MAX_CHARS = 500;

/** Host-composed; both AIs get the same text. Scoped because 3/6 Claude recaps wandered over the whole conversation (probe P5). */
export const RECAP_INSTRUCTION = 'Recap for the person, who was not watching this conversation. Cover their latest request and the work '
  + 'done for it, not the whole conversation. In 2-4 short lines: what you did, what is waiting on them, and what they should check. '
  + 'State only what actually happened in this conversation; never claim an action, file change or test that did not happen. '
  + 'Write in the language the person has been using. No preamble.';

/**
 * Host-composed: a fork of a stopped turn may show the open call as aborted, and without this Codex says it was. It goes
 * before the question, as it did in the probe (4/4 right, against 8/10 after `Question:`), through the side question's `note`.
 */
export const recapStoppedNote = (waiting: string): string => `Right now this turn is stopped, not finished: ${waiting} It is still open and waiting for the `
  + 'person. If your history shows that call as aborted or interrupted, that is only how this side view shows it; nothing was aborted.';

/** Codex's next-message fork; Claude predicts on its own. */
export const PREDICT_INSTRUCTION = "Predict the person's most likely next message to you in this conversation. Reply with "
  + 'that message only, exactly as they would type it, in their language, at most 20 words, with no quotes or explanation. '
  + 'If they are most likely done, reply with: (none)';

/** Codex proposes tasks only when told to (0/2 from the tool description alone, 2/2 with this, probe P4). */
export const SUGGEST_TASK_INSTRUCTIONS = 'When you notice work outside the current request (other bugs, missing tests, stale docs), '
  + 'do not do it; call the suggest_task tool with a self-contained prompt for each item instead.';

export const SUGGEST_TASK_TOOL = 'suggest_task';
/** The host's own MCP server, as both AIs name it. */
export const SUGGEST_TASK_SERVER = 'ezterminal_orchestration';
/** The exact name Claude's `allowedTools` needs: a per-tool MCP policy still asks (probe P4). */
export const SUGGEST_TASK_CLAUDE_TOOL = `mcp__${SUGGEST_TASK_SERVER}__${SUGGEST_TASK_TOOL}`;

/** The composer's one line from the AI's answer; `(none)`, nothing, or an answer too long for a next message is no suggestion. */
export function nextPromptText(raw: string | null | undefined): string | undefined {
  const line = raw?.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
  if (!line || /^\(?none\)?\.?$/iu.test(line) || line.length > NEXT_PROMPT_MAX_CHARS) return undefined;
  return line;
}

/** The AI's guess of the person's next message. One per turn; shown only while its turn is the newest one. */
export interface NextPromptSuggestion {
  readonly turnId: string;
  readonly text: string;
}

/** Why the host wrote a recap: the turn ended while no screen showed the conversation, or it stopped for the person. */
export const TURN_RECAP_TRIGGERS = ['unattended', 'waiting'] as const;
export type TurnRecapTrigger = (typeof TURN_RECAP_TRIGGERS)[number];

/** What the AI waits on when it stopped for the person. */
export const TURN_RECAP_WAITING = ['approval', 'question', 'plan'] as const;
export type TurnRecapWaiting = (typeof TURN_RECAP_WAITING)[number];

/** Why a recap could not be written, as a code the app words itself. */
export const TURN_RECAP_FAILURES = ['usage-limit', 'disconnected', 'no-response'] as const;
export type TurnRecapFailure = (typeof TURN_RECAP_FAILURES)[number];

export const TURN_RECAP_STATES = ['generating', 'complete', 'failed'] as const;

/** A recap of one turn, written by the conversation's AI (the /btw path: no tools, nothing added to the AI's context). */
export interface TurnRecap {
  readonly turnId: string;
  readonly providerId: string;
  readonly trigger: TurnRecapTrigger;
  readonly state: (typeof TURN_RECAP_STATES)[number];
  /** The AI's own lines (3–4; inline code allowed). */
  readonly text?: string;
  /** Still waiting on the person when the recap was written. */
  readonly waiting?: TurnRecapWaiting;
  /** The decision it stopped for (the approval's id): the card says the AI waits only while that one is pending. */
  readonly decisionId?: string;
  /** Why it failed, when the host knows. */
  readonly failure?: TurnRecapFailure;
  readonly createdAt: string;
}

/** One `suggest_task` call: what the AI proposes, with the instruction exactly as it would be sent. */
export interface SuggestedTask {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  /** What a new sub-conversation (or this one, 여기서 하기) receives, word for word. */
  readonly prompt: string;
  /** The AI recommends a new worktree for it. */
  readonly worktree?: boolean;
}

/** What a start asked for. A failed start keeps it, so 다시 시도 repeats exactly that and never drifts to the defaults. */
export interface SuggestedTaskStart {
  readonly where: SuggestedTaskWhere;
  /** The AI, model, effort and permission it asked for. */
  readonly agent: ChatAgentSettings;
  /** The same in words, as the person saw it (`Claude · Opus 5.5 · 높음 · 승인 후 실행`). */
  readonly settings: string;
}

/** What a `task-suggestion-status` row records; the card's other outcomes come from the turn rows and the client. */
export const TASK_SUGGESTION_OUTCOMES = ['started', 'dismissed', 'open', 'start-failed'] as const;

/**
 * What came of a suggested task, as the host confirms it: nothing yet, a start or send in flight, a sub-conversation
 * started (in a new worktree when `branch` is set), sent to this conversation or queued behind its running turn
 * (`position` only when the host gave one), dismissed, or a start the host refused with its reason and what was asked
 * for (`branchTaken`: the branch name exists, so a retry needs another name).
 */
export type SuggestedTaskOutcome =
  | { readonly kind: 'open' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'started'; readonly sessionId: string; readonly branch?: string }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'queued'; readonly position?: number }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'start-failed'; readonly reason: string; readonly start: SuggestedTaskStart; readonly branchTaken?: boolean };

export type SuggestedTaskState = SuggestedTask & { readonly outcome: SuggestedTaskOutcome };

/** The tasks one turn suggested: one card after that turn's last message. */
export interface TurnTaskSuggestions {
  readonly turnId: string;
  readonly providerId: string;
  readonly tasks: readonly SuggestedTaskState[];
  /** Calls past `TASK_SUGGESTION_LIMITS.perTurn` the host left out. */
  readonly dropped?: number;
  readonly createdAt: string;
}

/**
 * Where a started task works: this conversation's folder, or a new worktree on a new branch (desktop only).
 * `workspaceId`: the worktree a failed start already made, so a retry does not collide with its own branch.
 */
export type SuggestedTaskWhere =
  | { readonly kind: 'this-folder' }
  | { readonly kind: 'new-worktree'; readonly branch: string; readonly workspaceId?: string };

const TRAILING_FILLER = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'src', 'the', 'to']);
const BRANCH_SLUG_LENGTH = 32;
const BRANCH_ID_LENGTH = 8;

/**
 * `suggest/<slug>` from a task's title: its ASCII words up to 32 characters (a path counts as its file's name), without
 * a dangling filler word. A title with none (a Korean one) takes `suggest/task-<short id>` from the task's id, which is
 * unique to its turn: a position in the batch would collide with the next batch's. Callers keep one batch distinct.
 */
export function suggestedTaskBranch({ id, title }: Pick<SuggestedTask, 'id' | 'title'>): string {
  const words = title
    .replace(/(?:[\w.-]+\/)+/gu, '')
    .replace(/\.(?:tsx?|jsx?|mjs|cjs|json|md|css)\b/giu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().split(' ').filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if ([...kept, word].join('-').length > BRANCH_SLUG_LENGTH) break;
    kept.push(word);
  }
  while (kept.length && TRAILING_FILLER.has(kept[kept.length - 1]!)) kept.pop();
  const shortId = id.replace(/^task-/u, '').toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, BRANCH_ID_LENGTH);
  return `suggest/${kept.length ? kept.join('-') : `task-${shortId}`}`;
}

/** One branch per task of a batch, numbered when two titles give the same name. */
export function suggestedTaskBranches(tasks: readonly Pick<SuggestedTask, 'id' | 'title'>[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((task) => {
    const branch = suggestedTaskBranch(task);
    const count = (seen.get(branch) ?? 0) + 1;
    seen.set(branch, count);
    return count === 1 ? branch : `${branch}-${String(count)}`;
  });
}

const SUGGESTED_TASK_SESSION_PREFIX = 'suggested-';

/**
 * The sub-conversation a task starts, from its id alone: a second press or another device reaches the same
 * conversation and is refused as one that already exists, so a task cannot start twice.
 */
export const suggestedTaskChildSessionId = (taskId: string): string => `${SUGGESTED_TASK_SESSION_PREFIX}${taskId}`;

/** A person started this child from a card, and may then chat in it: no AI names a child this way. */
export const isSuggestedTaskChildSession = (sessionId: string): boolean => sessionId.startsWith(SUGGESTED_TASK_SESSION_PREFIX);

/** Settings › 에이전트 › 턴 마무리. */
export interface TurnWrapUpSettings {
  /** 다음 입력 제안, per AI. */
  readonly suggestions: Readonly<Record<'claude' | 'codex', boolean>>;
  readonly recaps: boolean;
  readonly tasks: boolean;
  /** Stop the automatic calls (suggestions, recaps) while a usage window is at the danger level (90% or more). */
  readonly pauseNearLimit: boolean;
}

export const DEFAULT_TURN_WRAP_UP_SETTINGS: TurnWrapUpSettings = {
  suggestions: { claude: true, codex: true }, recaps: true, tasks: true, pauseNearLimit: true,
};

export const TurnWrapUpSettingsSchema = z.object({
  suggestions: z.object({ claude: z.boolean(), codex: z.boolean() }).strict(),
  recaps: z.boolean(),
  tasks: z.boolean(),
  pauseNearLimit: z.boolean(),
}).strict();

export function parseTurnWrapUpSettings(value: unknown): TurnWrapUpSettings | undefined {
  const parsed = TurnWrapUpSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A usage window at the danger level that pauses the automatic calls until it resets. */
export interface TurnWrapUpPause {
  readonly providerId: string;
  readonly window: 'five-hour' | 'weekly';
  readonly usedPercent: number;
  /** When the window resets, epoch ms. */
  readonly resetsAt?: number;
}
