import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import {
  RESUME_TEXT, turnAutoResumeOff, type AppSentReason, type SteeredMessage, type SteerFallback, type SteerLanding, type TurnUsageLimit, type UsageLimitPhase, type UsageLimitWindow,
} from '../../../shared/long-run';
import type { LiveConversation, WaitingItem } from '../../shell/shell-model';
import type { ChatLongRunAction } from '../ChatContext';
import type { ChatLongRunRows } from '../model/build-chat-model';

/**
 * Long-run fixtures for the 시안 stories and the renderer tests: transcript rows as a host writes them, plus the draft
 * inputs the model takes instead of host rows. No real limit was ever seen. What is measured is the shape behind each
 * state (stub runs of the real CLIs and Claude's real records): "Continue.", the windows, a missing reset, a refused
 * early try, `usage_not_included`, a review or compact turn refusing a steer, Codex dropping text it was writing. The
 * conversation, the times and every sentence the app says are 시안 data.
 */

export const LONG_ROOT = 'C:\\Working\\cart-kit';
export const LONG_SESSION = 'long-run-chat';

export type LongLanguage = 'ko' | 'en';
export type LongProvider = 'claude' | 'codex';

/** Fixed clock, in Korea, so screenshots stay the same. */
const kst = (day: number, hour: number, minute: number, second = 0): string => new Date(Date.UTC(2026, 10, day, hour - 9, minute, second)).toISOString();
export const STOPPED_AT = kst(1, 14, 58);
export const RESET_AT = kst(1, 15, 10);
export const RESUME_AT = kst(1, 15, 12);
/** D6: second in line, a minute after the first. */
export const LINE_AT = kst(1, 15, 13);
/** D4: ten minutes after the first refused try. */
export const RETRY_AT = kst(1, 15, 22);
export const WEEKLY_RESET_AT = kst(3, 23, 50);
export const WEEKLY_RESUME_AT = kst(3, 23, 52);
const PERSON_AT = kst(1, 15, 11);
const PRESSED_AT = kst(1, 15, 30);
const TRIED_AT = kst(1, 14, 59);
const REFUSED_AT = kst(1, 15, 2);

export interface LongRunFixture {
  readonly items: readonly DaemonTranscriptItem[];
  readonly turns: readonly DaemonTurn[];
  readonly approvals?: readonly DaemonApproval[];
  readonly state: 'idle' | 'working' | 'blocked';
  readonly rows: ChatLongRunRows;
  /** On their way, held or failed: a landed message is a transcript row. */
  readonly steered?: readonly SteeredMessage[];
  readonly fellBack?: ReadonlyMap<string, SteerFallback>;
}

const TEXT = {
  ko: {
    ask: '장바구니 쪽에서 실패하는 테스트를 전부 고쳐 줘. 다 고치면 `pnpm test`로 확인해 줘.',
    found: '실패 세 개 가운데 둘은 `cartTotal` 루프가 원인입니다. 이것부터 고치고 전체 테스트를 돌립니다.',
    steer: '`src/cart.test.ts`만 돌려도 돼. 전체 테스트는 오래 걸려.',
    streaming: '`cartTotal`은 마지막 항목 다음까지 읽고 있었습니다. 조건을 `<`로 바꾸',
    written: '`cartTotal`은 마지막 항목 다음까지 읽고 있었습니다. 조건을 `<`로 바꾸겠습니다.',
    afterSteer: '알겠습니다. `src/cart.test.ts`만 돌립니다.',
    partial: '`cartTotal`을 고쳤습니다. 남은 실패 하나는 `applyDiscount`의 퍼센트 계산입니다. 이어서 고칩니다.',
    afterResume: '`src/discount.ts`의 퍼센트 계산까지 고쳤습니다. `pnpm test`가 모두 통과합니다.',
    person: '`src/discount.ts`는 내가 고칠게. 테스트만 다시 돌려 줘.',
    afterPerson: '`src/discount.ts`는 그대로 두고 테스트만 다시 돌립니다.',
    queued: '끝나면 바꾼 내용을 한 줄로 정리해 줘.',
  },
  en: {
    ask: 'Fix every failing cart test, then check with `pnpm test`.',
    found: 'Two of the three failures come from the `cartTotal` loop. I’ll fix that first, then run the whole suite.',
    steer: 'Running `src/cart.test.ts` alone is enough. The whole suite takes long.',
    streaming: '`cartTotal` read past the last item. Changing the condition to `<`',
    written: '`cartTotal` read past the last item. I will change the condition to `<`.',
    afterSteer: 'Understood. Running only `src/cart.test.ts`.',
    partial: '`cartTotal` is fixed. The one failure left is the percentage in `applyDiscount`. Continuing with that.',
    afterResume: 'The percentage in `src/discount.ts` is fixed too. `pnpm test` passes.',
    person: 'I’ll fix `src/discount.ts` myself. Just run the tests again.',
    afterPerson: 'Leaving `src/discount.ts` alone and running the tests again.',
    queued: 'When you are done, sum up the change in one line.',
  },
} as const;

