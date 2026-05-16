/**
 * Wiring tests for NetworkPanel [R-L3-06]
 * W1: isVisible=true → network:start IPC + onTraffic subscription
 * W2: isVisible=false (or unmount) → network:stop + unsubscribe
 * W3: onTraffic data → state → rendered traffic values
 * W4: npcapAvailable=false → npcap fallback UI shown
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficData } from "../../src/shared/network-types";

let capturedOnTraffic: ((data: TrafficData) => void) | null = null;

beforeEach(() => {
  capturedOnTraffic = null;
  const api = window.electronAPI;
  vi.mocked(api.network.onTraffic).mockImplementation((cb) => {
    capturedOnTraffic = cb;
    return vi.fn();
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { NetworkPanel } = await import(
  "../../src/renderer/components/panels/NetworkPanel/NetworkPanel"
);

function makeTraffic(): TrafficData {
  return {
    rxBytesPerSec: 1024 * 100,
    txBytesPerSec: 1024 * 50,
    interface: "eth0",
    timestamp: Date.now(),
  };
}

// ─── W1: visible → start + subscribe ─────────────────────────────────────────

describe("W1 isVisible → start + subscribe", () => {
  it("visible=true calls network.startCapture", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(window.electronAPI.network.startCapture).toHaveBeenCalledOnce();
  });

  it("visible=true calls network.onTraffic to subscribe", () => {
    render(<NetworkPanel isVisible={true} />);
    expect(window.electronAPI.network.onTraffic).toHaveBeenCalledOnce();
  });

  it("visible=false does not call network.startCapture", () => {
    render(<NetworkPanel isVisible={false} />);
    expect(window.electronAPI.network.startCapture).not.toHaveBeenCalled();
  });

  it("visible=false does not subscribe via onTraffic", () => {
    render(<NetworkPanel isVisible={false} />);
    expect(window.electronAPI.network.onTraffic).not.toHaveBeenCalled();
  });
});

// ─── W2: invisible/unmount → stop + unsubscribe ───────────────────────────────

describe("W2 invisible/unmount → stop + unsubscribe", () => {
  it("unmount calls network.stopCapture", () => {
    const { unmount } = render(<NetworkPanel isVisible={true} />);
    unmount();
    expect(window.electronAPI.network.stopCapture).toHaveBeenCalledOnce();
  });

  it("unmount calls the unsubscribe function returned by onTraffic", () => {
    const { unmount } = render(<NetworkPanel isVisible={true} />);
    const unsub = window.electronAPI.network.onTraffic.mock.results[0]
      ?.value as unknown as ReturnType<typeof vi.fn>;
    unmount();
    expect(unsub).toHaveBeenCalledOnce();
  });
});

// ─── W3: onTraffic data → rendered values ─────────────────────────────────────

describe("W3 onTraffic data → rendered values", () => {
  it("data from onTraffic appears in [data-metric='rx']", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic());
    });
    const el = document.querySelector("[data-metric='rx']");
    expect(el?.textContent).not.toBe("--");
  });

  it("data from onTraffic appears in [data-metric='tx']", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.(makeTraffic());
    });
    const el = document.querySelector("[data-metric='tx']");
    expect(el?.textContent).not.toBe("--");
  });

  it("subsequent pushes update rx value", () => {
    render(<NetworkPanel isVisible={true} />);
    act(() => {
      capturedOnTraffic?.({ ...makeTraffic(), rxBytesPerSec: 1024 });
    });
    const v1 = document.querySelector("[data-metric='rx']")?.textContent;

    act(() => {
      capturedOnTraffic?.({ ...makeTraffic(), rxBytesPerSec: 1024 * 1024 });
    });
    const v2 = document.querySelector("[data-metric='rx']")?.textContent;
    expect(v2).not.toBe(v1);
  });
});

// ─── W4: Npcap fallback wiring ────────────────────────────────────────────────

describe("W4 npcapAvailable → fallback UI", () => {
  it("npcapAvailable=false renders npcap-fallback", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    expect(document.querySelector("[data-testid='npcap-fallback']")).not.toBeNull();
  });

  it("npcapAvailable=true does not render npcap-fallback", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={true} />);
    expect(document.querySelector("[data-testid='npcap-fallback']")).toBeNull();
  });

  it("npcap-fallback includes install link pointing to npcap.com", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    const link = document.querySelector("[data-testid='npcap-install-link']") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link?.href).toContain("npcap.com");
  });

  it("traffic + connections still work when npcapAvailable=false", () => {
    render(<NetworkPanel isVisible={true} npcapAvailable={false} />);
    // startCapture is called (SI-based traffic monitoring)
    expect(window.electronAPI.network.startCapture).toHaveBeenCalledOnce();
    // traffic section present
    expect(document.querySelector("[data-testid='traffic-section']")).not.toBeNull();
    // connections section present
    expect(document.querySelector("[data-testid='connections-section']")).not.toBeNull();
  });
});
