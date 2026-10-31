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
  /** Automatic resume went off, on this card (this conversation only) or in Settings (`offBy`). */
  | 'off'
  /** They left it (그대로 두기). */
  | 'left'
  /** They sent a message before the app did, and it went through. */
  | 'cancelled'
  /** They sent a message before the reset and the limit refused it: it stays in the session, and auto-resume is off. */
  | 'person-refused'
  /** An approval was open when the time came. */
  | 'skipped'
  /** `usage_not_included`: the plan cannot use this at all, and nothing resets. */
  | 'not-included'
  /** A child conversation: offered, never automatic (D7). */
  | 'child'
  /** The host confirms the send failed and nothing went out. */
  | 'failed'
  /** The host cannot say whether "Continue." arrived. */
  | 'unconfirmed';

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
  /** `off`: where it was turned off; Settings has its own way back. */
  readonly offBy?: 'card' | 'setting';
  /** `waiting`: when 지금 시도 was refused; that refused turn stays in the conversation. */
  readonly triedAt?: string;
  /** D6: several conversations resume one at a time. */
  readonly line?: { readonly position: number; readonly total: number };
  /** `failed`: why nothing went out, in the app's words. */
  readonly failure?: 'disconnected' | 'session-gone';
}

/**
 * The decided timing (D2, D4, D6). Proposed values, not measured: only Claude's whole 10 minutes is, and that no signal
 * comes when a limit lifts. So `afterResetMs` is a try after the expected time, never a promise that it worked.
 */
export const RESUME_TIMING = { afterResetMs: 2 * 60_000, retryAfterRefusalMs: 10 * 60_000, lineGapMs: 60_000 } as const;

/** Whether the app may send "Continue." by itself now: only a state that waits on a clock, once that time has come. */
export function resumeDue(limit: TurnUsageLimit, now: number): boolean {
  const clock = limit.phase === 'retrying' ? limit.retryAt : limit.phase === 'waiting' || limit.phase === 'scheduled' ? limit.resumeAt : undefined;
  return clock !== undefined && Date.parse(clock) <= now;
}

/** The setting turned off: a schedule that has not gone out is cancelled and the card is left to the person. */
export function turnAutoResumeOff(limit: TurnUsageLimit): TurnUsageLimit {
  return limit.phase === 'waiting' || limit.phase === 'scheduled' || limit.phase === 'retrying' ? { ...limit, phase: 'off', offBy: 'setting' } : limit;
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
  /** The host confirms it landed. The only state that may say so: leaving the list proves nothing. */
  | 'landed'
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
  /** `unconfirmed`: what ended the turn before it landed. A refused prompt stays in the session, so it may yet be read. */
  readonly caught?: 'stop' | 'limit';
}

/**
 * It landed. At a tool's end it folds into the running turn. `rewritten`: Codex was writing, so what it had written was
 * dropped and asked for again, in the same turn. `newTurn`: Claude was writing, so that text ended its turn and the
 * message started the next one.
 */
export interface SteerLanding {
  readonly rewritten?: boolean;
  readonly newTurn?: boolean;
  /** It landed in a turn the limit then refused: it stays in the session and is read when this continues. */
  readonly refused?: boolean;
}

/** Why a message meant for the running turn went to the queue instead. */
export type SteerFallback = 'review-turn' | 'compact-turn' | 'turn-ended';

export interface LongRunSettings {
  /** 해제 예정 시각이 되면 자동으로 이어서 하기. */
  readonly autoResume: boolean;
}