const started = kst(1, 14, 40);
const at = (sequence: number): string => new Date(Date.parse(started) + sequence * 20_000).toISOString();

function item(sequence: number, kind: DaemonTranscriptItem['kind'], text: string, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem {
  const sessionId = overrides.sessionId ?? LONG_SESSION;
  return { id: `${sessionId}:${String(sequence)}`, sessionId, sequence, kind, text, isDelta: false, isSensitive: false, createdAt: at(sequence), ...overrides };
}

const absolute = (path: string): string => `${LONG_ROOT}\\${path.replace(/\//gu, '\\')}`;

function read(sequence: number, turnId: string, path: string): DaemonTranscriptItem[] {
  const target = absolute(path);
  const callId = `call-${String(sequence)}`;
  return [
    item(sequence, 'tool-call', `Read\n${JSON.stringify({ file_path: target })}`, { turnId, payload: { v: 1, type: 'tool', callId, name: 'Read', category: 'read', phase: 'call', status: 'running', target } }),
    item(sequence + 1, 'tool-result', 'ok', { turnId, payload: { v: 1, type: 'tool', callId, name: 'Read', category: 'read', phase: 'result', status: 'completed', target } }),
  ];
}

/** A command: running until `finished`. */
function shell(sequence: number, turnId: string, command: string, finished: boolean): DaemonTranscriptItem[] {
  const callId = `call-${String(sequence)}`;
  const call = item(sequence, 'tool-call', `Bash\n${JSON.stringify({ command })}`, { turnId, payload: { v: 1, type: 'tool', callId, name: 'Bash', category: 'command', phase: 'call', status: 'running', target: command } });
  return finished ? [call, item(sequence + 1, 'tool-result', 'ok', { turnId, payload: { v: 1, type: 'tool', callId, name: 'Bash', category: 'command', phase: 'result', status: 'completed', target: command } })] : [call];
}

function turn(id: string, state: DaemonTurn['state'], startedAt: string, finishedAt?: string): DaemonTurn {
  return { id, sessionId: LONG_SESSION, commandId: `command-${id}`, state, revision: 1, startedAt, ...(finishedAt ? { finishedAt } : {}), createdAt: startedAt, updatedAt: finishedAt ?? startedAt };
}

/** The stopped or running turn's first rows: the person's request, a read, the AI's plan. */
function opening(lang: LongLanguage, turnId: string): DaemonTranscriptItem[] {
  const text = TEXT[lang];
  return [
    item(1, 'user-message', text.ask, { turnId }),
    ...read(2, turnId, 'src/cart.ts'),
    item(4, 'assistant-message', text.found, { turnId }),
  ];
}

// ── A. Into a running turn ─────────────────────────────────────────────────────

export type SteerVariant =
  | 'busy' | 'writing' | 'on-its-way' | 'on-its-way-text' | 'landed' | 'landed-new-turn' | 'landed-rewritten' | 'landed-then-limit' | 'caught-stop' | 'caught-limit' | 'behind-approval' | 'review-turn' | 'compact-turn' | 'turn-ended' | 'failed' | 'failed-disconnected' | 'unconfirmed';

const FULL_SUITE = 'pnpm test';
const ONE_FILE = 'pnpm vitest run src/cart.test.ts';
const STEER_ID = 'steer-1';

function steered(lang: LongLanguage, state: SteeredMessage['state'], extra: Partial<SteeredMessage> = {}): SteeredMessage {
  return { id: STEER_ID, text: TEXT[lang].steer, state, sentAt: at(9), ...extra };
}

function approval(callId: string, command: string): DaemonApproval {
  return {
    id: 'approval-command', sessionId: LONG_SESSION, turnId: 'turn-run', providerRequestId: callId, risk: 'danger', title: 'Run a command', state: 'pending',
    request: { v: 1, kind: 'command', callId, command }, revision: 1, createdAt: at(8), updatedAt: at(8),
  };
}

/** Sent while a turn ran, and refused: it waits as an ordinary queued turn, with the reason beside it. */
function queuedFallback(lang: LongLanguage, base: LongRunFixture, reason: SteerFallback): LongRunFixture {
  const queued = item(20, 'user-message', TEXT[lang].steer, { turnId: 'turn-queued' });
  return { ...base, items: [...base.items, queued], turns: [...base.turns, turn('turn-queued', 'queued', at(9))], fellBack: new Map([['turn-queued', reason]]) };
}

export function steerStory(lang: LongLanguage, variant: SteerVariant): LongRunFixture {
  const text = TEXT[lang];
  const work = [...opening(lang, 'turn-run'), ...shell(6, 'turn-run', FULL_SUITE, false)];
  const running: LongRunFixture = { items: work, turns: [turn('turn-run', 'working', started)], state: 'working', rows: {} };
  const writing: LongRunFixture = { ...running, items: [...opening(lang, 'turn-run'), item(6, 'assistant-message', text.streaming, { turnId: 'turn-run', isDelta: true, messageId: 'streaming' })] };
  switch (variant) {
    case 'busy': return running;
    case 'writing': return writing;
    case 'on-its-way': return { ...running, steered: [steered(lang, 'on-its-way', { behind: 'tool' })] };
    case 'on-its-way-text': return { ...writing, steered: [steered(lang, 'on-its-way', { behind: 'text' })] };
    case 'landed': {
      // At a tool boundary: the tool ended and nothing was being written, on either AI.
      const landed = item(8, 'user-message', text.steer, { turnId: 'turn-run' });
      return {
        ...running,
        items: [...opening(lang, 'turn-run'), ...shell(6, 'turn-run', FULL_SUITE, true), landed, item(9, 'assistant-message', text.afterSteer, { turnId: 'turn-run' }), ...shell(10, 'turn-run', ONE_FILE, false)],
        rows: { landed: new Map<string, SteerLanding>([[landed.id, {}]]) },
      };
    }
    case 'landed-new-turn': {
      // Claude was writing: that text ended its turn, and the message is the next one.
      const landed = item(8, 'user-message', text.steer, { turnId: 'turn-next' });
      return {
        items: [...opening(lang, 'turn-run'), item(6, 'assistant-message', text.written, { turnId: 'turn-run' }), landed, item(9, 'assistant-message', text.afterSteer, { turnId: 'turn-next' }), ...shell(10, 'turn-next', ONE_FILE, false)],
        turns: [turn('turn-run', 'completed', started, at(7)), turn('turn-next', 'working', at(8))], state: 'working',
        rows: { landed: new Map<string, SteerLanding>([[landed.id, { newTurn: true }]]) },
      };
    }
    case 'landed-then-limit': {
      // Measured: the message folded into the turn the limit then refused; it stays in the session and is read on continuing.
      const limited = limitStory(lang, 'waiting');
      const landed = item(7, 'user-message', text.steer, { turnId: LIMIT_TURN });
      return { ...limited, items: [...limited.items.filter((entry) => entry.sequence < 8), landed, ...limited.items.filter((entry) => entry.sequence >= 8)], rows: { ...limited.rows, landed: new Map<string, SteerLanding>([[landed.id, { refused: true }]]) } };
    }
    case 'caught-stop': {
      // The person stopped the turn with a message still on its way: what became of it was not measured, so it says so.
      return { ...running, items: [...opening(lang, 'turn-run'), ...shell(6, 'turn-run', FULL_SUITE, true)], turns: [turn('turn-run', 'interrupted', started, at(9))], state: 'idle', steered: [steered(lang, 'unconfirmed', { caught: 'stop' })] };
    }
    case 'caught-limit':
      return { ...limitStory(lang, 'waiting'), steered: [steered(lang, 'unconfirmed', { caught: 'limit' })] };
    case 'landed-rewritten': {
      // Codex was writing: that text is gone from the transcript, and the mark says so.
      const landed = item(8, 'user-message', text.steer, { turnId: 'turn-run' });
      return {
        ...running,
        items: [...opening(lang, 'turn-run'), landed, item(9, 'assistant-message', text.afterSteer, { turnId: 'turn-run' }), ...shell(10, 'turn-run', ONE_FILE, false)],
        rows: { landed: new Map<string, SteerLanding>([[landed.id, { rewritten: true }]]) },
      };
    }
    case 'behind-approval': {
      const call = shell(6, 'turn-run', FULL_SUITE, false);
      return {
        ...running, items: [...opening(lang, 'turn-run'), ...call], turns: [turn('turn-run', 'blocked', started)], state: 'blocked',
        approvals: [approval('call-6', FULL_SUITE)], steered: [steered(lang, 'behind-approval')],
      };
    }
    case 'review-turn':
    case 'compact-turn':
      return queuedFallback(lang, running, variant);
    case 'turn-ended':
      return queuedFallback(lang, { ...running, items: [...opening(lang, 'turn-run'), ...shell(6, 'turn-run', FULL_SUITE, true)], turns: [turn('turn-run', 'completed', started, at(9))] }, 'turn-ended');
    case 'failed': return { ...running, steered: [steered(lang, 'failed', { failure: 'refused' })] };
    case 'failed-disconnected': return { ...running, steered: [steered(lang, 'failed', { failure: 'disconnected' })] };
    case 'unconfirmed': return { ...running, steered: [steered(lang, 'unconfirmed')] };
  }
}

/** The session a fixture lives in, so a row the story host adds lands in the same conversation. */
const sessionOf = (fixture: LongRunFixture): string => fixture.items[0]?.sessionId ?? LONG_SESSION;

/** What the story host does with a message put into the turn. */
export function acceptSteer(fixture: LongRunFixture, text: string, id: string): LongRunFixture {
  const held = fixture.approvals?.some((entry) => entry.state === 'pending') === true;
  const behind = fixture.items.at(-1)?.isDelta ? 'text' as const : 'tool' as const;
  const message: SteeredMessage = { id, text, state: held ? 'behind-approval' : 'on-its-way', sentAt: at(9), ...(held ? {} : { behind }) };
  return { ...fixture, steered: [...(fixture.steered ?? []), message] };
}

/**
 * It got there: out of the tray, into the transcript at the place it landed. A tool's end folds it into the turn. While
 * text is being written, Codex drops that text and goes on in the same turn, and Claude ends the turn with it and starts
 * a new one with the message.
 */
export function landSteer(fixture: LongRunFixture, id: string, provider: LongProvider): LongRunFixture {
  const message = fixture.steered?.find((entry) => entry.id === id);
  if (!message) return fixture;
  const sessionId = sessionOf(fixture);
  const sequence = Math.max(...fixture.items.map((entry) => entry.sequence)) + 1;
  // A message lands at a tool boundary: the tool that held it has ended.
  const last = fixture.items.at(-1);
  const ended = last?.kind === 'tool-call' && last.payload?.type === 'tool'
    ? [item(sequence, 'tool-result', 'ok', { turnId: 'turn-run', sessionId, payload: { ...last.payload, phase: 'result', status: 'completed' } })] : [];
  const row = item(sequence + 1, 'user-message', message.text, { turnId: 'turn-run', sessionId });
  const landed = new Map(fixture.rows.landed);
  // The host says so: only this makes the tray announce it.
  const steered = fixture.steered?.map((entry) => (entry.id === id ? { ...entry, state: 'landed' as const } : entry));
  if (message.behind === 'text' && provider === 'claude') {
    const next = item(sequence + 1, 'user-message', message.text, { turnId: 'turn-next', sessionId });
    landed.set(next.id, { newTurn: true });
    return {
      ...fixture, steered, rows: { ...fixture.rows, landed },
      items: [...fixture.items.map((entry) => (entry.isDelta ? { ...entry, isDelta: false } : entry)), next],
      turns: [...fixture.turns.map((entry) => (entry.id === 'turn-run' ? { ...entry, state: 'completed' as const, finishedAt: at(9) } : entry)), { ...turn('turn-next', 'working', at(9)), sessionId }],
    };
  }
  const dropped = message.behind === 'text';
  landed.set(row.id, dropped ? { rewritten: true } : {});
  return { ...fixture, items: [...fixture.items.filter((entry) => !(dropped && entry.isDelta)), ...ended, row], rows: { ...fixture.rows, landed }, steered };
}

/** 대기열에 넣기 on a message that could not go in: an ordinary queued turn. */
export function queueSteer(fixture: LongRunFixture, id: string): LongRunFixture {
  const message = fixture.steered?.find((entry) => entry.id === id);
  if (!message) return fixture;
  const sequence = Math.max(...fixture.items.map((entry) => entry.sequence)) + 1;
  return {
    ...fixture, items: [...fixture.items, item(sequence, 'user-message', message.text, { turnId: 'turn-queued', sessionId: sessionOf(fixture) })],
    turns: [...fixture.turns, { ...turn('turn-queued', 'queued', at(9)), sessionId: sessionOf(fixture) }],
    steered: fixture.steered?.filter((entry) => entry.id !== id),
  };
}

export function dropSteer(fixture: LongRunFixture, id: string): LongRunFixture {
  return { ...fixture, steered: fixture.steered?.filter((entry) => entry.id !== id) };
}

// ── B. A turn stopped at a usage limit ─────────────────────────────────────────

const LIMIT_TURN = 'turn-limit';

function stopped(lang: LongLanguage): { readonly items: DaemonTranscriptItem[]; readonly turns: DaemonTurn[] } {
  return {
    items: [...opening(lang, LIMIT_TURN), ...shell(6, LIMIT_TURN, FULL_SUITE, true), item(8, 'assistant-message', TEXT[lang].partial, { turnId: LIMIT_TURN })],
    turns: [turn(LIMIT_TURN, 'failed', started, STOPPED_AT)],
  };
}

/** One `Continue.` the app sent: its row and the turn that row started. */
function continueRow(sequence: number, turnId: string, sentAt: string, state: 'failed' | 'completed', sessionId = LONG_SESSION): { readonly row: DaemonTranscriptItem; readonly turn: DaemonTurn } {
  const finished = state === 'failed' ? sentAt : new Date(Date.parse(sentAt) + 4 * 60_000).toISOString();
  return { row: item(sequence, 'user-message', RESUME_TEXT, { turnId, createdAt: sentAt, sessionId }), turn: { ...turn(turnId, state, sentAt, finished), sessionId } };
}

export interface LimitOptions {
  readonly provider?: LongProvider;
  readonly window?: UsageLimitWindow;
  readonly line?: TurnUsageLimit['line'];
  /** Who the row after `resumed` says sent it. */
  readonly reason?: AppSentReason;
  readonly failure?: TurnUsageLimit['failure'];
}

export function limitStory(lang: LongLanguage, phase: UsageLimitPhase, options: LimitOptions = {}): LongRunFixture {
  const text = TEXT[lang];
  const { items, turns } = stopped(lang);
  const window = options.window ?? 'five-hour';
  const weekly = window === 'weekly';
  const reset = weekly ? WEEKLY_RESET_AT : RESET_AT;
  const clock = weekly ? WEEKLY_RESUME_AT : options.line ? LINE_AT : RESUME_AT;
  const limit: TurnUsageLimit = {
    turnId: phase === 'person-refused' ? 'turn-person' : LIMIT_TURN, providerId: options.provider ?? 'claude', phase, window, stoppedAt: STOPPED_AT,
    ...(phase === 'ask-unknown' ? {} : { resetsAt: reset, resumeAt: clock }),
    ...(options.line ? { line: options.line } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
  };
  const fixture = (extra: Partial<LongRunFixture> = {}, card: TurnUsageLimit = limit): LongRunFixture => ({
    items, turns, state: 'idle', ...extra,
    rows: { limited: new Map([[LIMIT_TURN, 'stopped']]), ...extra.rows, limits: new Map([[card.turnId, card]]) },
  });
  switch (phase) {
    case 'resuming':
      return fixture({ state: 'working' });
    case 'resumed': {
      const sent = continueRow(9, 'turn-resume', RESUME_AT, 'completed');
      return fixture({
        items: [...items, sent.row, item(10, 'assistant-message', text.afterResume, { turnId: 'turn-resume', createdAt: RESUME_AT })], turns: [...turns, sent.turn],
        rows: { appSent: new Map([[sent.row.id, options.reason ?? 'scheduled-time']]) },
      });
    }
    case 'retrying': {
      const sent = continueRow(9, 'turn-try-1', RESUME_AT, 'failed');
      return fixture({
        items: [...items, sent.row], turns: [...turns, sent.turn],
        rows: { appSent: new Map([[sent.row.id, 'scheduled-time']]), limited: new Map([[LIMIT_TURN, 'stopped'], ['turn-try-1', 'refused']]) },
      }, { ...limit, turnId: 'turn-try-1', refusedAt: RESUME_AT, retryAt: RETRY_AT });
    }
    case 'gave-up': {
      const first = continueRow(9, 'turn-try-1', RESUME_AT, 'failed');
      const second = continueRow(10, 'turn-try-2', RETRY_AT, 'failed');
      return fixture({
        items: [...items, first.row, second.row], turns: [...turns, first.turn, second.turn],
        rows: { appSent: new Map([[first.row.id, 'scheduled-time'], [second.row.id, 'scheduled-time']]), limited: new Map([[LIMIT_TURN, 'stopped'], ['turn-try-1', 'refused'], ['turn-try-2', 'refused']]) },
      }, { ...limit, turnId: 'turn-try-2', refusedAt: RETRY_AT });
    }
    case 'cancelled': {
      const person = item(9, 'user-message', text.person, { turnId: 'turn-person', createdAt: PERSON_AT });
      return fixture({
        items: [...items, person, item(10, 'assistant-message', text.afterPerson, { turnId: 'turn-person', createdAt: PERSON_AT }), ...shell(11, 'turn-person', FULL_SUITE, false)],
        turns: [...turns, turn('turn-person', 'working', PERSON_AT)], state: 'working',
      });
    }
    case 'person-refused': {
      const person = item(9, 'user-message', text.person, { turnId: 'turn-person', createdAt: REFUSED_AT });
      return fixture({
        items: [...items, person], turns: [...turns, turn('turn-person', 'failed', REFUSED_AT, REFUSED_AT)],
        rows: { limited: new Map([[LIMIT_TURN, 'stopped'], ['turn-person', 'refused']]) },
      });
    }
    case 'skipped':
      return fixture({ state: 'blocked', approvals: [{ ...approval('call-held', FULL_SUITE), turnId: LIMIT_TURN }] });
    default:
      return fixture();
  }
}

/** The story host: answers a card's buttons the way a host will. `settled`: its second step, a moment later. */
export function applyLongRunAction(fixture: LongRunFixture, action: ChatLongRunAction, settled: boolean): LongRunFixture {
  const limit = fixture.rows.limits?.get(action.turnId);
  if (!limit) return fixture;
  const withLimit = (next: TurnUsageLimit, extra: Partial<LongRunFixture> = {}): LongRunFixture => ({
    ...fixture, ...extra, rows: { ...fixture.rows, ...extra.rows, limits: new Map([[next.turnId, next]]) },
  });
  const phase = (next: UsageLimitPhase): LongRunFixture => withLimit({ ...limit, phase: next });
  const sequence = Math.max(...fixture.items.map((entry) => entry.sequence)) + 1;
  switch (action.kind) {
    case 'limit-auto-off': return withLimit({ ...limit, phase: 'off', offBy: 'card' });
    case 'limit-auto-on': return phase('waiting');
    case 'limit-schedule': return phase('scheduled');
    case 'limit-unschedule': return phase('ask-reset');
    case 'limit-leave': return phase('left');
    case 'limit-try-now': {
      if (!settled) return phase('resuming');
      const sent = continueRow(sequence, 'turn-tried', TRIED_AT, 'failed', sessionOf(fixture));
      return withLimit({ ...limit, phase: 'waiting', turnId: 'turn-tried', triedAt: TRIED_AT }, {
        items: [...fixture.items, sent.row], turns: [...fixture.turns, sent.turn],
        rows: { appSent: new Map([...(fixture.rows.appSent ?? []), [sent.row.id, 'try-now' as const]]), limited: new Map([...(fixture.rows.limited ?? []), ['turn-tried', 'refused' as const]]) },
      });
    }
    case 'limit-resume': {
      if (!settled) return phase('resuming');
      const sent = continueRow(sequence, 'turn-resume', PRESSED_AT, 'completed', sessionOf(fixture));
      return withLimit({ ...limit, phase: 'resumed', resumeAt: PRESSED_AT }, {
        items: [...fixture.items, sent.row], turns: [...fixture.turns, sent.turn],
        rows: { appSent: new Map([...(fixture.rows.appSent ?? []), [sent.row.id, 'resume-pressed' as const]]) },
      });
    }
  }
}

const limitOf = (fixture: LongRunFixture): TurnUsageLimit | undefined => [...(fixture.rows.limits?.values() ?? [])][0];
const onClock = (limit: TurnUsageLimit | undefined): boolean => limit?.phase === 'waiting' || limit?.phase === 'scheduled' || limit?.phase === 'retrying';

/** The clock reached a schedule that was still standing: what the app sends by itself. */
export function clockSends(fixture: LongRunFixture): LongRunFixture {
  const limit = limitOf(fixture);
  if (!limit) return fixture;
  const sequence = Math.max(...fixture.items.map((entry) => entry.sequence)) + 1;
  const sent = continueRow(sequence, 'turn-resume', limit.resumeAt ?? RESUME_AT, 'completed', sessionOf(fixture));
  return {
    ...fixture, items: [...fixture.items, sent.row], turns: [...fixture.turns, sent.turn],
    rows: { ...fixture.rows, appSent: new Map([...(fixture.rows.appSent ?? []), [sent.row.id, 'scheduled-time' as const]]), limits: new Map([[limit.turnId, { ...limit, phase: 'resumed' as const }]]) },
  };
}

/** The person sent first, while a clock ran: its schedule is gone, whether the message went through or was refused. */
export function personSends(fixture: LongRunFixture, message: string, refused = false): LongRunFixture {
  const limit = limitOf(fixture);
  if (!limit || !onClock(limit)) return fixture;
  const sessionId = sessionOf(fixture);
  const sequence = Math.max(...fixture.items.map((entry) => entry.sequence)) + 1;
  if (refused) {
    return {
      ...fixture, items: [...fixture.items, item(sequence, 'user-message', message, { turnId: 'turn-person', sessionId, createdAt: REFUSED_AT })],
      turns: [...fixture.turns, { ...turn('turn-person', 'failed', REFUSED_AT, REFUSED_AT), sessionId }],
      rows: { ...fixture.rows, limited: new Map([...(fixture.rows.limited ?? []), ['turn-person', 'refused' as const]]), limits: new Map([['turn-person', { ...limit, turnId: 'turn-person', phase: 'person-refused' as const }]]) },
    };
  }
  return {
    ...fixture, state: 'working', items: [...fixture.items, item(sequence, 'user-message', message, { turnId: 'turn-person', sessionId, createdAt: PERSON_AT })],
    turns: [...fixture.turns, { ...turn('turn-person', 'working', PERSON_AT), sessionId }],
    rows: { ...fixture.rows, limits: new Map([[limit.turnId, { ...limit, phase: 'cancelled' as const }]]) },
  };
}

/** The setting went off: every schedule not yet sent is cancelled. */
export function settingOff(fixture: LongRunFixture): LongRunFixture {
  const limit = limitOf(fixture);
  return limit ? { ...fixture, rows: { ...fixture.rows, limits: new Map([[limit.turnId, turnAutoResumeOff(limit)]]) } } : fixture;
}

/** Every session id in the fixture moved, so stories do not share draft storage. */
export function inLongSession(fixture: LongRunFixture, sessionId: string): LongRunFixture {
  const move = <T extends { readonly sessionId: string }>(entry: T): T => ({ ...entry, sessionId });
  const movedId = (id: string): string => id.replace(LONG_SESSION, sessionId);
  const rekey = <V>(map: ReadonlyMap<string, V> | undefined): ReadonlyMap<string, V> | undefined => (map ? new Map([...map].map(([key, value]) => [movedId(key), value])) : undefined);
  const landed = rekey(fixture.rows.landed);
  const appSent = rekey(fixture.rows.appSent);
  return {
    ...fixture,
    items: fixture.items.map((entry) => ({ ...move(entry), id: movedId(entry.id) })),
    turns: fixture.turns.map(move),
    ...(fixture.approvals ? { approvals: fixture.approvals.map(move) } : {}),
    rows: { ...fixture.rows, ...(landed ? { landed } : {}), ...(appSent ? { appSent } : {}) },
  };
}

// ── C. Where a waiting conversation shows ──────────────────────────────────────

const LIST_TITLES = {
  ko: ['장바구니 테스트 고치기', '가격 표시 고치기', '할인 계산 고치기', '주간 보고서 다듬기', '인증 점검', '문서 정리'],
  en: ['Fix the cart tests', 'Fix the price display', 'Fix the discount maths', 'Tidy the weekly report', 'Check authentication', 'Tidy the docs'],
} as const;

function conversation(sessionId: string, title: string, providerId: string, state: LiveConversation['state'], lamp: LiveConversation['lamp'], clock?: string): LiveConversation {
  return { sessionId, title, providerId, state, lamp, updatedAt: STOPPED_AT, children: [], ...(clock ? { limitClock: clock } : {}) };
}

/** The list as bundle 3 would show it: two on the clock, one that asks, one stopped for good, and ordinary ones around them. */
export function listConversations(lang: LongLanguage, clocks: { readonly first: string; readonly second: string }): readonly LiveConversation[] {
  const titles = LIST_TITLES[lang];
  return [
    conversation('c-work', titles[4], 'codex', 'working', 'on'),
    conversation('c-first', titles[0], 'claude', 'limit-wait', 'idle', clocks.first),
    conversation('c-second', titles[1], 'claude', 'limit-wait', 'idle', clocks.second),
    conversation('c-weekly', titles[3], 'claude', 'limit-ask', 'amber'),
    conversation('c-plan', titles[2], 'codex', 'limit-stop', 'idle'),
    conversation('c-done', titles[5], 'claude', 'done', 'ok'),
  ];
}

/** Only an ask-first case joins 나를 기다리는 것. */
export function listWaiting(lang: LongLanguage): readonly WaitingItem[] {
  return [{
    approvalId: 'limit-weekly', sessionId: 'c-weekly', title: LIST_TITLES[lang][3], providerId: 'claude', kind: 'usage-limit',
    detail: lang === 'ko' ? '주간 한도 · 리셋이 며칠 뒤라 먼저 묻습니다' : 'Weekly limit · the reset is days away, so the app asks first', at: STOPPED_AT, asks: 'answer',
  }];
}
