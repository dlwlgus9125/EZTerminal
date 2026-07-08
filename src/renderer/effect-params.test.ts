/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BURST_PARAMS,
  DEFAULT_FLICKER_PARAMS,
  DEFAULT_INTERFERENCE_PARAMS,
  DEFAULT_MICRO_PARAMS,
  DEFAULT_NOISE_PARAMS,
  DEFAULT_ROLLBAR_PARAMS,
  applyFlickerParams,
  applyInterferenceParams,
  applyMicroJitterParams,
  applyNoiseParams,
  applyRollbarParams,
  buildBurstKeyframes,
  clampBurstJitterParams,
  clampFlickerParams,
  clampInterferenceParams,
  clampMicroJitterParams,
  clampNoiseParams,
  clampRollbarParams,
} from './effect-params';
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
    // gap 100 (one screen apart) at default speed 1: a period IS a full
    // screen -> 24/1 = 24.00s
    applyRollbarParams({ ...DEFAULT_ROLLBAR_PARAMS, gap: 100 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-rollbar-period')).toBe('100vh');
    expect(style.getPropertyValue('--fx-rollbar-duration')).toBe('24.00s');
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

describe('clamp — interference param sets', () => {
  it('clamps burst-jitter bounds and rounds', () => {
    expect(clampBurstJitterParams({ period: 999 }).period).toBe(30);
    expect(clampBurstJitterParams({ period: 0 }).period).toBe(1);
    expect(clampBurstJitterParams({ duration: 9999 }).duration).toBe(1000);
    expect(clampBurstJitterParams({ duration: 10 }).duration).toBe(50);
    expect(clampBurstJitterParams({ intensity: 99 }).intensity).toBe(20);
    expect(clampBurstJitterParams({ intensity: 0.4 }).intensity).toBe(1);
  });

  it('coerces the burst flash flag to a strict boolean', () => {
    expect(clampBurstJitterParams({ flash: false }).flash).toBe(false);
    expect(clampBurstJitterParams({ flash: true }).flash).toBe(true);
    expect(clampBurstJitterParams({}).flash).toBe(DEFAULT_BURST_PARAMS.flash);
    expect(clampBurstJitterParams({ flash: 'yes' as unknown as boolean }).flash).toBe(DEFAULT_BURST_PARAMS.flash);
  });

  it('clamps micro-jitter, noise, and flicker bounds', () => {
    expect(clampMicroJitterParams({ speed: 99 }).speed).toBe(20);
    expect(clampMicroJitterParams({ amplitude: 12 }).amplitude).toBe(5);
    expect(clampNoiseParams({ density: 0 }).density).toBe(1);
    expect(clampNoiseParams({ opacity: 500 }).opacity).toBe(100);
    expect(clampNoiseParams({ speed: -3 }).speed).toBe(1);
    expect(clampFlickerParams({ frequency: 99 }).frequency).toBe(30);
    expect(clampFlickerParams({ depth: 90 }).depth).toBe(40);
  });

  it('falls back to defaults on non-finite / absent values', () => {
    expect(clampBurstJitterParams({ period: Number.NaN }).period).toBe(DEFAULT_BURST_PARAMS.period);
    expect(clampMicroJitterParams({})).toEqual(DEFAULT_MICRO_PARAMS);
    expect(clampNoiseParams({})).toEqual(DEFAULT_NOISE_PARAMS);
    expect(clampFlickerParams({})).toEqual(DEFAULT_FLICKER_PARAMS);
  });

  it('clampInterferenceParams survives a non-object and fills every set', () => {
    expect(clampInterferenceParams(undefined)).toEqual(DEFAULT_INTERFERENCE_PARAMS);
    expect(clampInterferenceParams('garbage')).toEqual(DEFAULT_INTERFERENCE_PARAMS);
    const mixed = clampInterferenceParams({ 'micro-jitter': { amplitude: 99 }, flicker: { depth: 20 } });
    expect(mixed['micro-jitter'].amplitude).toBe(5);
    expect(mixed['micro-jitter'].speed).toBe(DEFAULT_MICRO_PARAMS.speed);
    expect(mixed.flicker.depth).toBe(20);
    expect(mixed['jitter-burst']).toEqual(DEFAULT_BURST_PARAMS);
    expect(mixed['static-noise']).toEqual(DEFAULT_NOISE_PARAMS);
  });
});

describe('buildBurstKeyframes', () => {
  it('emits the exact default keyframes (P=5s, D=250ms -> 5% window, I=6)', () => {
    const css = buildBurstKeyframes(DEFAULT_BURST_PARAMS);
    expect(css).toContain('0.00% { transform: translate(0px, 6px); }');
    expect(css).toContain('1.00% { transform: translate(-4px, -6px); }');
    expect(css).toContain('2.00% { transform: translate(2px, 4px); }');
    expect(css).toContain('3.00% { transform: translate(0px, -3px); }');
    expect(css).toContain('4.00% { transform: translate(-2px, 2px); }');
    expect(css).toContain('5.00% { transform: translate(0px, 0px); }');
    expect(css).toContain('100% { transform: translate(0px, 0px); }');
    // flash timeline shares the window: peak 0.25 at 0%, off by 5%
    expect(css).toContain('0% { opacity: 0.25; }');
    expect(css).toContain('5.00% { opacity: 0; }');
  });

  it('zeroes the flash peak when flash is off (shake continues)', () => {
    const css = buildBurstKeyframes({ ...DEFAULT_BURST_PARAMS, flash: false });
    expect(css).toContain('0% { opacity: 0; }');
    expect(css).not.toContain('0.25');
    expect(css).toContain('translate(-4px, -6px)'); // jitter untouched
  });

  it('caps the burst window at 50% and floors it at 1%', () => {
    // 1000ms burst in a 1s cycle would be 100% -> capped to half the cycle
    expect(buildBurstKeyframes({ ...DEFAULT_BURST_PARAMS, period: 1, duration: 1000 })).toContain(
      '50.00% { transform: translate(0px, 0px); }',
    );
    // 50ms in 30s is 0.17% -> floored so the burst always exists
    expect(buildBurstKeyframes({ ...DEFAULT_BURST_PARAMS, period: 30, duration: 50 })).toContain(
      '1.00% { transform: translate(0px, 0px); }',
    );
  });

  it('scales offsets with intensity (rounded to integer px)', () => {
    const css = buildBurstKeyframes({ ...DEFAULT_BURST_PARAMS, intensity: 20 });
    expect(css).toContain('translate(0px, 20px)'); // [0, 1] * 20
    expect(css).toContain('translate(-12px, -20px)'); // [-0.6, -1] * 20
    expect(css).toContain('translate(8px, 14px)'); // [0.4, 0.7] * 20
  });
});

describe('apply — interference CSS custom properties', () => {
  it('applyMicroJitterParams maps speed to a 4/speed duration and amplitude to px', () => {
    applyMicroJitterParams({ speed: 8, amplitude: 3 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-micro-duration')).toBe('0.50s');
    expect(style.getPropertyValue('--fx-micro-amp')).toBe('3px');
  });

  it('applyNoiseParams maps density to tile size, opacity to 0..1, speed to duration', () => {
    applyNoiseParams(DEFAULT_NOISE_PARAMS);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-noise-size')).toBe('144px'); // 64 + (100-60)*2
    expect(style.getPropertyValue('--fx-noise-opacity')).toBe('0.12');
    expect(style.getPropertyValue('--fx-noise-duration')).toBe('0.40s');
    applyNoiseParams({ ...DEFAULT_NOISE_PARAMS, density: 100 });
    expect(style.getPropertyValue('--fx-noise-size')).toBe('64px'); // finest grain
  });

  it('applyFlickerParams maps frequency to 1/f duration and depth to the dim floor', () => {
    applyFlickerParams(DEFAULT_FLICKER_PARAMS);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-flicker-duration')).toBe('0.125s');
    expect(style.getPropertyValue('--fx-flicker-min')).toBe('0.92');
    applyFlickerParams({ frequency: 2, depth: 40 });
    expect(style.getPropertyValue('--fx-flicker-duration')).toBe('0.500s');
    expect(style.getPropertyValue('--fx-flicker-min')).toBe('0.60');
  });

  it('applyInterferenceParams writes the burst period var and the #ez-fx-keyframes block', () => {
    document.getElementById('ez-fx-keyframes')?.remove();
    applyInterferenceParams(DEFAULT_INTERFERENCE_PARAMS);
    expect(document.documentElement.style.getPropertyValue('--fx-burst-period')).toBe('5s');
    const el = document.getElementById('ez-fx-keyframes');
    expect(el).toBeInstanceOf(HTMLStyleElement);
    expect(el?.textContent).toContain('@keyframes fx-jitter-burst');
    expect(el?.textContent).toContain('@keyframes fx-burst-flash');
    // idempotent element reuse: a second apply must not create a duplicate
    applyInterferenceParams(DEFAULT_INTERFERENCE_PARAMS);
    expect(document.querySelectorAll('#ez-fx-keyframes').length).toBe(1);
  });
});
