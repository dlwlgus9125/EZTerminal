/**
 * Unit tests for MetricsCollector [R-L3-05]
 * AC-L3-05-1: 2s polling interval
 * AC-L3-05-2: metrics:update push to renderer
 * AC-L3-05-N1: SI error resilience — log and retry, no crash
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock systeminformation ---
const mockCurrentLoad = vi.fn();
const mockMem = vi.fn();
const mockDisksIO = vi.fn();

vi.mock("systeminformation", () => ({
  currentLoad: mockCurrentLoad,
  mem: mockMem,
  disksIO: mockDisksIO,
}));

const { MetricsCollector } = await import("../../src/main/metrics");

// --- Helpers ---
function makeSiData() {
  mockCurrentLoad.mockResolvedValue({
    currentLoad: 42.5,
    cpus: [{ load: 30 }, { load: 55 }],
  });
  mockMem.mockResolvedValue({
    total: 16 * 1024 * 1024 * 1024,
    used: 8 * 1024 * 1024 * 1024,
    free: 8 * 1024 * 1024 * 1024,
  });
  mockDisksIO.mockResolvedValue({
    rIO_sec: 1024,
    wIO_sec: 512,
  });
}

function makeWindow() {
  const send = vi.fn();
  return { webContents: { send } } as unknown as Electron.BrowserWindow;
}

/** Flush microtask queue (multiple hops for async chains) */
async function flushAsync(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe("Metrics collector", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    makeSiData();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("AC-L3-05-1: polls immediately on start", async () => {
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    expect(win.webContents.send).toHaveBeenCalled();
    collector.stop();
  });

  it("AC-L3-05-1: polls again after 2s interval", async () => {
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    const firstCount = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(2000);
    await flushAsync();
    const secondCount = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondCount).toBeGreaterThan(firstCount);
    collector.stop();
  });

  it("AC-L3-05-1: does not poll after stop()", async () => {
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    const countBeforeStop = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    collector.stop();

    vi.advanceTimersByTime(6000);
    await flushAsync();
    expect((win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      countBeforeStop
    );
  });

  it("AC-L3-05-1: double start() does not double-poll", async () => {
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    collector.start(); // no-op
    await flushAsync();
    // Exactly 1 immediate poll (not 2)
    expect(win.webContents.send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2000);
    await flushAsync();
    // Exactly 1 interval poll (not doubled)
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    collector.stop();
  });
});

describe("Metrics push", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    makeSiData();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("AC-L3-05-2: pushes metrics:update channel with MetricsData shape", async () => {
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    expect(win.webContents.send).toHaveBeenCalled();
    const [channel, data] = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown,
    ];
    expect(channel).toBe("metrics:update");
    expect(data).toMatchObject({
      cpu: { usage: 42.5, cores: [30, 55] },
      memory: {
        total: 16 * 1024 * 1024 * 1024,
        used: 8 * 1024 * 1024 * 1024,
      },
      disk: { readBytesPerSec: 1024, writeBytesPerSec: 512 },
      timestamp: expect.any(Number),
    });
  });

  it("AC-L3-05-2: does not push when window is null", async () => {
    const collector = new MetricsCollector(() => null, 2000);
    collector.start();
    await flushAsync();
    collector.stop();
    // No error thrown — window?.webContents.send is safely optional
  });
});

describe("Metrics error resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("AC-L3-05-N1: SI error on first poll does not crash — logs error", async () => {
    mockCurrentLoad.mockRejectedValueOnce(new Error("SI unavailable"));
    mockMem.mockResolvedValue({ total: 0, used: 0, free: 0 });
    mockDisksIO.mockResolvedValue({ rIO_sec: 0, wIO_sec: 0 });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync();
    collector.stop();

    expect(consoleError).toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("AC-L3-05-N1: SI error on one interval, success on next — retries", async () => {
    // Immediate poll: error; subsequent polls: success
    mockCurrentLoad
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ currentLoad: 10, cpus: [] });
    mockMem.mockResolvedValue({ total: 0, used: 0, free: 0 });
    mockDisksIO.mockResolvedValue({ rIO_sec: 0, wIO_sec: 0 });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const win = makeWindow();
    const collector = new MetricsCollector(() => win, 2000);
    collector.start();
    await flushAsync(); // immediate → error, no push
    expect(win.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await flushAsync(); // retry → success
    collector.stop();

    expect(win.webContents.send).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
