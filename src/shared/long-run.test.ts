import { describe, expect, it } from 'vitest';

import { resumeDue, RESUME_TIMING, turnAutoResumeOff, type TurnUsageLimit, type UsageLimitPhase } from './long-run';

const RESUME = '2026-11-01T06:12:00.000Z';
const RETRY = '2026-11-01T06:22:00.000Z';
const before = Date.parse(RESUME) - 1;
const after = Date.parse(RETRY) + 60_000;

function limit(phase: UsageLimitPhase, extra: Partial<TurnUsageLimit> = {}): TurnUsageLimit {
  return { turnId: 'turn', providerId: 'claude', phase, window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z', resumeAt: RESUME, retryAt: RETRY, ...extra };
}

const PHASES: readonly UsageLimitPhase[] = [
  'waiting', 'resuming', 'resumed', 'retrying', 'gave-up', 'ask-reset', 'scheduled', 'ask-unknown', 'ask-reopened', 'off', 'left', 'cancelled', 'skipped', 'not-included', 'child', 'failed',
];

describe('when the app may send by itself', () => {
  it('only in a state that waits on a clock, and only once that time has passed', () => {
    for (const phase of PHASES) expect(resumeDue(limit(phase), after), phase).toBe(phase === 'waiting' || phase === 'scheduled' || phase === 'retrying');
    for (const phase of PHASES) expect(resumeDue(limit(phase), before), phase).toBe(false);
  });

  it('a refused try waits for its own retry time, not the first one', () => {
    expect(resumeDue(limit('retrying'), Date.parse(RESUME) + 60_000)).toBe(false);
    expect(resumeDue(limit('retrying'), Date.parse(RETRY))).toBe(true);
  });

  it('never without a time', () => {
    expect(resumeDue(limit('waiting', { resumeAt: undefined }), after)).toBe(false);
  });

  it('keeps the decided timing in one place', () => {
    expect(RESUME_TIMING).toMatchObject({ afterResetMs: 120_000, retryAfterRefusalMs: 600_000, lineGapMs: 60_000 });
  });
});

describe('turning the setting off', () => {
  it('cancels every schedule that has not gone out and says it was the setting', () => {
    for (const phase of ['waiting', 'scheduled', 'retrying'] as const) {
      const off = turnAutoResumeOff(limit(phase));
      expect(off).toMatchObject({ phase: 'off', offBy: 'setting' });
      expect(resumeDue(off, after), phase).toBe(false);
    }
  });

  it('leaves everything else as it is: a send in flight is past cancelling', () => {
    for (const phase of PHASES.filter((entry) => entry !== 'waiting' && entry !== 'scheduled' && entry !== 'retrying')) {
      const before = limit(phase);
      expect(turnAutoResumeOff(before), phase).toBe(before);
    }
  });
});
