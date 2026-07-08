/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLLBAR_PARAMS, applyRollbarParams, clampRollbarParams } from './effect-params';
import type { RollbarParams } from './effect-params';

describe('clampRollbarParams', () => {
  it('clamps thickness above/below the 1-200 range', () => {
    expect(clampRollbarParams({ thickness: 999 }).thickness).toBe(200);
    expect(clampRollbarParams({ thickness: 0 }).thickness).toBe(1);
  });

  it('clamps gap (spacing %) above/below the 1-100 range', () => {
    expect(clampRollbarParams({ gap: 999 }).gap).toBe(100);
    expect(clampRollbarParams({ gap: -5 }).gap).toBe(1);
  });

  it('clamps speed above/below the 1-20 range', () => {
    expect(clampRollbarParams({ speed: 99 }).speed).toBe(20);
    expect(clampRollbarParams({ speed: 0 }).speed).toBe(1);
  });

  it('clamps opacity and softness to 0-100', () => {
    expect(clampRollbarParams({ opacity: 150 }).opacity).toBe(100);
    expect(clampRollbarParams({ opacity: -1 }).opacity).toBe(0);
    expect(clampRollbarParams({ softness: 999 }).softness).toBe(100);
    expect(clampRollbarParams({ softness: -9 }).softness).toBe(0);
  });

  it('rounds a fractional in-range value', () => {
    expect(clampRollbarParams({ gap: 5.6 }).gap).toBe(6);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampRollbarParams({ gap: Number.NaN }).gap).toBe(DEFAULT_ROLLBAR_PARAMS.gap);
    expect(clampRollbarParams({ thickness: undefined }).thickness).toBe(DEFAULT_ROLLBAR_PARAMS.thickness);
  });

  it('ignores the removed count field from old persisted settings', () => {
    const legacy = { count: 12, gap: 20 } as unknown as Partial<RollbarParams>;
    const clamped = clampRollbarParams(legacy);
    expect(clamped.gap).toBe(20);
    expect('count' in clamped).toBe(false);
  });

  it('accepts a valid color literal', () => {
    expect(clampRollbarParams({ color: '#ff00aa' }).color).toBe('#ff00aa');
    expect(clampRollbarParams({ color: 'rgba(0, 128, 255, 0.5)' }).color).toBe('rgba(0, 128, 255, 0.5)');
  });

  it('rejects a bad color and falls back to the default', () => {
    expect(clampRollbarParams({ color: 'not-a-color' }).color).toBe(DEFAULT_ROLLBAR_PARAMS.color);
    expect(clampRollbarParams({ color: 'url(evil)' }).color).toBe(DEFAULT_ROLLBAR_PARAMS.color);
  });

  it('defaults every field when given an empty partial', () => {
    expect(clampRollbarParams({})).toEqual(DEFAULT_ROLLBAR_PARAMS);
  });
});

describe('applyRollbarParams', () => {
  it('sets the CSS custom properties on documentElement', () => {
    applyRollbarParams({ thickness: 3, gap: 5, color: '#abcdef', speed: 4, opacity: 90, softness: 70 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-thickness')).toBe('3');
    // spacing 5% of the screen -> the conveyor pitch is 5vh
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe('5vh');
    expect(style.getPropertyValue('--fx-rollbar-color')).toBe('#abcdef');
    // per-PERIOD duration: full-screen crossing 24/4=6s, one 5% pitch = 0.30s
    expect(style.getPropertyValue('--fx-rollbar-duration')).toBe('0.30s');
  });

  it('scales the per-period duration with spacing so line speed stays constant', () => {
    // gap 100 (one screen apart): a period IS a full screen -> 24/4 = 6.00s
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, gap: 100 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe('100vh');
    expect(style.getPropertyValue('--fx-rollbar-duration')).toBe('6.00s');
    // gap 10 at speed 12: (24/12) * 0.10 = 0.20s per pitch
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, gap: 10, speed: 12 });
    expect(style.getPropertyValue('--fx-rollbar-duration')).toBe('0.20s');
  });

  it('maps opacity % to a 0..1 css value', () => {
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, opacity: 35 });
    expect(document.documentElement.style.getPropertyValue('--fx-rollbar-opacity')).toBe('0.35');
  });

  it('maps softness to the per-line gradient stop offsets', () => {
    // thickness 8, softness 50 -> fade-in ends at 8*50/200 = 2px, fade-out starts at 6px
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, thickness: 8, softness: 50 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-grad-in')).toBe('2.00px');
    expect(style.getPropertyValue('--fx-rollbar-grad-out')).toBe('6.00px');
    // softness 0 -> hard edges (0 / t); 100 -> triangle (t/2 / t/2)
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, thickness: 8, softness: 0 });
    expect(style.getPropertyValue('--fx-rollbar-grad-in')).toBe('0.00px');
    expect(style.getPropertyValue('--fx-rollbar-grad-out')).toBe('8.00px');
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, thickness: 8, softness: 100 });
    expect(style.getPropertyValue('--fx-rollbar-grad-in')).toBe('4.00px');
    expect(style.getPropertyValue('--fx-rollbar-grad-out')).toBe('4.00px');
  });
});
