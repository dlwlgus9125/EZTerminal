import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_INTERFERENCE_PARAMS,
  DEFAULT_ROLLBAR_PARAMS,
  clampInterferenceParams,
} from '../../src/renderer/effect-params';
import { EFFECT_CATALOG } from '../../src/renderer/effects';
import {
  MOBILE_EFFECT_DEFAULTS,
  MOBILE_ROLLBAR_DEFAULTS,
  applyTheme,
  loadEffectParams,
  loadTheme,
  saveEffectParams,
  saveTheme,
} from './theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to matrix when nothing is persisted', () => {
    expect(loadTheme()).toBe('matrix');
  });

  it('loads a persisted theme', () => {
    localStorage.setItem('ezterminal-mobile-theme', 'light');
    expect(loadTheme()).toBe('light');
  });

  it('rejects a garbage value, defaulting to matrix', () => {
    localStorage.setItem('ezterminal-mobile-theme', 'not-a-theme');
    expect(loadTheme()).toBe('matrix');
  });

  it('round-trips save/load', () => {
    saveTheme('high-contrast');
    expect(loadTheme()).toBe('high-contrast');
  });

  it('applyTheme sets the dataset and dispatches ez:theme without production telemetry', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const listener = vi.fn();
    window.addEventListener('ez:theme', listener);

    applyTheme('light');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();

    window.removeEventListener('ez:theme', listener);
    logSpy.mockRestore();
  });
});

describe('effect params persistence (crt-interference)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips save/load through clamp', () => {
    const next = clampInterferenceParams({ 'jitter-burst': { period: 12 }, flicker: { depth: 20 } });
    saveEffectParams(next);
    const reloaded = clampInterferenceParams(loadEffectParams());
    expect(reloaded['jitter-burst'].period).toBe(12);
    expect(reloaded.flicker.depth).toBe(20);
    expect(reloaded['micro-jitter']).toEqual(DEFAULT_INTERFERENCE_PARAMS['micro-jitter']);
  });

  it('falls back to defaults when nothing is persisted', () => {
    expect(clampInterferenceParams(loadEffectParams())).toEqual(DEFAULT_INTERFERENCE_PARAMS);
  });

  it('survives corrupt stored JSON, defaulting everything', () => {
    localStorage.setItem('ezterminal-mobile-effect-params', '{not json');
    expect(clampInterferenceParams(loadEffectParams())).toEqual(DEFAULT_INTERFERENCE_PARAMS);
  });

  it('applyTheme applies persisted interference params (burst period var + keyframes el)', () => {
    saveEffectParams(clampInterferenceParams({ 'jitter-burst': { period: 9 } }));
    applyTheme('matrix');
    expect(document.documentElement.style.getPropertyValue('--fx-burst-period')).toBe('9s');
    expect(document.getElementById('ez-fx-keyframes')?.textContent).toContain('@keyframes fx-jitter-burst');
  });
});

describe('mobile effect defaults', () => {
  it('starts a fresh install in the CRT Signature profile and nothing heavier', () => {
    // A default of "everything off" made a new install disagree with its own
    // design: a bare grid, and a settings preview reading "0 effects".
    expect(MOBILE_EFFECT_DEFAULTS.scanlines).toBe(true);
    expect(MOBILE_EFFECT_DEFAULTS['phosphor-glow']).toBe(true);
    expect(MOBILE_EFFECT_DEFAULTS['crt-rollbar']).toBe(true);
    // The interference effects cost frames on a phone and were never part of
    // the signature.
    expect(MOBILE_EFFECT_DEFAULTS.flicker).toBe(false);
    expect(MOBILE_EFFECT_DEFAULTS['jitter-burst']).toBe(false);
    expect(MOBILE_EFFECT_DEFAULTS['micro-jitter']).toBe(false);
    expect(MOBILE_EFFECT_DEFAULTS['static-noise']).toBe(false);
  });

  it('covers every catalog entry, so a future effect is off unless it opts in', () => {
    for (const id of Object.keys(EFFECT_CATALOG)) {
      expect(typeof MOBILE_EFFECT_DEFAULTS[id as keyof typeof MOBILE_EFFECT_DEFAULTS]).toBe('boolean');
    }
  });

  it('uses the handoff band on mobile, not the desktop one', () => {
    // A monitor-tuned band reads as haze over text at phone reading distance.
    expect(MOBILE_ROLLBAR_DEFAULTS.thickness).toBe(130);
    expect(MOBILE_ROLLBAR_DEFAULTS.opacity).toBe(5);
    expect(MOBILE_ROLLBAR_DEFAULTS.thickness).not.toBe(DEFAULT_ROLLBAR_PARAMS.thickness);
  });
});
