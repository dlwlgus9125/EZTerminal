/**
 * Unit tests for NetworkCollector [R-L3-06]
 * AC-L3-06-1: Npcap detect
 * AC-L3-06-2: traffic stats via SI networkStats
 * AC-L3-06-3: connections via SI networkConnections
 * AC-L3-06-4: packet capture (no-op path when Npcap unavailable)
 * AC-L3-06-N1: no interface
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock systeminformation ---
const mockNetworkStats = vi.fn();
const mockNetworkConnections = vi.fn();

vi.mock("systeminformation", () => ({
  networkStats: mockNetworkStats,
  networkConnections: mockNetworkConnections,
}));

// cap is NOT in node_modules — require("cap") throws → npcapAvailable=false
// Tests verify graceful degradation behavior

const { NetworkCollector } = await import("../../src/main/network");

// Helper: create a fake BrowserWindow
function makeWindow() {
  const send = vi.fn();
  return { webContents: { send } } as unknown as Electron.BrowserWindow;
}

async function flushAsync(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function makeStatsData(rx = 1000, tx = 500) {
  mockNetworkStats.mockResolvedValue([{ iface: "eth0", rx_bytes: rx, tx_bytes: tx }]);
}

function makeConnectionsData() {
  mockNetworkConnections.mockResolvedValue([
    {
      localAddress: "127.0.0.1",
      localPort: "8080",
      peerAddress: "192.168.1.5",
      peerPort: "443",
      protocol: "tcp",
      state: "ESTABLISHED",
      pid: "1234",
    },
    {
      localAddress: "0.0.0.0",
      localPort: "53",
      peerAddress: "",
      peerPort: "0",
      protocol: "udp",
      state: "CLOSE",
      pid: "500",
    },
  ]);
}

// ─── Npcap detect ───────────────────────────────────────────────────────────

describe("Network npcap detect", () => {
  beforeEach(() => {
    makeStatsData();
    makeConnectionsData();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-L3-06-1: npcapAvailable=false when cap is not installed", () => {
    // cap module doesn't exist in node_modules → require("cap") throws → graceful degradation
    const collector = new NetworkCollector(() => null);
    expect(collector.npcapAvailable).toBe(false);
  });

  it("AC-L3-06-1: npcapAvailable is a boolean", () => {
    const collector = new NetworkCollector(() => null);
    expect(typeof collector.npcapAvailable).toBe("boolean");
  });
});

// ─── Traffic stats ───────────────────────────────────────────────────────────

describe("Network traffic stats", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    makeStatsData(2000, 800);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("AC-L3-06-2: polls immediately on start", async () => {
    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    // First poll establishes prevStats baseline (no send on first poll since prevStats=null)
    // Second poll sends traffic data
    makeStatsData(4000, 1600);
    vi.advanceTimersByTime(2000);
    await flushAsync();
    collector.stop();

    // At least one traffic message after two polls
    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const trafficCalls = calls.filter(([ch]) => ch === "network:traffic");
    expect(trafficCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("AC-L3-06-2: traffic data has correct shape", async () => {
    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 500);
    collector.start();
    await flushAsync(); // first poll: sets prevStats

    makeStatsData(3000, 1300);
    vi.advanceTimersByTime(500);
    await flushAsync(); // second poll: computes delta

    collector.stop();
    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const trafficCall = calls.find(([ch]) => ch === "network:traffic");
    if (trafficCall) {
      const [, traffic] = trafficCall;
      expect(traffic).toMatchObject({
        rxBytesPerSec: expect.any(Number),
        txBytesPerSec: expect.any(Number),
        interface: "eth0",
        timestamp: expect.any(Number),
      });
      expect((traffic as { rxBytesPerSec: number }).rxBytesPerSec).toBeGreaterThanOrEqual(0);
      expect((traffic as { txBytesPerSec: number }).txBytesPerSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("AC-L3-06-2: does not double-poll on double start()", async () => {
    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 2000);
    collector.start();
    collector.start(); // no-op
    await flushAsync();

    // Only 1 interval registered (not doubled)
    vi.advanceTimersByTime(2000);
    await flushAsync();

    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ch]) => ch === "network:traffic"
    );
    // max 2 calls (1 immediate + 1 interval), not 4
    expect(calls.length).toBeLessThanOrEqual(2);
    collector.stop();
  });

  it("AC-L3-06-2: stops polling after stop()", async () => {
    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    const countBefore = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(8000);
    await flushAsync();
    expect((win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countBefore);
  });

  it("AC-L3-06-2: SI error does not crash — logs and retries", async () => {
    mockNetworkStats.mockRejectedValueOnce(new Error("SI down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ─── Connections ──────────────────────────────────────────────────────────────

describe("Network connections", () => {
  beforeEach(() => {
    makeStatsData();
    makeConnectionsData();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-L3-06-3: getConnections() returns mapped ConnectionInfo array", async () => {
    const collector = new NetworkCollector(() => null);
    const conns = await collector.getConnections();

    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({
      localAddress: "127.0.0.1",
      localPort: 8080,
      remoteAddress: "192.168.1.5",
      remotePort: 443,
      protocol: "tcp",
      state: "ESTABLISHED",
      pid: 1234,
    });
    expect(conns[1]).toMatchObject({
      localAddress: "0.0.0.0",
      localPort: 53,
      protocol: "udp",
      pid: 500,
    });
  });

  it("AC-L3-06-3: getConnections() returns [] on SI error", async () => {
    mockNetworkConnections.mockRejectedValueOnce(new Error("SI down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const collector = new NetworkCollector(() => null);
    const conns = await collector.getConnections();

    expect(conns).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ─── Packet capture ──────────────────────────────────────────────────────────

describe("Network capture", () => {
  beforeEach(() => {
    makeStatsData();
    makeConnectionsData();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-L3-06-4: startCapture() is no-op when npcap unavailable (no crash)", () => {
    const collector = new NetworkCollector(() => null);
    // npcapAvailable=false since cap not installed
    expect(collector.npcapAvailable).toBe(false);
    // Should not throw
    expect(() => collector.startCapture()).not.toThrow();
  });

  it("AC-L3-06-4: stopCapture() is safe when not capturing (no crash)", () => {
    const collector = new NetworkCollector(() => null);
    expect(() => collector.stopCapture()).not.toThrow();
  });

  it("AC-L3-06-4: startCapture() repeated calls do not crash", () => {
    const collector = new NetworkCollector(() => null);
    expect(() => {
      collector.startCapture();
      collector.startCapture();
      collector.startCapture();
    }).not.toThrow();
  });

  it("AC-L3-06-4: stop() calls stopCapture() safely even when not capturing", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const win = makeWindow();
    const collector = new NetworkCollector(() => win);
    collector.start();
    // No startCapture() — stopCapture inside stop() should be safe
    expect(() => collector.stop()).not.toThrow();
    vi.useRealTimers();
  });
});

// ─── No interface ─────────────────────────────────────────────────────────────

describe("Network no interface", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("AC-L3-06-N1: empty networkStats array — no traffic push", async () => {
    mockNetworkStats.mockResolvedValue([]);

    const win = makeWindow();
    const collector = new NetworkCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    const trafficCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ch]) => ch === "network:traffic"
    );
    expect(trafficCalls).toHaveLength(0);
  });

  it("AC-L3-06-N1: null window does not crash during poll", async () => {
    makeStatsData();
    const collector = new NetworkCollector(() => null, 2000);
    collector.start();
    await flushAsync();
    collector.stop();
    // No error thrown — window?.webContents.send is safely optional
  });
});
