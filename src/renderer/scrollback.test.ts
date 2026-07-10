import { describe, expect, it } from 'vitest';

import { SCROLLBACK_DEFAULT, SCROLLBACK_MAX, SCROLLBACK_MIN, clampScrollback } from './scrollback';

describe('clampScrollback', () => {
  it('rounds a fractional value', () => {
    expect(clampScrollback(4999.6)).toBe(5000);
  });

  it('clamps above the max down to 100000', () => {
    expect(clampScrollback(500000)).toBe(SCROLLBACK_MAX);
  });

  it('clamps below the min up to 100', () => {
    expect(clampScrollback(10)).toBe(SCROLLBACK_MIN);
  });

  it('falls back to 5000 for non-finite input', () => {
    expect(clampScrollback(Number.NaN)).toBe(SCROLLBACK_DEFAULT);
    expect(clampScrollback(undefined as unknown as number)).toBe(SCROLLBACK_DEFAULT);
  });

  it('leaves an already-valid value unchanged', () => {
    expect(clampScrollback(5000)).toBe(5000);
    expect(clampScrollback(SCROLLBACK_MIN)).toBe(SCROLLBACK_MIN);
    expect(clampScrollback(SCROLLBACK_MAX)).toBe(SCROLLBACK_MAX);
  });
});
