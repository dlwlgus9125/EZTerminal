/**
 * Tests for useVisibilityLifecycle hook [R-L3-02]
 * AC-L3-02-1: open → start
 * AC-L3-02-2: close → stop
 * AC-L3-02-3: minimize → stop
 * AC-L3-02-N1: rapid toggle no duplicate start
 */

import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibilityLifecycle } from "../../src/renderer/hooks/useVisibilityLifecycle";

describe("visibility start", () => {
  afterEach(() => cleanup());

  it("AC-L3-02-1: isVisible=true calls onStart", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    renderHook(() => useVisibilityLifecycle({ isVisible: true, onStart, onStop }));
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("AC-L3-02-1: isVisible=false does not call onStart", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    renderHook(() => useVisibilityLifecycle({ isVisible: false, onStart, onStop }));
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("visibility stop", () => {
  afterEach(() => cleanup());

  it("AC-L3-02-2: panel closes → onStop called", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = renderHook(
      ({ isVisible }: { isVisible: boolean }) =>
        useVisibilityLifecycle({ isVisible, onStart, onStop }),
      { initialProps: { isVisible: true } }
    );
    expect(onStart).toHaveBeenCalledOnce();
    rerender({ isVisible: false });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("AC-L3-02-2: unmount while running calls onStop", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { unmount } = renderHook(() =>
      useVisibilityLifecycle({ isVisible: true, onStart, onStop })
    );
    expect(onStart).toHaveBeenCalledOnce();
    unmount();
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe("visibility minimize", () => {
  afterEach(() => {
    cleanup();
    // Restore document.hidden
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
  });

  it("AC-L3-02-3: visibilitychange hidden → onStop", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    renderHook(() => useVisibilityLifecycle({ isVisible: true, onStart, onStop }));
    expect(onStart).toHaveBeenCalledOnce();

    act(() => {
      Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(onStop).toHaveBeenCalledOnce();
  });

  it("AC-L3-02-3: visibilitychange visible again → onStart resumes", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    renderHook(() => useVisibilityLifecycle({ isVisible: true, onStart, onStop }));
    expect(onStart).toHaveBeenCalledOnce();

    // Hide
    act(() => {
      Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onStop).toHaveBeenCalledOnce();

    // Restore
    act(() => {
      Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onStart).toHaveBeenCalledTimes(2);
  });
});

describe("visibility rapid toggle", () => {
  afterEach(() => cleanup());

  it("AC-L3-02-N1: rapid open/close/open does not duplicate start", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    let isVisible = true;

    const { rerender } = renderHook(
      ({ isVisible: v }: { isVisible: boolean }) =>
        useVisibilityLifecycle({ isVisible: v, onStart, onStop }),
      { initialProps: { isVisible } }
    );

    // open → close → open rapidly
    rerender({ isVisible: false });
    rerender({ isVisible: true });

    // onStart called twice (initial + re-open), onStop once
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("AC-L3-02-N1: double open does not call onStart twice", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();

    // Start running
    renderHook(() => useVisibilityLifecycle({ isVisible: true, onStart, onStop }));
    expect(onStart).toHaveBeenCalledOnce();

    // Trigger focus event while already running
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Should still be only 1 call
    expect(onStart).toHaveBeenCalledOnce();
  });
});
