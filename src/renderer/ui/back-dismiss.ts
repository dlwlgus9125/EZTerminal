import { useLayoutEffect, useRef } from 'react';

/**
 * Overlays a system Back closes before anything else (Android's Back button): an open menu or
 * popover registers here while it is open, and the phone's Back handler asks the newest one to
 * close instead of leaving the screen. Desktop never asks, so this is inert there.
 */
const open: { readonly dismiss: () => void; readonly drop: () => void }[] = [];

/**
 * `dismiss` closes as Escape does (focus back to the trigger); `drop` closes without moving focus,
 * for when something else opens over the overlay and takes the focus.
 */
export function useBackDismiss(active: boolean, dismiss: () => void, drop: () => void = dismiss): void {
  const latest = useRef({ dismiss, drop });
  useLayoutEffect(() => {
    latest.current = { dismiss, drop };
  });
  useLayoutEffect(() => {
    if (!active) return undefined;
    const entry = { dismiss: () => latest.current.dismiss(), drop: () => latest.current.drop() };
    open.push(entry);
    return () => {
      const index = open.lastIndexOf(entry);
      if (index >= 0) open.splice(index, 1);
    };
  }, [active]);
}

/**
 * A page or sheet opens over the screen: the menus and popovers still open on the screen below close
 * (without moving focus), so the next Back closes what is on top, not something hidden under it.
 */
export function dropAllOverlays(): void {
  for (const entry of [...open].reverse()) entry.drop();
}

/** Closes the newest open overlay; false when none is open (Back then goes on as usual). */
export function dismissTopOverlay(): boolean {
  const top = open[open.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}
