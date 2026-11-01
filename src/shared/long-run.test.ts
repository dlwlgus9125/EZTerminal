import { describe, expect, it } from 'vitest';

import {
  APP_SENT_REASONS, LONG_RUN_CAPABILITY, LONG_RUN_PRINCIPAL, resumeDue, resumesByItself, RESUME_TIMING, STEER_FALLBACKS, turnAutoResumeOff, USAGE_LIMIT_PHASES,
  type TurnUsageLimit, type UsageLimitPhase,
} from './long-run';
import { parseTranscriptPayload } from './transcript-payload';

const RESUME = '2026-11-01T06:12:00.000Z';
const RETRY = '2026-11-01T06:22:00.000Z';
const before = Date.parse(RESUME) - 1;
const after = Date.parse(RETRY) + 60_000;

function limit(phase: UsageLimitPhase, extra: Partial<TurnUsageLimit> = {}): TurnUsageLimit {
  return { turnId: 'turn', providerId: 'claude', phase, window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z', resumeAt: RESUME, retryAt: RETRY, ...extra };
}

const PHASES: readonly UsageLimitPhase[] = USAGE_LIMIT_PHASES;

describe('the stored shapes', () => {
  const row = { v: 1, type: 'usage-limit', stopId: 'stop', turnId: 'turn', providerId: 'claude', phase: 'waiting', window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z' };

  it('names the capability and the host principal once', () => {
    expect(LONG_RUN_CAPABILITY).toBe('long-run-v1');
    expect(LONG_RUN_PRINCIPAL).toBe('long-run-runtime');
  });

  it('keeps a card in every phase, with the clocks a phase has', () => {
    for (const phase of USAGE_LIMIT_PHASES) expect(parseTranscriptPayload({ ...row, phase })?.type, phase).toBe('usage-limit');
    const full = { ...row, phase: 'retrying', resetsAt: RESUME, resumeAt: RESUME, retryAt: RETRY, refusedAt: RESUME, triedAt: RESUME };
    expect(parseTranscriptPayload(full)).toEqual(full);
    expect(parseTranscriptPayload({ ...row, phase: 'off', offBy: 'setting' })).toBeDefined();
    expect(parseTranscriptPayload({ ...row, phase: 'child', childKind: 'managed' })).toBeDefined();
    expect(parseTranscriptPayload({ ...row, phase: 'failed', failure: 'session-gone' })).toBeDefined();
  });

  it('never stores the line, a phase it does not know, or a child the AI runs itself', () => {
    expect(parseTranscriptPayload({ ...row, line: { position: 1, total: 2 } })).toBeUndefined();
    expect(parseTranscriptPayload({ ...row, phase: 'lifted' })).toBeUndefined();
    expect(parseTranscriptPayload({ ...row, phase: 'child', childKind: 'provider' })).toBeUndefined();
    expect(parseTranscriptPayload({ ...row, stopId: undefined })).toBeUndefined();
  });

  it('marks the rows of what the app sent and what a steer became', () => {
    for (const reason of APP_SENT_REASONS) expect(parseTranscriptPayload({ v: 1, type: 'app-sent', stopId: 'stop', reason })?.type).toBe('app-sent');
    expect(parseTranscriptPayload({ v: 1, type: 'app-sent', stopId: 'stop', reason: 'bored' })).toBeUndefined();
    expect(parseTranscriptPayload({ v: 1, type: 'steer', rewritten: true })?.type).toBe('steer');
    expect(parseTranscriptPayload({ v: 1, type: 'steer', newTurn: true })?.type).toBe('steer');
    for (const reason of STEER_FALLBACKS) expect(parseTranscriptPayload({ v: 1, type: 'steer-queued', reason })?.type).toBe('steer-queued');
    expect(parseTranscriptPayload({ v: 1, type: 'steer-queued', reason: 'tired' })).toBeUndefined();
  });
});

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

describe('which limits the app tries by itself (D2)', () => {
  const stopped = Date.parse('2026-11-01T05:58:00.000Z');
  const at = (ms: number): string => new Date(stopped + ms).toISOString();
  const within = RESUME_TIMING.autoWithinMs;

  it('a known reset within 6 hours', () => {
    expect(within).toBe(6 * 3_600_000);
    expect(resumesByItself({ window: 'five-hour', resetsAt: at(within) }, stopped)).toBe(true);
    expect(resumesByItself({ window: 'unknown', resetsAt: at(60_000) }, stopped)).toBe(true);
  });

  it('nothing later, nothing weekly, nothing without a time: those ask first', () => {
    expect(resumesByItself({ window: 'five-hour', resetsAt: at(within + 1) }, stopped)).toBe(false);
    expect(resumesByItself({ window: 'weekly', resetsAt: at(60_000) }, stopped)).toBe(false);
    expect(resumesByItself({ window: 'five-hour' }, stopped)).toBe(false);
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
