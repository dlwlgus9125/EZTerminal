import { describe, expect, it } from 'vitest';

import type { WorkflowRepeat } from '../shared/workflow';
import { nextRepeatAt, occurrenceKey, repeatConfigDigest, repeatCron } from './workflow-repeat-time';

const daily = (time: string, timezone = 'America/New_York'): WorkflowRepeat => ({ cadence: 'daily', time, timezone, enabled: true });

describe('workflow repeat time', () => {
  it('turns a daily or weekly repeat into its cron', () => {
    expect(repeatCron(daily('09:05'))).toBe('5 9 * * *');
    expect(repeatCron({ cadence: 'weekly', weekday: 1, time: '18:30' })).toBe('30 18 * * 1');
  });

  it('finds the next occurrence as the real instant in its zone', () => {
    expect(nextRepeatAt(daily('09:00'), new Date('2026-10-25T12:00:00.000Z')).toISOString()).toBe('2026-10-25T13:00:00.000Z');
    expect(nextRepeatAt(daily('09:00'), new Date('2026-10-25T13:00:00.000Z')).toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(nextRepeatAt({ cadence: 'weekly', weekday: 1, time: '09:00', timezone: 'Asia/Seoul', enabled: true }, new Date('2026-10-25T00:00:00.000Z')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('moves a time the spring-forward skips and runs a repeated fall-back time once', () => {
    // 2026-03-08 New York: 02:00 → 03:00, so 02:30 does not exist that day.
    const spring = nextRepeatAt(daily('02:30'), new Date('2026-03-08T05:00:00.000Z'));
    expect(spring.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(occurrenceKey(daily('02:30'), spring)).toBe('2026-03-08');
    // 2026-11-01 New York: 01:30 happens twice; only the first runs.
    const fall = nextRepeatAt(daily('01:30'), new Date('2026-11-01T04:00:00.000Z'));
    expect(fall.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(nextRepeatAt(daily('01:30'), fall).toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  it('keys an occurrence by its local date, across midnight in UTC', () => {
    expect(occurrenceKey(daily('23:30', 'Asia/Seoul'), new Date('2026-10-25T14:30:00.000Z'))).toBe('2026-10-25');
    expect(occurrenceKey(daily('00:10', 'Asia/Seoul'), new Date('2026-10-25T15:10:00.000Z'))).toBe('2026-10-26');
  });

  it('digests only what decides the occurrences', () => {
    expect(repeatConfigDigest(daily('09:00'))).toBe(repeatConfigDigest({ ...daily('09:00'), enabled: false }));
    expect(repeatConfigDigest(daily('09:00'))).not.toBe(repeatConfigDigest(daily('09:01')));
  });
});
