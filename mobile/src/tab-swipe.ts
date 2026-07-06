// tab-swipe.ts — pure swipe-vs-scroll decision for the mobile tab strip
// (v0.2.0 plan D4/M5). `.tab-strip` is horizontally scrollable
// (`overflow-x: auto`, to reveal tabs clipped by a narrow header) AND
// swipeable (TabStrip.tsx's touchstart/touchend switches tabs) — without
// this check, scrolling the strip also fires a tab switch. `scrollDelta`
// (the strip's scrollLeft at touchend minus its scrollLeft at touchstart)
// tells the two gestures apart: a real strip scroll moves scrollLeft, a
// swipe while the strip is already fully visible (or pinned at an overflow
// edge) does not.

export const SWIPE_MIN_DX = 60;
export const SWIPE_MAX_DY = 40;
export const SCROLL_SUPPRESS_PX = 10;

export interface TabSwipeInput {
  readonly dx: number;
  readonly dy: number;
  readonly scrollDelta: number;
}

/** Swipe left (dx<0, finger moving toward the start) advances to the next
 * tab; swipe right goes back to the previous one — the mapping TabStrip.tsx
 * used before this decision was extracted. */
export function decideTabSwipe({ dx, dy, scrollDelta }: TabSwipeInput): 'next' | 'prev' | null {
  if (Math.abs(scrollDelta) > SCROLL_SUPPRESS_PX) return null;
  if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dy) >= SWIPE_MAX_DY) return null;
  return dx < 0 ? 'next' : 'prev';
}
