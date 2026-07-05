import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, loadTheme, saveTheme } from './theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to dark when nothing is persisted', () => {
    expect(loadTheme()).toBe('dark');
  });

  it('loads a persisted theme', () => {
    localStorage.setItem('ezterminal-mobile-theme', 'matrix');
    expect(loadTheme()).toBe('matrix');
  });

  it('rejects a garbage value, defaulting to dark', () => {
    localStorage.setItem('ezterminal-mobile-theme', 'not-a-theme');
    expect(loadTheme()).toBe('dark');
  });

  it('round-trips save/load', () => {
    saveTheme('high-contrast');
    expect(loadTheme()).toBe('high-contrast');
  });

  it('applyTheme sets the dataset, dispatches ez:theme, and logs the e2e marker', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const listener = vi.fn();
    window.addEventListener('ez:theme', listener);

    applyTheme('light');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[ez-e2e] theme:', 'light');

    window.removeEventListener('ez:theme', listener);
    logSpy.mockRestore();
  });
});
