import { describe, expect, it } from 'vitest';

import { RESUME_TEXT, type OpenUsageLimit, type UsageLimitPhase } from '../../../shared/long-run';
import { chatCopy, formatClock } from '../copy';
import { limitStatus, limitView } from './long-run-presentation';

const ko = chatCopy('ko').longRun.limit;
const en = chatCopy('en').longRun.limit;
const RESET = '2026-11-01T06:10:00.000Z';
const RESUME = '2026-11-01T06:12:00.000Z';

function limit(phase: UsageLimitPhase, extra: Partial<OpenUsageLimit> = {}): OpenUsageLimit {
  return { stopId: 'stop', turnId: 'turn', providerId: 'claude', phase, window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z', resetsAt: RESET, resumeAt: RESUME, ...extra };
}

const PHASES: readonly UsageLimitPhase[] = [
  'waiting', 'resuming', 'resumed', 'retrying', 'gave-up', 'ask-reset', 'scheduled', 'ask-unknown', 'ask-reopened', 'off', 'left', 'cancelled', 'person-refused', 'skipped', 'not-included', 'child', 'failed', 'unconfirmed',
];

describe('the usage limit card', () => {
  it('says what it sends before it sends it, and never promises the stopped request again', () => {
    const view = limitView(limit('waiting'), ko, 'ko');
    expect(view.notes.map((note) => note.text).join(' ')).toContain(`"${RESUME_TEXT}"`);
    expect(view.notes[0]?.tone).toBe('lead');
    expect(view.actions.map((action) => action.id)).toEqual(['limit-try-now', 'limit-auto-off']);
  });

  it('says plainly that 지금 시도 can leave a refused turn, on the card and to a screen reader', () => {
    const view = limitView(limit('waiting'), ko, 'ko');
    expect(view.notes.map((note) => note.text)).toContain(ko.earlyRefused);
    expect(view.actions.find((action) => action.id === 'limit-try-now')?.ariaLabel).toBe(ko.tryNowLabel);
  });

  it('says who started a send: a press is never the scheduled time', () => {
    expect(limitView(limit('resuming', { sendReason: 'scheduled-time' }), ko, 'ko').message.text).toContain('예약 시각');
    for (const sendReason of ['try-now', 'resume-pressed'] as const) {
      expect(limitView(limit('resuming', { sendReason }), ko, 'ko').message.text, sendReason).not.toContain('예약 시각');
      expect(limitView(limit('resuming', { sendReason }), en, 'en').message.text, sendReason).not.toContain('scheduled');
    }
    expect(limitView(limit('resuming', { sendReason: 'resume-pressed' }), ko, 'ko').message.text).toContain('이어서 하기');
    expect(limitView(limit('resuming', { sendReason: 'try-now' }), ko, 'ko').message.text).toContain('지금 시도');
  });

  it('names no reason it does not have', () => {
    expect(limitView(limit('resuming'), ko, 'ko').message.text).not.toContain('예약 시각');
    expect(limitView(limit('resuming'), en, 'en').message.text).not.toContain('scheduled');
  });

  it('says when it really went: a pressed send has no schedule of its own', () => {
    const sentAt = '2026-11-01T09:30:00.000Z';
    expect(limitView(limit('resumed', { resumeAt: undefined, sentAt }), en, 'en').message.text).toBe(en.sent(formatClock(sentAt, 'en')));
    expect(limitView(limit('resumed', { sentAt }), en, 'en').message.text).toBe(en.sent(formatClock(sentAt, 'en')));
    expect(limitView(limit('resumed'), en, 'en').message.text).toBe(en.sent(formatClock(RESUME, 'en')));
  });

  it('only sends by itself from the states that say a time', () => {
    for (const phase of ['ask-reset', 'ask-unknown', 'ask-reopened', 'gave-up', 'off', 'left', 'cancelled', 'not-included', 'child'] as const) {
      const text = limitView(limit(phase), ko, 'ko').notes.map((note) => note.text).join(' ');
      expect(text, phase).not.toContain('자동으로 재개');
    }
  });

  it('offers nothing where nothing can be done', () => {
    for (const phase of ['resuming', 'resumed', 'cancelled', 'not-included'] as const) expect(limitView(limit(phase), ko, 'ko').actions, phase).toEqual([]);
  });

  it('turned off, on the card or in Settings, leaves a manual 이어서 하기 that says what an early press costs', () => {
    for (const offBy of ['card', 'setting'] as const) {
      const view = limitView(limit('off', { offBy }), ko, 'ko');
      expect(view.actions.map((action) => action.id), offBy).toContain('limit-resume');
      expect(view.notes.map((note) => note.text), offBy).toContain(ko.resumeNow);
    }
    expect(limitView(limit('off', { offBy: 'card' }), ko, 'ko').actions.map((action) => action.id)).toContain('limit-auto-on');
    // The setting's switch is where that comes back.
    expect(limitView(limit('off', { offBy: 'setting' }), ko, 'ko').actions.map((action) => action.id)).not.toContain('limit-auto-on');
    expect(limitView(limit('off', { offBy: 'setting' }), ko, 'ko').notes.map((note) => note.text)).toContain(ko.offBySetting);
  });

  it('left as it is, it can still be continued by hand', () => {
    expect(limitView(limit('left'), ko, 'ko').actions.map((action) => action.id)).toEqual(['limit-resume']);
  });

  it('asks first for a reset days away, and offers the choice as its main action', () => {
    const view = limitView(limit('ask-reset', { window: 'weekly', resetsAt: '2026-11-03T14:50:00.000Z', resumeAt: '2026-11-03T14:52:00.000Z' }), ko, 'ko');
    expect(view.notes[0]?.text).toBe(ko.askWeekly);
    expect(view.actions[0]).toMatchObject({ id: 'limit-schedule', primary: true });
    expect(view.message.text).toContain('11월 3일');
  });

  it('says why it tries by itself, and why it asks instead', () => {
    expect(limitView(limit('waiting'), ko, 'ko').notes.map((note) => note.text)).toContain(ko.within);
    expect(ko.within).toContain('6시간');
    const weekly = limitView(limit('ask-reset', { window: 'weekly' }), ko, 'ko');
    expect(weekly.notes[0]?.text).toBe(ko.askWeekly);
    const later = limitView(limit('ask-reset', { window: 'unknown' }), ko, 'ko');
    expect(later.notes[0]?.text).toBe(ko.askFar);
    expect(ko.askFar).toContain('6시간');
  });

  it('says sends go out in turn without waiting for one another (D6)', () => {
    const notes = limitView(limit('waiting', { line: { position: 2, total: 3 } }), ko, 'ko').notes.map((note) => note.text);
    expect(notes).toContain('대화 3개에 차례로 보냅니다 · 이 대화는 2번째');
    expect(notes).toContain('오래 멈춘 대화부터 60초 간격으로 보냅니다. 앞 대화가 끝나기를 기다리지 않습니다.');
    expect(notes.join(' ')).not.toContain('이어집니다');
  });

  it('never resumes a child by itself, and offers it by hand only where that path is supported (D7)', () => {
    const managed = limitView(limit('child', { childKind: 'managed-supported' }), ko, 'ko');
    expect(managed.actions.map((action) => action.id)).toEqual(['limit-resume']);
    const unsupported = limitView(limit('child', { childKind: 'managed' }), ko, 'ko');
    expect(unsupported.actions).toEqual([]);
    expect(unsupported.notes.map((note) => note.text)).toContain(ko.childUnsupported);
  });

  it('reopened on a send that had no reset names none', () => {
    const view = limitView(limit('ask-reopened', { window: 'unknown', resetsAt: undefined }), ko, 'ko');
    expect(view.message.text).toBe(ko.unknown);
    expect(view.message.text).not.toContain('()');
  });

  it('with no reset time says so and says what an early try costs', () => {
    const view = limitView(limit('ask-unknown', { window: 'unknown', resetsAt: undefined }), ko, 'ko');
    expect(view.message.text).toBe(ko.unknown);
    expect(view.notes.map((note) => note.text)).toContain(ko.unknownNow);
  });

  it('leads to the decision while an approval is open, and offers to continue once it is answered', () => {
    expect(limitView(limit('skipped'), ko, 'ko', true).actions.map((action) => action.id)).toEqual(['focus-decision']);
    expect(limitView(limit('skipped'), ko, 'ko', false).actions.map((action) => action.id)).toEqual(['limit-resume', 'limit-leave']);
  });

  it('keeps a send it cannot confirm apart from one that did not happen', () => {
    const unknown = limitView(limit('unconfirmed'), ko, 'ko');
    expect(unknown.state).not.toBe('failed');
    expect(unknown.message.text).toBe(ko.unconfirmed);
    expect(unknown.notes.map((note) => note.text)).toContain(ko.unconfirmedNote);
    expect(unknown.notes.map((note) => note.text)).not.toContain(ko.failedNote);
    expect(unknown.actions.map((action) => action.id)).toEqual(['limit-resume', 'limit-leave']);
    expect(limitStatus(limit('unconfirmed'), ko, 'ko')).toMatchObject({ asks: true });
  });

  it('says a refused message of the person\'s stays and is read when this continues', () => {
    const view = limitView(limit('person-refused'), ko, 'ko');
    expect(view.message.text).toBe(ko.personRefused);
    expect(view.notes.map((note) => note.text)).toEqual(expect.arrayContaining([ko.personRefusedKept, ko.resumeNow]));
    expect(view.actions.map((action) => action.id)).toEqual(['limit-resume']);
  });

  it('is an error only when the send itself failed', () => {
    for (const phase of PHASES) expect(limitView(limit(phase, { failure: 'disconnected' }), ko, 'ko').state === 'failed', phase).toBe(phase === 'failed');
    expect(limitView(limit('failed', { failure: 'disconnected' }), ko, 'ko').message).toMatchObject({ tone: 'danger', label: ko.failedLabel });
  });

  it('never leaves a phase without words, in either language', () => {
    for (const copy of [ko, en]) for (const phase of PHASES) expect(limitView(limit(phase, { retryAt: RESUME, refusedAt: RESUME }), copy, 'en').stateText, phase).toBeTruthy();
  });
});

describe('the state on the list and in the header', () => {
  it('a clock is not the person', () => {
    expect(limitStatus(limit('waiting'), ko, 'ko')).toMatchObject({ asks: false, stopped: false });
    expect(limitStatus(limit('waiting'), ko, 'ko')?.text).toMatch(/^한도 대기 · /u);
    expect(limitStatus(limit('retrying', { retryAt: RESUME }), ko, 'ko')).toMatchObject({ asks: false });
  });

  it('only an ask-first case waits on the person', () => {
    for (const phase of PHASES) {
      const asks = limitStatus(limit(phase), ko, 'ko')?.asks === true;
      expect(asks, phase).toBe(['gave-up', 'ask-reset', 'ask-unknown', 'ask-reopened', 'unconfirmed'].includes(phase));
    }
  });

  it('says nothing once the conversation has moved on', () => {
    expect(limitStatus(limit('resumed'), ko, 'ko')).toBeUndefined();
    expect(limitStatus(limit('cancelled'), ko, 'ko')).toBeUndefined();
  });

  it('a limit that cannot resume by itself is stopped, not waiting', () => {
    for (const phase of ['off', 'left', 'not-included', 'child'] as const) expect(limitStatus(limit(phase), ko, 'ko')?.text, phase).toBe(ko.status.stopped);
  });
});
