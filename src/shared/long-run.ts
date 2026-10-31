/**
 * 시안 (2026-11-01): draft types for bundle 3, long-run continuity. Nothing here is a contract yet: no host writes
 * these, there is no protocol command, payload schema or capability, and only Storybook fixtures fill them. The real
 * shapes are decided when the host is wired, after the draft is approved. What they rest on (and what was never seen,
 * above all a real limit): docs/ux/overhaul/approvals.md ("장시간 연속성").
 */

/** The window that stopped a turn; `unknown` when the provider did not say which. */
export type UsageLimitWindow = 'five-hour' | 'weekly' | 'unknown';

export type UsageLimitPhase =
  /** The reset is known and within hours: the app tries by sending "Continue." at `resumeAt`. */
  | 'waiting'
  /** It is being sent now. */
  | 'resuming'
  /** It went out; the row after the card shows exactly what. */
  | 'resumed'
  /** Refused although the reset had passed: one later try at `retryAt`. */
  | 'retrying'
  /** Refused twice: the app stops and asks. */
  | 'gave-up'
  /** The reset is days away, or the person chose to be asked (D2): nothing goes out until they say so. */
  | 'ask-reset'
  /** They said 그때 이어서 하기: waits for `resumeAt`, however far off. */
  | 'scheduled'
  /** No reset time is known. */
  | 'ask-unknown'
  /** The reset passed while the app was closed (D5). */
  | 'ask-reopened'
  /** They turned automatic resume off on this card, for this conversation only. */
  | 'off'
  /** They left it (그대로 두기). */
  | 'left'
  /** They sent a message before the app did. */
  | 'cancelled'
  /** An approval was open when the time came. */
  | 'skipped'
  /** `usage_not_included`: the plan cannot use this at all, and nothing resets. */
  | 'not-included'
  /** A child conversation: offered, never automatic (D7). */
  | 'child'
  /** The send itself failed; nothing went out. */
  | 'failed';

/** One stopped turn's limit: the host knows the window and usually the reset. */
export interface TurnUsageLimit {
  readonly turnId: string;
  readonly providerId: string;
  readonly phase: UsageLimitPhase;
  readonly window: UsageLimitWindow;
  readonly stoppedAt: string;
  /** What the provider said; absent when it did not say. */
  readonly resetsAt?: string;
  /** When the app will send, or did. */
  readonly resumeAt?: string;
  /** `retrying`: when the one later try goes. */
  readonly retryAt?: string;
  /** `retrying`, `gave-up`: when the last try was refused. */
  readonly refusedAt?: string;
  /** `waiting`: when 지금 시도 was refused; that refused turn stays in the conversation. */
  readonly triedAt?: string;
  /** D6: several conversations resume one at a time. */
  readonly line?: { readonly position: number; readonly total: number };
  /** `failed`: why nothing went out, in the app's words. */
  readonly failure?: 'disconnected' | 'session-gone';
}

/** The one thing the app sends by itself. Measured: it is read once and the stopped prompt is not read twice. */
export const RESUME_TEXT = 'Continue.';

/** Why a "Continue." went out: its scheduled time came (nothing says the limit has lifted), or the person pressed 지금 시도 or 이어서 하기. */
export type AppSentReason = 'scheduled-time' | 'try-now' | 'resume-pressed';

export type SteerDelivery =
  /** The host took it; the turn has not. A long tool holds it. */
  | 'on-its-way'
  /** An open approval holds it; it lands after the answer. */
  | 'behind-approval'
  /** The host says it did not get there. */
  | 'failed'
  /** The host cannot say: it may have been read. */
  | 'unconfirmed';

/** A message on its way into the running turn: it has no place in the transcript until it lands. */
export interface SteeredMessage {
  readonly id: string;
  readonly text: string;
  readonly state: SteerDelivery;
  readonly sentAt: string;
  /** What it waits for while on its way. */
  readonly behind?: 'tool' | 'text';
  /** `failed`: why, in the app's words. */
  readonly failure?: 'disconnected' | 'refused';
}

/**
 * It landed. At a tool's end it folds into the running turn. `rewritten`: Codex was writing, so what it had written was
 * dropped and asked for again, in the same turn. `newTurn`: Claude was writing, so that text ended its turn and the
 * message started the next one.
 */
export interface SteerLanding {
  readonly rewritten?: boolean;
  readonly newTurn?: boolean;
}

/** Why a message meant for the running turn went to the queue instead. */
export type SteerFallback = 'review-turn' | 'compact-turn' | 'turn-ended';

export interface LongRunSettings {
  /** 해제 예정 시각이 되면 자동으로 이어서 하기. */
  readonly autoResume: boolean;
}
