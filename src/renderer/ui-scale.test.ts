import { describe, expect, it } from 'vitest';

import { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN, clampUiScale } from './ui-scale';

describe('clampUiScale', () => {
  it('snaps to the nearest 10 step', () => {
    expect(clampUiScale(87)).toBe(90);
  });

  it('clamps above the max down to 150', () => {
    expect(clampUiScale(200)).toBe(UI_SCALE_MAX);
  });

  it('clamps below the min up to 80', () => {
    expect(clampUiScale(10)).toBe(UI_SCALE_MIN);
  });

  it('falls back to 100 for non-finite input', () => {
    expect(clampUiScale(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScale(undefined as unknown as number)).toBe(UI_SCALE_DEFAULT);
  });

  it('leaves an already-valid value unchanged', () => {
    expect(clampUiScale(100)).toBe(100);
    expect(clampUiScale(UI_SCALE_MIN)).toBe(UI_SCALE_MIN);
    expect(clampUiScale(UI_SCALE_MAX)).toBe(UI_SCALE_MAX);
  });
});
