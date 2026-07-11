import { describe, expect, it } from 'vitest';

import { TouchScrollAccumulator } from './touch-scroll';

describe('TouchScrollAccumulator', () => {
  it('accumulates sub-cell jitter until a whole cell is reached', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(5, 17)).toBe(0);
    expect(acc.feed(5, 17)).toBe(0);
    // 5+5+8 = 18 → one 17px cell, 1px residual carried
    expect(acc.feed(8, 17)).toBe(1);
    // residual 1 + 16 = 17 → next cell exactly
    expect(acc.feed(16, 17)).toBe(1);
  });

  it('emits multiple steps for a large fling delta', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(100, 20)).toBe(5);
    expect(acc.feed(-100, 20)).toBe(-5);
  });

  it('handles direction reversal mid-gesture without jumping a cell early', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(30, 20)).toBe(1); // residual +10
    expect(acc.feed(-15, 20)).toBe(0); // residual -5 — no step yet
    expect(acc.feed(-16, 20)).toBe(-1); // residual -21 → one step down, -1 carried
  });

  it('uses the cell height of each call (font rescale mid-gesture)', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(9, 10)).toBe(0); // residual 9
    expect(acc.feed(11, 20)).toBe(1); // 9+11 = 20 → one 20px cell
  });

  it('reset drops the carried residual', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(19, 20)).toBe(0);
    acc.reset();
    expect(acc.feed(1, 20)).toBe(0); // 19 was dropped — 1px is not a step
  });

  it('ignores unmeasurable cell heights and non-finite deltas', () => {
    const acc = new TouchScrollAccumulator();
    expect(acc.feed(100, 0)).toBe(0);
    expect(acc.feed(100, -5)).toBe(0);
    expect(acc.feed(Number.NaN, 20)).toBe(0);
    expect(acc.feed(Number.POSITIVE_INFINITY, 20)).toBe(0);
    // guards above must not have polluted the residual
    expect(acc.feed(20, 20)).toBe(1);
  });
});
