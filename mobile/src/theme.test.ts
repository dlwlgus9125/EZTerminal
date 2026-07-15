import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_INTERFERENCE_PARAMS,
  clampInterferenceParams,
} from '../../src/renderer/effect-params';
import { applyTheme, loadEffectParams, loadTheme, saveEffectParams, saveTheme } from './theme';

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
