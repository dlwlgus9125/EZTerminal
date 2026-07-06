import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadUiScale, saveUiScale } from './ui-scale';

describe('ui-scale (mobile)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 100 when nothing is persisted', () => {
    expect(loadUiScale()).toBe(100);
  });

  it('loads a persisted percent', () => {
    localStorage.setItem('ezterminal-mobile-ui-scale', '130');
    expect(loadUiScale()).toBe(130);
  });

  it('rejects a corrupt stored value, defaulting to 100', () => {
    localStorage.setItem('ezterminal-mobile-ui-scale', 'not-a-number');
    expect(loadUiScale()).toBe(100);
  });

  it('round-trips save/load', () => {
    saveUiScale(120);
    expect(loadUiScale()).toBe(120);
  });

  it('clamps an out-of-range value on save', () => {
    saveUiScale(999);
    expect(loadUiScale()).toBe(150);
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

    it('loadUiScale falls back to 100 instead of throwing', () => {
      expect(() => loadUiScale()).not.toThrow();
      expect(loadUiScale()).toBe(100);
    });

    it('saveUiScale is a silent no-op instead of throwing', () => {
      expect(() => saveUiScale(110)).not.toThrow();
    });
  });
});
