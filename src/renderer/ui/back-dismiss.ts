import { useLayoutEffect, useRef } from 'react';

/**
 * Overlays a system Back closes before anything else (Android's Back button): an open menu or
 * popover registers here while it is open, and the phone's Back handler asks the newest one to
 * close instead of leaving the screen. Desktop never asks, so this is inert there.
 */
const open: { readonly dismiss: () => void }[] = [];

export function useBackDismiss(active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  useLayoutEffect(() => {
    latest.current = dismiss;
  });
  useLayoutEffect(() => {
    if (!active) return undefined;
    const entry = { dismiss: () => latest.current() };
    open.push(entry);
    return () => {
      const index = open.lastIndexOf(entry);
      if (index >= 0) open.splice(index, 1);
    };
  }, [active]);
}

/** Closes the newest open overlay; false when none is open (Back then goes on as usual). */
export function dismissTopOverlay(): boolean {
  const top = open[open.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}
