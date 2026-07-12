import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOpenClawMode, saveOpenClawMode } from './openclaw-mode';

describe('openclaw-mode (mobile)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to auto when nothing is persisted', () => {
    expect(loadOpenClawMode()).toBe('auto');
  });

  it('loads a persisted mode', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'on');
    expect(loadOpenClawMode()).toBe('on');
  });

  it('rejects a corrupt/unrecognized stored value, defaulting to auto', () => {
    localStorage.setItem('ezterminal-mobile-openclaw-mode', 'nonsense');
    expect(loadOpenClawMode()).toBe('auto');
  });

  it('round-trips save/load', () => {
    saveOpenClawMode('off');
    expect(loadOpenClawMode()).toBe('off');
  });

  describe('when localStorage throws (private browsing / quota)', () => {
    beforeEach(() => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('access denied');
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('loadOpenClawMode falls back to auto instead of throwing', () => {
      expect(() => loadOpenClawMode()).not.toThrow();
      expect(loadOpenClawMode()).toBe('auto');
    });

    it('saveOpenClawMode is a silent no-op instead of throwing', () => {
      expect(() => saveOpenClawMode('on')).not.toThrow();
    });
  });
});
