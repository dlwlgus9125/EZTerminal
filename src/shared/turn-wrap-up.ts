/**
 * Turn wrap-up (Claude desktop features, bundle 2) — draft shapes for the 시안 (2026-10-30).
 *
 * What a conversation shows when a turn ends: the AI's guess of the person's next message (ghost text in the
 * empty composer, a chip on the phone), a recap card for a turn nobody was watching (or one that stopped to
 * wait on the person), and the tasks the AI proposed outside its own work. The AI only proposes; nothing runs
 * until the person presses a button.
 *
 * Draft only: no host writes these yet. The stories feed fixtures and every action is a callback. The
 * transcript payload schemas, daemon commands and the capability come after the draft is approved
 * (docs/ux/overhaul/approvals.md, "턴 마무리").
 */

/** What the host will hold `suggest_task` calls to, and how many one turn may leave. */
export const TASK_SUGGESTION_LIMITS = { perTurn: 8, title: 120, prompt: 4_000, rationale: 500 } as const;

/** The AI's guess of the person's next message. One per turn; shown only while its turn is the newest one. */
export interface NextPromptSuggestion {
  readonly turnId: string;
  readonly text: string;
}

/** Why the host wrote a recap: the turn ended while no screen showed the conversation, or it stopped for the person. */
export type TurnRecapTrigger = 'unattended' | 'waiting';

/** What the AI waits on when it stopped for the person. */
export type TurnRecapWaiting = 'approval' | 'question' | 'plan';

import type { ChatAgentSettings } from './chat-agent-profiles';

/** Why a recap could not be written, as a code the app words itself. */
export type TurnRecapFailure = 'usage-limit' | 'disconnected' | 'no-response';

/** A recap of one turn, written by the conversation's AI (the /btw path: no tools, nothing saved to the conversation). */
export interface TurnRecap {
  readonly turnId: string;
  readonly providerId: string;
  readonly trigger: TurnRecapTrigger;
  readonly state: 'generating' | 'complete' | 'failed';
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

/** Where a started task works: this conversation's folder, or a new worktree on a new branch (desktop only). */
export type SuggestedTaskWhere = { readonly kind: 'this-folder' } | { readonly kind: 'new-worktree'; readonly branch: string };

const TRAILING_FILLER = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'src', 'the', 'to']);
const BRANCH_SLUG_LENGTH = 32;

/**
 * `suggest/<slug>` from a task's title: its ASCII words up to 32 characters (a path counts as its file's name), without
 * a dangling filler word, or `suggest/task-<n>` when the title has none (a Korean title). Callers keep one batch distinct.
 */
export function suggestedTaskBranch(title: string, index: number): string {
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
  return `suggest/${kept.length ? kept.join('-') : `task-${String(index + 1)}`}`;
}

/** One branch per task of a batch, numbered when two titles give the same name. */
export function suggestedTaskBranches(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title, index) => {
    const branch = suggestedTaskBranch(title, index);
    const count = (seen.get(branch) ?? 0) + 1;
    seen.set(branch, count);
    return count === 1 ? branch : `${branch}-${String(count)}`;
  });
}

/** Settings › 에이전트 › 턴 마무리. */
export interface TurnWrapUpSettings {
  /** 다음 입력 제안, per AI. */
  readonly suggestions: Readonly<Record<'claude' | 'codex', boolean>>;
  readonly recaps: boolean;
  readonly tasks: boolean;
  /** Stop the automatic calls (suggestions, recaps) while a usage window is at the danger level (90% or more). */
  readonly pauseNearLimit: boolean;
}

/** A usage window at the danger level that pauses the automatic calls until it resets. */
export interface TurnWrapUpPause {
  readonly providerId: string;
  readonly window: 'five-hour' | 'weekly';
  readonly usedPercent: number;
  /** When the window resets, epoch ms. */
  readonly resetsAt?: number;
}
