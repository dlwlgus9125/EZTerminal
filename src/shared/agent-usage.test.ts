import { describe, expect, it } from 'vitest';

import { agentUsageLevel, formatUsageCountdown } from './agent-usage';

const MINUTE = 60_000;

describe('formatUsageCountdown', () => {
  it('prints the time until a reset the way the CLI HUD does', () => {
    expect(formatUsageCountdown(30_000)).toBe('1m');
    expect(formatUsageCountdown(45 * MINUTE)).toBe('45m');
    expect(formatUsageCountdown(60 * MINUTE)).toBe('1h0m');
    expect(formatUsageCountdown(130 * MINUTE + 59_000)).toBe('2h10m');
    expect(formatUsageCountdown((2 * 24 * 60 + 5 * 60 + 59) * MINUTE)).toBe('2d5h');
  });

  it('never goes negative', () => {
    expect(formatUsageCountdown(-5 * MINUTE)).toBe('1m');
  });
});

describe('agentUsageLevel', () => {
  it('warns at 70% and alarms at 90%, like the CLI HUD', () => {
    expect(agentUsageLevel(69)).toBe('normal');
    expect(agentUsageLevel(70)).toBe('warning');
    expect(agentUsageLevel(89)).toBe('warning');
    expect(agentUsageLevel(90)).toBe('danger');
  });
});
