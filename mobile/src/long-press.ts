import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

// long-press.ts — a touch-friendly long-press gesture (file-explorer plan,
// M4): fires after `ms` (default 500) of a pointer staying down within
// `moveTolerancePx` (default 10) of where it started, unless interrupted by
// a pointerup/pointercancel/scroll first — the scroll cancellation is what
// resolves the classic "long-press vs. list-scroll" conflict (a press that
// turns into a scroll must never also pop the action sheet).
//
// The timing/cancellation state machine (`LongPressTracker`) is a plain
// class with no React dependency, exported so it can be unit-tested directly
// (same "plain class does the real work" shape as `BlockController` —
// `long-press.test.ts` drives it with `vi.useFakeTimers()`, no React
// rendering needed). `useLongPress` is a thin hook wrapper around one
// instance, kept stable across renders via `useRef`.

const DEFAULT_MS = 500;
const DEFAULT_MOVE_TOLERANCE_PX = 10;

export class LongPressTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private start: { readonly x: number; readonly y: number } | null = null;

  constructor(
    private readonly onFire: (x: number, y: number) => void,
    private readonly ms: number = DEFAULT_MS,
    private readonly moveTolerancePx: number = DEFAULT_MOVE_TOLERANCE_PX,
  ) {}

  /** Pointer went down at `(x, y)` — (re)arms the timer, canceling any prior one. */
  down(x: number, y: number): void {
    this.cancel();
    this.start = { x, y };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onFire(x, y);
    }, this.ms);
  }

  /** Pointer moved to `(x, y)` — cancels a pending press once it strays past `moveTolerancePx`. */
  move(x: number, y: number): void {
    if (!this.start) return;
    if (Math.hypot(x - this.start.x, y - this.start.y) > this.moveTolerancePx) this.cancel();
  }

  /** Pointerup/pointercancel/scroll all funnel here — abandons a pending press, if any. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.start = null;
  }
}

export interface LongPressOptions {
  readonly ms?: number;
  readonly moveTolerancePx?: number;
}

export interface LongPressHandlers {
  readonly onPointerDown: (e: ReactPointerEvent) => void;
  readonly onPointerMove: (e: ReactPointerEvent) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  /** Some WebViews synthesize a native `contextmenu` on a long touch — this
   * suppresses the garbage browser menu that would otherwise pop instead of
   * (or on top of) the custom action sheet. */
  readonly onContextMenu: (e: ReactMouseEvent) => void;
  /** Attach to the SCROLLABLE ANCESTOR (the list container), not the row
   * itself — a row never scrolls on its own. */
  readonly onScroll: () => void;
}

export function useLongPress(
  callback: (x: number, y: number) => void,
  options: LongPressOptions = {},
): LongPressHandlers {
  // Latest callback in a ref (not a tracker constructor arg) so a fresh
  // inline closure from the caller on every render doesn't require
  // recreating the tracker (and doesn't affect an already-armed timer).
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const trackerRef = useRef<LongPressTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new LongPressTracker(
      (x, y) => callbackRef.current(x, y),
      options.ms,
      options.moveTolerancePx,
    );
  }
  const tracker = trackerRef.current;

  const onPointerDown = useCallback((e: ReactPointerEvent) => tracker.down(e.clientX, e.clientY), [tracker]);
  const onPointerMove = useCallback((e: ReactPointerEvent) => tracker.move(e.clientX, e.clientY), [tracker]);
  const onPointerUp = useCallback(() => tracker.cancel(), [tracker]);
  const onPointerCancel = useCallback(() => tracker.cancel(), [tracker]);
  const onScroll = useCallback(() => tracker.cancel(), [tracker]);
  const onContextMenu = useCallback((e: ReactMouseEvent) => e.preventDefault(), []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, onScroll };
}
