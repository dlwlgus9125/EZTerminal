// tab-swipe.ts — pure swipe-vs-scroll decision for switching terminal tabs.
// The gesture now lives on the terminal header (the tab strip it was written
// for is gone), and that header can itself scroll horizontally, so the same
// ambiguity remains: without this check, scrolling the header would also fire
// a tab switch. `scrollDelta` (the element's scrollLeft at touchend minus its
// scrollLeft at touchstart) tells the two apart — a real scroll moves
// scrollLeft, a swipe on content that is already fully visible (or pinned at
// an overflow edge) does not.

export const SWIPE_MIN_DX = 60;
export const SWIPE_MAX_DY = 40;
export const SCROLL_SUPPRESS_PX = 10;

export interface TabSwipeInput {
  readonly dx: number;
  readonly dy: number;
  readonly scrollDelta: number;
}

/** Swipe left (dx<0, finger moving toward the start) advances to the next
 * tab; swipe right goes back to the previous one — the mapping the tab strip
 * used before this decision was extracted. */
export function decideTabSwipe({ dx, dy, scrollDelta }: TabSwipeInput): 'next' | 'prev' | null {
  if (Math.abs(scrollDelta) > SCROLL_SUPPRESS_PX) return null;
  if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dy) >= SWIPE_MAX_DY) return null;
  return dx < 0 ? 'next' : 'prev';
}
