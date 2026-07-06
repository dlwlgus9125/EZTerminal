import { describe, expect, it } from 'vitest';

import { decideTabSwipe } from './tab-swipe';

describe('decideTabSwipe', () => {
  it('swipe left (dx<0) past the threshold advances to the next tab', () => {
    expect(decideTabSwipe({ dx: -80, dy: 0, scrollDelta: 0 })).toBe('next');
  });

  it('swipe right (dx>0) past the threshold goes to the previous tab', () => {
    expect(decideTabSwipe({ dx: 80, dy: 0, scrollDelta: 0 })).toBe('prev');
  });

  it('rejects when dy exceeds the vertical tolerance', () => {
    expect(decideTabSwipe({ dx: 80, dy: 41, scrollDelta: 0 })).toBeNull();
  });

  it('rejects when dx is below the horizontal threshold', () => {
    expect(decideTabSwipe({ dx: 59, dy: 0, scrollDelta: 0 })).toBeNull();
  });

  it('suppresses a would-be swipe when the strip actually scrolled', () => {
    expect(decideTabSwipe({ dx: 80, dy: 0, scrollDelta: 25 })).toBeNull();
    expect(decideTabSwipe({ dx: -80, dy: 0, scrollDelta: -25 })).toBeNull();
  });

  it('still switches when the strip is pinned at an overflow edge (scrollDelta 0)', () => {
    expect(decideTabSwipe({ dx: -80, dy: 0, scrollDelta: 0 })).toBe('next');
  });
});
