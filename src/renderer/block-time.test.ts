import { describe, expect, it } from 'vitest';

import { blockDuration, formatBlockClock } from './block-time';

describe('block time', () => {
  it('shows the local start clock with two digits', () => {
    expect(formatBlockClock(new Date(2026, 9, 27, 9, 5).getTime())).toBe('09:05');
    expect(formatBlockClock(new Date(2026, 9, 27, 14, 20).getTime())).toBe('14:20');
  });

  it('shows tenths under ten seconds, seconds under a minute, then minutes and seconds', () => {
    expect(blockDuration(0)).toEqual({ key: 'block.durationSeconds', values: { value: '0.0' } });
    expect(blockDuration(240)).toEqual({ key: 'block.durationSeconds', values: { value: '0.2' } });
    expect(blockDuration(9_940)).toEqual({ key: 'block.durationSeconds', values: { value: '9.9' } });
    expect(blockDuration(12_400)).toEqual({ key: 'block.durationSeconds', values: { value: '12' } });
    expect(blockDuration(184_000)).toEqual({ key: 'block.durationMinutes', values: { minutes: 3, seconds: 4 } });
    expect(blockDuration(-5)).toEqual({ key: 'block.durationSeconds', values: { value: '0.0' } });
  });
});
