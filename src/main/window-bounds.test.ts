import { describe, expect, it } from 'vitest';

import { clampWindowBounds } from './window-bounds';

describe('clampWindowBounds', () => {
  const workArea = { x: -1920, y: 0, width: 1920, height: 1040 };

  it('keeps valid multi-monitor coordinates unchanged', () => {
    expect(clampWindowBounds(
      { x: -1600, y: 120, width: 900, height: 620 },
      workArea,
    )).toEqual({ x: -1600, y: 120, width: 900, height: 620 });
  });

  it('clamps offscreen and undersized restored bounds into the work area', () => {
    expect(clampWindowBounds(
      { x: 4000, y: -500, width: 100, height: 100 },
      workArea,
    )).toEqual({ x: -480, y: 0, width: 480, height: 320 });
  });

  it('fits a window to a work area smaller than the normal minimum', () => {
    expect(clampWindowBounds(
      { x: 0, y: 0, width: 900, height: 700 },
      { x: 10, y: 20, width: 320, height: 240 },
    )).toEqual({ x: 10, y: 20, width: 320, height: 240 });
  });
});
