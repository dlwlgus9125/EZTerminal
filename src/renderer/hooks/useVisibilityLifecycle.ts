/**
 * useVisibilityLifecycle — T7 hook.
 * Calls onStart/onStop based on panel visibility and window active state.
 *
 * Rules:
 * - open + window active  → start
 * - closed OR minimized   → stop
 * - rapid toggle: debounce guard prevents duplicate starts
 */

import { useEffect, useRef } from "react";

interface UseVisibilityLifecycleOptions {
  isVisible: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function useVisibilityLifecycle({
  isVisible,
  onStart,
  onStop,
}: UseVisibilityLifecycleOptions): void {
  const runningRef = useRef(false);
  const onStartRef = useRef(onStart);
  const onStopRef = useRef(onStop);

  // Keep refs current without re-triggering effect
  useEffect(() => {
    onStartRef.current = onStart;
    onStopRef.current = onStop;
  });

  // Derived: is window currently focused (not minimized/blurred)?
  const windowActiveRef = useRef(!document.hidden);

  useEffect(() => {
    function shouldRun(): boolean {
      return isVisible && windowActiveRef.current;
    }

    function start(): void {
      if (runningRef.current) return; // prevent duplicate start
      runningRef.current = true;
      onStartRef.current();
    }

    function stop(): void {
      if (!runningRef.current) return;
      runningRef.current = false;
      onStopRef.current();
    }

    function sync(): void {
      if (shouldRun()) {
        start();
      } else {
        stop();
      }
    }

    function handleVisibilityChange(): void {
      windowActiveRef.current = !document.hidden;
      sync();
    }

    function handleFocus(): void {
      windowActiveRef.current = true;
      sync();
    }

    function handleBlur(): void {
      windowActiveRef.current = false;
      sync();
    }

    // Initial sync
    sync();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isVisible]);
}
