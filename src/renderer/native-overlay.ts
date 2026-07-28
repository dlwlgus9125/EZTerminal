import { useLayoutEffect, useSyncExternalStore } from 'react';

type OverlayListener = () => void;

let activeOverlayCount = 0;
const listeners = new Set<OverlayListener>();

function publish(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One renderer subscriber must not strand the native view's visibility.
    }
  }
}

function subscribe(listener: OverlayListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return activeOverlayCount > 0;
}

/**
 * Registers a DOM surface that must paint above Electron WebContentsViews.
 * Electron native views always sit above the renderer DOM, so OpenClaw chat
 * subscribes to this process-local registry and hides while the count is nonzero.
 */
export function useNativeOverlayRegistration(active = true): void {
  useLayoutEffect(() => {
    if (!active) return;
    const wasOpen = activeOverlayCount > 0;
    activeOverlayCount += 1;
    if (!wasOpen) publish();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const wasLast = activeOverlayCount === 1;
      activeOverlayCount = Math.max(0, activeOverlayCount - 1);
      if (wasLast) publish();
    };
  }, [active]);
}

/** Returns whether any registered DOM surface currently occludes native views. */
export function useNativeOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
