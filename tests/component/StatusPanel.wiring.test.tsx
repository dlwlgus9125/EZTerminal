/**
 * Wiring tests for StatusPanel [R-L3-05]
 * W1: isVisible=true → metrics:start IPC + onUpdate subscription
 * W2: isVisible=false (or unmount) → metrics:stop + unsubscribe
 * W3: onUpdate data → state → rendered metrics values
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsData } from "../../src/shared/metrics-types";

// Capture the onUpdate callback so tests can simulate pushes
let capturedOnUpdate: ((data: MetricsData) => void) | null = null;

beforeEach(() => {
  capturedOnUpdate = null;

  const api = window.electronAPI;
  // Return a plain mock function (not one that recursively calls itself)
  vi.mocked(api.metrics.onUpdate).mockImplementation((cb) => {
    capturedOnUpdate = cb;
    return vi.fn(); // unsub stub — caller uses .mock.results to get it
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { StatusPanel } = await import(
  "../../src/renderer/components/panels/StatusPanel/StatusPanel"
);

function makeMetrics(): MetricsData {
  return {
    cpu: { usage: 72.1, cores: [60, 84] },
    memory: { total: 8e9, used: 4e9, free: 4e9 },
    disk: { readBytesPerSec: 500, writeBytesPerSec: 250 },
    timestamp: Date.now(),
  };
}

describe("W1 isVisible → start + subscribe", () => {
  it("visible=true calls metrics.start", () => {
    render(<StatusPanel isVisible={true} />);
    expect(window.electronAPI.metrics.start).toHaveBeenCalledOnce();
  });

  it("visible=true calls metrics.onUpdate to subscribe", () => {
    render(<StatusPanel isVisible={true} />);
    expect(window.electronAPI.metrics.onUpdate).toHaveBeenCalledOnce();
  });

  it("visible=false does not call metrics.start", () => {
    render(<StatusPanel isVisible={false} />);
    expect(window.electronAPI.metrics.start).not.toHaveBeenCalled();
  });

  it("visible=false does not subscribe via onUpdate", () => {
    render(<StatusPanel isVisible={false} />);
    expect(window.electronAPI.metrics.onUpdate).not.toHaveBeenCalled();
  });
});

describe("W2 invisible/unmount → stop + unsubscribe", () => {
  it("unmount calls metrics.stop", () => {
    const { unmount } = render(<StatusPanel isVisible={true} />);
    unmount();
    expect(window.electronAPI.metrics.stop).toHaveBeenCalledOnce();
  });

  it("unmount calls the unsubscribe function returned by onUpdate", () => {
    const { unmount } = render(<StatusPanel isVisible={true} />);
    // Get the unsub fn that was returned by the mock
    const unsub = window.electronAPI.metrics.onUpdate.mock.results[0]
      ?.value as unknown as ReturnType<typeof vi.fn>;
    unmount();
    expect(unsub).toHaveBeenCalledOnce();
  });
});

describe("W3 onUpdate data → rendered values", () => {
  it("data from onUpdate appears in [data-metric='cpu-usage']", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const el = document.querySelector("[data-metric='cpu-usage']");
    expect(el?.textContent).toBe("72.1%");
  });

  it("data from onUpdate appears in [data-metric='mem-used']", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const el = document.querySelector("[data-metric='mem-used']");
    // 4e9 bytes ≈ 3.7 GB
    expect(el?.textContent).toMatch(/GB/);
  });

  it("data from onUpdate appears in [data-metric='disk-read']", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const el = document.querySelector("[data-metric='disk-read']");
    expect(el?.textContent).toContain("/s");
  });

  it("subsequent pushes update the rendered values", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.({ ...makeMetrics(), cpu: { usage: 10, cores: [] } });
    });
    expect(document.querySelector("[data-metric='cpu-usage']")?.textContent).toBe("10.0%");

    act(() => {
      capturedOnUpdate?.({ ...makeMetrics(), cpu: { usage: 95.5, cores: [] } });
    });
    expect(document.querySelector("[data-metric='cpu-usage']")?.textContent).toBe("95.5%");
  });
});
