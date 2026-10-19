import { describe, expect, it } from 'vitest';

import {
  claudeContextPercent,
  claudeLimitsFromRateLimitInfo,
  codexContextPercent,
  codexLimitsFromRateLimits,
} from './agent-usage-readings';

describe('Claude plan limits', () => {
  it('reads both windows from a captured rate_limit_event', () => {
    // test/fixtures/provider-capture/claude-markdown.ndjson line 11
    const info = {
      status: 'allowed',
      resetsAt: 1792045200,
      rateLimitType: 'five_hour',
      unifiedWindows: {
        five_hour: { utilization: 0.22, resetsAt: 1792045200 },
        seven_day: { utilization: 0.19, resetsAt: 1792220400 },
      },
    };
    expect(claudeLimitsFromRateLimitInfo(info)).toEqual({
      fiveHour: { usedPercent: 22, resetsAt: 1792045200000 },
      weekly: { usedPercent: 19, resetsAt: 1792220400000 },
    });
  });

  it('keeps the whole part like the HUD instead of rounding', () => {
    const percent = (utilization: number) => claudeLimitsFromRateLimitInfo({
      unifiedWindows: { five_hour: { utilization } },
    })?.fiveHour;
    expect(percent(0.226)).toEqual({ usedPercent: 22 });
    expect(percent(0.995)).toEqual({ usedPercent: 99 });
    expect(percent(1)).toEqual({ usedPercent: 100 });
  });

  it('reports a window the event leaves out as absent', () => {
    expect(claudeLimitsFromRateLimitInfo({
      unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 10 } },
    })).toEqual({ fiveHour: null, weekly: { usedPercent: 50, resetsAt: 10_000 } });
  });

  it('falls back to the single typed window', () => {
    expect(claudeLimitsFromRateLimitInfo({ rateLimitType: 'seven_day', utilization: 0.31, resetsAt: 20 }))
      .toEqual({ weekly: { usedPercent: 31, resetsAt: 20_000 } });
    expect(claudeLimitsFromRateLimitInfo({ rateLimitType: 'overage', utilization: 0.31 })).toBeUndefined();
    expect(claudeLimitsFromRateLimitInfo({ status: 'allowed' })).toBeUndefined();
  });
});

describe('Claude context', () => {
  it('counts the input side of the last request over the model window', () => {
    // claude-markdown.ndjson: the main assistant message and claude-opus-5-5's 1M window
    const usage = { input_tokens: 2, cache_creation_input_tokens: 3925, cache_read_input_tokens: 16883, output_tokens: 366 };
    expect(claudeContextPercent(usage, 1_000_000)).toBe(2);
    expect(claudeContextPercent({ input_tokens: 68_000, output_tokens: 9_000 }, 200_000)).toBe(34);
    expect(claudeContextPercent({ input_tokens: 300_000 }, 200_000)).toBe(100);
  });

  it('uses the last request when the usage lists iterations', () => {
    expect(claudeContextPercent({
      input_tokens: 999_999,
      iterations: [
        { type: 'message', input_tokens: 10_000 },
        { type: 'message', input_tokens: 50_000, cache_read_input_tokens: 10_000 },
        { type: 'compaction', input_tokens: 1 },
      ],
    }, 200_000)).toBe(30);
  });

  it('has no value without tokens or a window', () => {
    expect(claudeContextPercent({ input_tokens: 0 }, 200_000)).toBeUndefined();
    expect(claudeContextPercent({ input_tokens: 10 }, 0)).toBeUndefined();
    expect(claudeContextPercent(undefined, 200_000)).toBeUndefined();
  });
});

describe('Codex plan limits', () => {
  it('reads the captured weekly-only account', () => {
    // codex-markdown.ndjson line 244
    expect(codexLimitsFromRateLimits({
      limitId: 'codex',
      primary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1792472286 },
      secondary: null,
    })).toEqual({ fiveHour: null, weekly: { usedPercent: 72, resetsAt: 1792472286000 } });
  });

  it('tells the windows apart by length, not by slot', () => {
    expect(codexLimitsFromRateLimits({
      primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2 },
      secondary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1 },
    })).toEqual({ fiveHour: { usedPercent: 12, resetsAt: 1000 }, weekly: { usedPercent: 40, resetsAt: 2000 } });
  });

  it('ignores limits that are not the Codex plan', () => {
    expect(codexLimitsFromRateLimits({ limitId: 'other', primary: { usedPercent: 5, windowDurationMins: 300 } })).toBeUndefined();
  });
});

describe('Codex context', () => {
  it('takes the fixed baseline off the captured usage', () => {
    // codex-markdown.ndjson line 243
    expect(codexContextPercent(19120, 258400)).toBe(3);
    expect(codexContextPercent(258400, 258400)).toBe(100);
  });

  it('has no value without tokens or a usable window', () => {
    expect(codexContextPercent(0, 258400)).toBeUndefined();
    expect(codexContextPercent(5000, 12000)).toBeUndefined();
  });
});
