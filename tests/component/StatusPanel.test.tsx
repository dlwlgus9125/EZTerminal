/**
 * Component tests for StatusPanel [R-L3-05]
 * AC-L3-05-3: CPU/mem/disk rendering
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsData } from "../../src/shared/metrics-types";

// Capture the onUpdate callback so tests can simulate pushes
let capturedOnUpdate: ((data: MetricsData) => void) | null = null;

beforeEach(() => {
  capturedOnUpdate = null;
  const api = window.electronAPI;
  vi.mocked(api.metrics.onUpdate).mockImplementation((cb) => {
    capturedOnUpdate = cb;
    return () => {
      capturedOnUpdate = null;
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { StatusPanel } = await import(
  "../../src/renderer/components/panels/StatusPanel/StatusPanel"
);

function makeMetrics(overrides: Partial<MetricsData> = {}): MetricsData {
  return {
    cpu: { usage: 55.3, cores: [40, 70] },
    memory: {
      total: 16 * 1024 * 1024 * 1024,
      used: 8 * 1024 * 1024 * 1024,
      free: 8 * 1024 * 1024 * 1024,
    },
    disk: { readBytesPerSec: 2 * 1024 * 1024, writeBytesPerSec: 1 * 1024 * 1024 },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("StatusPanel render", () => {
  it("AC-L3-05-3: renders placeholder '--' before first metrics arrive", () => {
    render(<StatusPanel isVisible={true} />);
    const values = document.querySelectorAll("[data-metric]");
    for (const el of values) {
      expect(el.textContent).toBe("--");
    }
  });

  it("AC-L3-05-3: renders CPU usage after metrics push", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    expect(screen.getByText("55.3%")).toBeInTheDocument();
  });

  it("AC-L3-05-3: renders memory used in GB", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const memUsed = document.querySelector("[data-metric='mem-used']");
    expect(memUsed?.textContent).toContain("GB");
  });

  it("AC-L3-05-3: renders disk read per second", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const diskRead = document.querySelector("[data-metric='disk-read']");
    expect(diskRead?.textContent).toContain("/s");
  });

  it("AC-L3-05-3: renders disk write per second", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics());
    });
    const diskWrite = document.querySelector("[data-metric='disk-write']");
    expect(diskWrite?.textContent).toContain("/s");
  });

  it("AC-L3-05-3: has cpu/memory/disk sections", () => {
    render(<StatusPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='cpu-section']")).not.toBeNull();
    expect(document.querySelector("[data-testid='memory-section']")).not.toBeNull();
    expect(document.querySelector("[data-testid='disk-section']")).not.toBeNull();
  });

  it("AC-L3-05-3: root element has data-testid=status-panel", () => {
    render(<StatusPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='status-panel']")).not.toBeNull();
  });

  it("updates when new metrics arrive", () => {
    render(<StatusPanel isVisible={true} />);
    act(() => {
      capturedOnUpdate?.(makeMetrics({ cpu: { usage: 10, cores: [] } }));
    });
    expect(screen.getByText("10.0%")).toBeInTheDocument();

    act(() => {
      capturedOnUpdate?.(makeMetrics({ cpu: { usage: 88.8, cores: [] } }));
    });
    expect(screen.getByText("88.8%")).toBeInTheDocument();
  });
});

describe("StatusPanel IPC lifecycle", () => {
  it("calls metrics.start when visible", () => {
    render(<StatusPanel isVisible={true} />);
    expect(window.electronAPI.metrics.start).toHaveBeenCalledOnce();
  });

  it("calls metrics.stop on unmount", () => {
    const { unmount } = render(<StatusPanel isVisible={true} />);
    unmount();
    expect(window.electronAPI.metrics.stop).toHaveBeenCalledOnce();
  });

  it("does not call metrics.start when not visible", () => {
    render(<StatusPanel isVisible={false} />);
    expect(window.electronAPI.metrics.start).not.toHaveBeenCalled();
  });
});
