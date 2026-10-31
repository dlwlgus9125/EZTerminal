import type { SteerLanding, TurnUsageLimit, UsageLimitPhase } from '../../../shared/long-run';
import type { ChatLongRunAction } from '../ChatContext';
import { formatClock, type ChatCopy } from '../copy';
import type { ChatLocale } from '../model/summary';
import { providerName } from '../review/review-presentation';
import type { ActionCardNote, ActionCardState } from '../rows/ActionCard';

type LimitCopy = ChatCopy['longRun']['limit'];

const CARD_STATE: Readonly<Record<UsageLimitPhase, ActionCardState>> = {
  waiting: 'queued', scheduled: 'queued', retrying: 'queued', resuming: 'running', resumed: 'done',
  'gave-up': 'queued', 'ask-reset': 'queued', 'ask-unknown': 'queued', 'ask-reopened': 'queued',
  off: 'stopped', left: 'stopped', cancelled: 'stopped', skipped: 'stopped', child: 'stopped', 'not-included': 'unsupported', failed: 'failed',
};

/** The states that wait on the person. Everything else waits on a clock, or on nothing. */
const ASKS: ReadonlySet<UsageLimitPhase> = new Set(['gave-up', 'ask-reset', 'ask-unknown', 'ask-reopened']);

/** The quiet mark on a message that landed: how it landed, as the host confirmed it. */
export function steerMark(steer: SteerLanding, copy: ChatCopy['longRun']['steer']): string {
  if (steer.newTurn) return copy.landedNewTurn;
  return steer.rewritten ? `${copy.landed} · ${copy.rewritten}` : copy.landed;
}

/** Time today, or the day and time for a reset days away. */
export function formatWhen(iso: string, locale: ChatLocale, far = false): string {
  if (!far) return formatClock(iso, locale);
  const date = new Date(iso);
  const clock = formatClock(iso, locale);
  if (locale === 'ko') return `${String(date.getMonth() + 1)}월 ${String(date.getDate())}일 (${date.toLocaleDateString('ko-KR', { weekday: 'short' })}) ${clock}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${clock}`;
}

export interface LimitStatus {
  readonly text: string;
  /** It waits on the person: only these take the amber and 나를 기다리는 것. */
  readonly asks: boolean;
  /** Nothing is going to happen by itself and nothing asks. */
  readonly stopped: boolean;
}

/**
 * The state in the conversation list and the header. Waiting on a clock is not waiting on the person. Nothing once the
 * conversation has moved on: the state is then its turn's, as for any conversation.
 */
export function limitStatus(limit: TurnUsageLimit, copy: LimitCopy, locale: ChatLocale): LimitStatus | undefined {
  if (limit.phase === 'resumed' || limit.phase === 'cancelled') return undefined;
  if (ASKS.has(limit.phase)) return { text: copy.status.asks, asks: true, stopped: false };
  if (limit.phase === 'resuming') return { text: copy.status.resuming, asks: false, stopped: false };
  const clock = limit.phase === 'retrying' ? limit.retryAt : (limit.phase === 'waiting' || limit.phase === 'scheduled') ? limit.resumeAt : undefined;
  if (clock) return { text: copy.status.waiting(formatWhen(clock, locale, limit.phase === 'scheduled')), asks: false, stopped: false };
  return { text: copy.status.stopped, asks: false, stopped: true };
}

export type LimitActionId = ChatLongRunAction['kind'] | 'focus-decision';

export interface LimitActionView {
  readonly id: LimitActionId;
  readonly primary?: boolean;
  /** The name a screen reader hears when the words alone leave out the cost. */
  readonly ariaLabel?: string;
}

export interface LimitView {
  readonly state: ActionCardState;
  readonly stateText: string;
  readonly message: { readonly text: string; readonly tone?: 'danger'; readonly label?: string };
  readonly notes: readonly ActionCardNote[];
  readonly actions: readonly LimitActionView[];
}

const note = (id: string, text: string, tone?: ActionCardNote['tone']): ActionCardNote => ({ id, text, ...(tone ? { tone } : {}) });

