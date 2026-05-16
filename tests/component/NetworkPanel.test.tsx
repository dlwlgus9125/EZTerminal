/**
 * Component tests for NetworkPanel [R-L3-06]
 * AC-L3-06-2: traffic rx/tx display
 * AC-L3-06-3: connection table
 * AC-L3-06-5: Npcap fallback UI
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficData } from "../../src/shared/network-types";

// Capture the onTraffic callback so tests can simulate pushes
let capturedOnTraffic: ((data: TrafficData) => void) | null = null;

beforeEach(() => {
  capturedOnTraffic = null;
  const api = window.electronAPI;
  vi.mocked(api.network.onTraffic).mockImplementation((cb) => {
    capturedOnTraffic = cb;
    return () => {
      capturedOnTraffic = null;
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { NetworkPanel } = await import(
  "../../src/renderer/components/panels/NetworkPanel/NetworkPanel"
);

function makeTraffic(overrides: Partial<TrafficData> = {}): TrafficData {
  return {
    rxBytesPerSec: 1024 * 512, // 512 KB/s
    txBytesPerSec: 1024 * 128, // 128 KB/s
    interface: "eth0",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Traffic display ──────────────────────────────────────────────────────────

describe("NetworkPanel traffic display", () => {
  it("renders -- placeholders before first traffic data", () => {
    render(<NetworkPanel isVisible={true} />);
    const metrics = document.querySelectorAll("[data-metric]");
    for (const el of metrics) {
      expect(el.textContent).toBe("--");
    }
  });

  it("AC-L3-06-2: renders rx after traffic push", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic({ rxBytesPerSec: 1024 * 1024 })); // 1 MB/s
    });
    const rx = document.querySelector("[data-metric='rx']");
    expect(rx?.textContent).toContain("MB/s");
  });

  it("AC-L3-06-2: renders tx after traffic push", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic({ txBytesPerSec: 2048 })); // 2 KB/s
    });
    const tx = document.querySelector("[data-metric='tx']");
    expect(tx?.textContent).toContain("KB/s");
  });

  it("AC-L3-06-2: renders interface name", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic({ interface: "wlan0" }));
    });
    expect(screen.getByText("wlan0")).toBeInTheDocument();
  });

  it("traffic section exists with data-testid", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='traffic-section']")).not.toBeNull();
  });

  it("root element has data-testid=network-panel", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='network-panel']")).not.toBeNull();
  });

  it("subsequent pushes update the displayed values", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic({ rxBytesPerSec: 100 }));
    });
    const rx1 = document.querySelector("[data-metric='rx']")?.textContent;

    act(() => {
      capturedOnTraffic?.(makeTraffic({ rxBytesPerSec: 2 * 1024 * 1024 }));
    });
    const rx2 = document.querySelector("[data-metric='rx']")?.textContent;
    expect(rx2).not.toBe(rx1);
  });
});

// ─── Connection table ─────────────────────────────────────────────────────────

describe("NetworkPanel connections", () => {
  it("AC-L3-06-3: shows empty state when no connections", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='connections-empty']")).not.toBeNull();
    expect(document.querySelector("[data-testid='connections-table']")).toBeNull();
  });

  it("AC-L3-06-3: connections section exists", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='connections-section']")).not.toBeNull();
  });
});

// ─── Npcap fallback UI ────────────────────────────────────────────────────────

describe("Network npcap fallback UI", () => {
  it("AC-L3-06-5: shows npcap-fallback when npcapAvailable=false", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    expect(document.querySelector("[data-testid='npcap-fallback']")).not.toBeNull();
    expect(document.querySelector("[data-testid='capture-active']")).toBeNull();
  });

  it("AC-L3-06-5: fallback contains install link with href", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    const link = document.querySelector("[data-testid='npcap-install-link']") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link?.href).toContain("npcap.com");
  });

  it("AC-L3-06-5: fallback text mentions Npcap", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    const fallback = document.querySelector("[data-testid='npcap-fallback']");
    expect(fallback?.textContent?.toLowerCase()).toContain("npcap");
  });

  it("AC-L3-06-5: shows capture-active when npcapAvailable=true", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={true} />);
    expect(document.querySelector("[data-testid='capture-active']")).not.toBeNull();
    expect(document.querySelector("[data-testid='npcap-fallback']")).toBeNull();
  });

  it("AC-L3-06-5: default prop npcapAvailable=false shows fallback", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='npcap-fallback']")).not.toBeNull();
  });

  it("capture section exists with data-testid", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(document.querySelector("[data-testid='capture-section']")).not.toBeNull();
  });
});

// ─── IPC lifecycle ────────────────────────────────────────────────────────────

describe("NetworkPanel IPC lifecycle", () => {
  it("calls network.startCapture when visible", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(window.electronAPI.network.startCapture).toHaveBeenCalledOnce();
  });

  it("calls network.stopCapture on unmount", () => {
    const { unmount } = render(<NetworkPanel isVisible={true} />);
    unmount();
    expect(window.electronAPI.network.stopCapture).toHaveBeenCalledOnce();
  });

  it("does not call network.startCapture when not visible", () => {
    render(<NetworkPanel isVisible={false} />);
    expect(window.electronAPI.network.startCapture).not.toHaveBeenCalled();
  });
});
