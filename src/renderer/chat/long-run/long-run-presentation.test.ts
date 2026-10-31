import { describe, expect, it } from 'vitest';

import { RESUME_TEXT, type TurnUsageLimit, type UsageLimitPhase } from '../../../shared/long-run';
import { chatCopy } from '../copy';
import { limitStatus, limitView } from './long-run-presentation';

const ko = chatCopy('ko').longRun.limit;
const en = chatCopy('en').longRun.limit;
const RESET = '2026-11-01T06:10:00.000Z';
const RESUME = '2026-11-01T06:12:00.000Z';

function limit(phase: UsageLimitPhase, extra: Partial<TurnUsageLimit> = {}): TurnUsageLimit {
  return { turnId: 'turn', providerId: 'claude', phase, window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z', resetsAt: RESET, resumeAt: RESUME, ...extra };
}

const PHASES: readonly UsageLimitPhase[] = [
  'waiting', 'resuming', 'resumed', 'retrying', 'gave-up', 'ask-reset', 'scheduled', 'ask-unknown', 'ask-reopened', 'off', 'left', 'cancelled', 'skipped', 'not-included', 'child', 'failed',
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

  it('only sends by itself from the states that say a time', () => {
    for (const phase of ['ask-reset', 'ask-unknown', 'ask-reopened', 'gave-up', 'off', 'left', 'cancelled', 'not-included', 'child'] as const) {
      const text = limitView(limit(phase), ko, 'ko').notes.map((note) => note.text).join(' ');
      expect(text, phase).not.toContain('자동으로 재개');
    }
  });

  it('offers nothing where nothing can be done', () => {
    for (const phase of ['resuming', 'resumed', 'left', 'cancelled', 'not-included'] as const) expect(limitView(limit(phase), ko, 'ko').actions, phase).toEqual([]);
  });

  it('asks first for a reset days away, and offers the choice as its main action', () => {
    const view = limitView(limit('ask-reset', { window: 'weekly', resetsAt: '2026-11-03T14:50:00.000Z', resumeAt: '2026-11-03T14:52:00.000Z' }), ko, 'ko');
    expect(view.notes[0]?.text).toBe(ko.askFar);
    expect(view.actions[0]).toMatchObject({ id: 'limit-schedule', primary: true });
    expect(view.message.text).toContain('11월 3일');
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
      expect(asks, phase).toBe(['gave-up', 'ask-reset', 'ask-unknown', 'ask-reopened'].includes(phase));
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