/** What the card says and offers in each phase. The clock is the app's, the reset the provider's; nothing else is told. */
export function limitView(limit: TurnUsageLimit, copy: LimitCopy, locale: ChatLocale, approvalOpen = false): LimitView {
  const provider = providerName(limit.providerId);
  const windowName = copy.window[limit.window];
  const far = limit.window === 'weekly';
  const clock = (iso: string | undefined): string => (iso ? formatWhen(iso, locale, far) : '');
  const resets = limit.resetsAt ? copy.resets(windowName, clock(limit.resetsAt)) : windowName;
  const tryNow: LimitActionView = { id: 'limit-try-now', ariaLabel: copy.tryNowLabel };
  const autoOff: LimitActionView = { id: 'limit-auto-off', ariaLabel: copy.autoOffLabel };
  const resume: LimitActionView = { id: 'limit-resume', primary: true };
  const leave: LimitActionView = { id: 'limit-leave' };
  const base = { state: CARD_STATE[limit.phase], stateText: copy.state[limit.phase] };
  switch (limit.phase) {
    case 'waiting':
      return {
        ...base, message: { text: resets },
        notes: [
          note('plan', copy.resumesAt(clock(limit.resumeAt)), 'lead'),
          ...(limit.line ? [note('line', copy.line(limit.line.total, limit.line.position)), note('line-gap', copy.lineNote)] : []),
          note('sends', copy.sends),
          note('early', limit.triedAt ? copy.triedNow(clock(limit.triedAt)) : copy.earlyRefused),
        ],
        actions: [tryNow, autoOff],
      };
    case 'scheduled':
      return { ...base, message: { text: resets }, notes: [note('plan', copy.resumesAtManual(clock(limit.resumeAt)), 'lead'), note('sends', copy.sends)], actions: [{ id: 'limit-unschedule' }] };
    case 'resuming':
      return { ...base, message: { text: copy.sending }, notes: [], actions: [] };
    case 'resumed':
      return {
        ...base, message: { text: copy.sent(clock(limit.resumeAt)) },
        notes: [note('kept', copy.notResent)], actions: [],
      };
    case 'retrying':
      return {
        ...base, message: { text: copy.refused(clock(limit.refusedAt)) },
        notes: [note('plan', copy.retry(clock(limit.retryAt)), 'lead'), note('kept', copy.refusedKept)],
        actions: [autoOff],
      };
    case 'gave-up':
      return {
        ...base, message: { text: copy.gaveUp(clock(limit.refusedAt)) },
        notes: [note('kept', copy.refusedKept), note('now', copy.unknownNow)], actions: [resume, leave],
      };
    case 'ask-reset':
      return {
        ...base, message: { text: resets },
        notes: [note('why', copy.askFar, 'lead'), note('then', copy.askThen(clock(limit.resumeAt)))],
        actions: [{ id: 'limit-schedule', primary: true }, leave],
      };
    case 'ask-unknown':
      return {
        ...base, message: { text: copy.unknown },
        notes: [note('why', copy.unknownWhy(provider)), note('now', copy.unknownNow)], actions: [resume, leave],
      };
    case 'ask-reopened':
      return {
        ...base, message: { text: copy.reopened(clock(limit.resetsAt)) },
        notes: [note('why', copy.reopenedWhy, 'lead'), note('then', copy.reopenedSends)], actions: [resume, leave],
      };
    case 'off':
      // In Settings the way back is the switch, and it brings back nothing already cancelled.
      return limit.offBy === 'setting'
        ? { ...base, message: { text: resets }, notes: [note('off', copy.offBySetting), note('now', copy.resumeNow)], actions: [{ id: 'limit-resume' }] }
        : { ...base, message: { text: resets }, notes: [note('off', copy.off), note('now', copy.resumeNow)], actions: [{ id: 'limit-resume' }, { id: 'limit-auto-on' }] };
    case 'left':
      return { ...base, message: { text: resets }, notes: [note('left', copy.left), note('now', copy.resumeNow)], actions: [{ id: 'limit-resume' }] };
    case 'cancelled':
      return { ...base, message: { text: copy.cancelled }, notes: [note('none', copy.cancelledNote)], actions: [] };
    case 'skipped':
      return approvalOpen
        ? { ...base, message: { text: copy.skipped }, notes: [note('then', copy.skippedAnswer)], actions: [{ id: 'focus-decision', primary: true }] }
        : { ...base, message: { text: copy.skipped }, notes: [note('then', copy.skippedAnswered)], actions: [resume, leave] };
    case 'not-included':
      return { ...base, message: { text: copy.notIncluded(provider) }, notes: [note('none', copy.notIncludedNote)], actions: [] };
    case 'child':
      return {
        ...base, message: { text: resets },
        notes: [note('why', copy.child, 'lead'), note('parent', copy.childParent), note('now', copy.resumeNow)], actions: [resume],
      };
    case 'failed':
      return {
        ...base, message: { text: limit.failure ? copy.failure[limit.failure] : copy.failedNote, tone: 'danger', label: copy.failedLabel },
        notes: limit.failure ? [note('none', copy.failedNote)] : [], actions: [{ id: 'limit-resume' }],
      };
  }
}
