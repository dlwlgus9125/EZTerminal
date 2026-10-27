import { useLayoutEffect, useRef } from 'react';

/**
 * Overlays a system Back closes before anything else (Android's Back button): an open menu or
 * popover registers here while it is open, and the phone's Back handler asks the newest one it can
 * see to close instead of leaving the screen. Desktop never asks, so this is inert there.
 *
 * "Covered" = inside a subtree the phone has isolated under a page or sheet (inert / aria-hidden).
 */
interface OpenOverlay {
  readonly dismiss: () => void;
  readonly drop: () => void;
  readonly element: () => Element | null;
}

const open: OpenOverlay[] = [];

function covered(entry: OpenOverlay): boolean {
  return entry.element()?.closest('[inert], [aria-hidden="true"]') != null;
}

/**
 * `dismiss` closes as Escape does (focus back to the trigger); `drop` closes without moving focus,
 * for when a page or sheet opens over the overlay and takes the focus. `element` is the overlay's
 * own root, to tell whether a page or sheet now covers it.
 */
export function useBackDismiss(active: boolean, dismiss: () => void, drop: () => void = dismiss, element: () => Element | null = () => null): void {
  const latest = useRef({ dismiss, drop, element });
  useLayoutEffect(() => {
    latest.current = { dismiss, drop, element };
  });
  useLayoutEffect(() => {
    if (!active) return undefined;
    const entry: OpenOverlay = { dismiss: () => latest.current.dismiss(), drop: () => latest.current.drop(), element: () => latest.current.element() };
    open.push(entry);
    return () => {
      const index = open.lastIndexOf(entry);
      if (index >= 0) open.splice(index, 1);
    };
  }, [active]);
}

/**
 * A page or sheet opened over the screen: once it has isolated what it covers, the menus and
 * popovers left open under it close (without moving focus), so the next Back closes what is on
 * top. A menu inside the new page or sheet itself is not covered and stays.
 */
export function dropCoveredOverlays(): void {
  for (const entry of [...open].reverse()) if (covered(entry)) entry.drop();
}

/** Closes the newest overlay not covered by a page or sheet; false when there is none (Back goes on as usual). */
export function dismissTopOverlay(): boolean {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const entry = open[index]!;
    if (covered(entry)) continue;
    entry.dismiss();
    return true;
  }
  return false;
}
