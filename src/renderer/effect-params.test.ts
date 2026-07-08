/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLLBAR_PARAMS, applyRollbarParams, clampRollbarParams } from './effect-params';

describe('clampRollbarParams', () => {
  it('clamps count above/below the 1-40 range', () => {
    expect(clampRollbarParams({ count: 100 }).count).toBe(40);
    expect(clampRollbarParams({ count: 0 }).count).toBe(1);
  });

  it('clamps thickness above/below the 1-10 range', () => {
    expect(clampRollbarParams({ thickness: 99 }).thickness).toBe(10);
    expect(clampRollbarParams({ thickness: 0 }).thickness).toBe(1);
  });

  it('clamps gap (spread %) above/below the 0-100 range', () => {
    expect(clampRollbarParams({ gap: 999 }).gap).toBe(100);
    expect(clampRollbarParams({ gap: -5 }).gap).toBe(0);
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
    expect(clampRollbarParams({ count: 5.6 }).count).toBe(6);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampRollbarParams({ count: Number.NaN }).count).toBe(DEFAULT_ROLLBAR_PARAMS.count);
    expect(clampRollbarParams({ thickness: undefined }).thickness).toBe(DEFAULT_ROLLBAR_PARAMS.thickness);
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
    applyRollbarParams({ count: 12, thickness: 3, gap: 5, color: '#abcdef', speed: 4, opacity: 90, softness: 70 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-count')).toBe('12');
    expect(style.getPropertyValue('--fx-rollbar-thickness')).toBe('3');
    expect(style.getPropertyValue('--fx-rollbar-gap')).toBe('5');
    expect(style.getPropertyValue('--fx-rollbar-color')).toBe('#abcdef');
    // speed 4 -> duration 24/4 = 6.00s
    expect(style.getPropertyValue('--fx-rollbar-duration')).toBe('6.00s');
    // 12 lines x 3px = 36px at 5% spread toward the full viewport
    expect(style.getPropertyValue('--fx-rollbar-height')).toBe('calc(36px + 0.0500 * (100vh - 36px))');
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe(
      'calc((36px + 0.0500 * (100vh - 36px) - 3px) / 11)',
    );
  });

  it('spans the full viewport at gap=100 (first line top, last line bottom)', () => {
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, count: 10, thickness: 2, gap: 100 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-height')).toBe('calc(20px + 1.0000 * (100vh - 20px))');
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe(
      'calc((20px + 1.0000 * (100vh - 20px) - 2px) / 9)',
    );
  });

  it('renders a single line for count=1 (no divide-by-zero pitch)', () => {
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, count: 1, thickness: 4 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-height')).toBe('4px');
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe('4px');
  });

  it('maps a higher speed to a shorter duration', () => {
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, speed: 12 });
    // 24/12 = 2.00s
    expect(document.documentElement.style.getPropertyValue('--fx-rollbar-duration')).toBe('2.00s');
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
