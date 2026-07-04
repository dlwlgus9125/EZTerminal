/**
 * SystemStatsService unit tests (status-overlay-panel rev6/T4). `systeminformation`
 * and Electron's `powerMonitor` are mocked — the T1-0 spike already proved the
 * spawn-per-call PowerShell costs empirically (.omc/artifacts/stats-spike/results.md);
 * these tests lock in the service's OWN scheduling/gating/timeout/history contracts
 * against a controllable double, using vitest's fake timers (never real delays).
 *
 * Ordering note: GRAPH_INTERVAL_MS (1000) evenly divides NET/PROC/DISK's intervals
 * (2000/3000/10000), so an open-time tick can land on the exact same virtual
 * millisecond as a graph tick. Tests that need to OBSERVE an open-time tick's
 * effect (via a later graph-tick snapshot) always let the graph loop settle by
 * itself first, then advance one more full GRAPH_INTERVAL_MS past any such
 * coincidence before asserting — so same-tick callback ordering never matters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentLoad: vi.fn(),
  networkStats: vi.fn(),
  processes: vi.fn(),
  fsSize: vi.fn(),
  mem: vi.fn(),
  networkConnections: vi.fn(),
  powerMonitorOn: vi.fn(),
  powerMonitorRemoveListener: vi.fn(),
}));

vi.mock('systeminformation', () => ({
  currentLoad: mocks.currentLoad,
  networkStats: mocks.networkStats,
  processes: mocks.processes,
  fsSize: mocks.fsSize,
  mem: mocks.mem,
  networkConnections: mocks.networkConnections,
}));

vi.mock('electron', () => ({
  powerMonitor: {
    on: mocks.powerMonitorOn,
    removeListener: mocks.powerMonitorRemoveListener,
  },
}));

import { SystemStatsService } from './system-stats-service';
import type { SystemStatsSnapshot } from '../shared/ipc';

// Mirrors the service's private intervals/timeouts (system-stats-service.ts) —
// not exported, so duplicated here; keep in sync if those ever change.
const GRAPH_INTERVAL_MS = 1000;
const NET_TIMEOUT_MS = 5000;
const MEM_DETAIL_INTERVAL_MS = 3000;
const MEM_DETAIL_TIMEOUT_MS = 2500;

function resumeHandler(): () => void {
  const call = mocks.powerMonitorOn.mock.calls.find(([event]) => event === 'resume');
  if (!call) throw new Error('resume handler was never registered via powerMonitor.on');
  return call[1] as () => void;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemStatsService — graph loop (always-on, pure JS)', () => {
  it('ticks CPU/MEM every second and pushes a snapshot with net/disks/procs still null (closed)', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 12.5 });
    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].cpu.loadPct).toBe(12.5);
    expect(pushed[0].mem.totalBytes).toBeGreaterThan(0);
    expect(pushed[0].net).toBeNull();
    expect(pushed[0].disks).toBeNull();
    expect(pushed[0].procs).toBeNull();

    service.stop();
  });

  it('self-schedules (not setInterval): the next tick never starts before the in-flight one settles', async () => {
    let resolveLoad: ((v: { currentLoad: number }) => void) | undefined;
    mocks.currentLoad.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const service = new SystemStatsService(null, vi.fn());
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.currentLoad).toHaveBeenCalledTimes(1);

    // Advance well past several intervals while the first call is still pending.
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS * 5);
    expect(mocks.currentLoad).toHaveBeenCalledTimes(1);

    resolveLoad?.({ currentLoad: 1 });
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS);
    expect(mocks.currentLoad).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it('discards the next CPU sample after a powerMonitor "resume" (sleep-gap delta guard)', async () => {
    mocks.currentLoad
      .mockResolvedValueOnce({ currentLoad: 5 })
      .mockResolvedValueOnce({ currentLoad: 99 })
      .mockResolvedValueOnce({ currentLoad: 7 });
    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushed[0].cpu.loadPct).toBe(5);

    resumeHandler()();

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS);
    expect(pushed[1].cpu.loadPct).toBe(5); // the 99 sample was discarded, not shown

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS);
    expect(pushed[2].cpu.loadPct).toBe(7); // back to normal on the next sample

    service.stop();
  });
});

describe('SystemStatsService — history ring buffer', () => {
  it('trims to the last 60 samples', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1 });
    const service = new SystemStatsService(null, vi.fn());
    service.start();

    await vi.advanceTimersByTimeAsync(0); // sample #1
    for (let i = 0; i < 64; i++) {
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // samples #2..#65
    }
    expect(service.getHistory()).toHaveLength(60);

    service.stop();
  });

  it('drops a sample whose `at` does not strictly increase over the last one', async () => {
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1 });
    const service = new SystemStatsService(null, vi.fn());
    service.start();

    await vi.advanceTimersByTimeAsync(0); // at=1000, history empty -> appended
    expect(service.getHistory()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // at=1000 again -> duplicate, dropped
    expect(service.getHistory()).toHaveLength(1);

    dateSpy.mockReturnValue(2_000);
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // at=2000 -> strictly greater, appended
    expect(service.getHistory()).toHaveLength(2);

    dateSpy.mockRestore();
    service.stop();
  });
});

describe('SystemStatsService — panel-open-only collectors (NET/PROC/DISK/MEM detail/CONN)', () => {
  it('never calls NET/PROC/DISK/mem/networkConnections while the panel is closed, but keeps ticking the always-on CPU/MEM pair', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    const service = new SystemStatsService(null, vi.fn());
    service.start(); // panelVisible starts false (AC11/AC9)

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS * 3);
    expect(mocks.currentLoad).toHaveBeenCalled();
    expect(mocks.networkStats).not.toHaveBeenCalled();
    expect(mocks.processes).not.toHaveBeenCalled();
    expect(mocks.fsSize).not.toHaveBeenCalled();
    expect(mocks.mem).not.toHaveBeenCalled();
    expect(mocks.networkConnections).not.toHaveBeenCalled();

    service.stop();
  });

  it('starts all five collectors immediately on setPanelVisible(true) and stops them on setPanelVisible(false)', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([
      { iface: 'eth0', operstate: 'up', rx_sec: 1, tx_sec: 1 },
    ]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    const service = new SystemStatsService(null, vi.fn());
    service.start();

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.networkStats).toHaveBeenCalledTimes(1);
    expect(mocks.processes).toHaveBeenCalledTimes(1);
    expect(mocks.fsSize).toHaveBeenCalledTimes(1);
    expect(mocks.mem).toHaveBeenCalledTimes(1);
    expect(mocks.networkConnections).toHaveBeenCalledTimes(1);

    // This is exactly what main.ts's `did-navigate` reset calls on a reload.
    service.setPanelVisible(false);
    const netCallsAtClose = mocks.networkStats.mock.calls.length;
    const procCallsAtClose = mocks.processes.mock.calls.length;
    const diskCallsAtClose = mocks.fsSize.mock.calls.length;
    const memCallsAtClose = mocks.mem.mock.calls.length;
    const connCallsAtClose = mocks.networkConnections.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.networkStats.mock.calls.length).toBe(netCallsAtClose);
    expect(mocks.processes.mock.calls.length).toBe(procCallsAtClose);
    expect(mocks.fsSize.mock.calls.length).toBe(diskCallsAtClose);
    expect(mocks.mem.mock.calls.length).toBe(memCallsAtClose);
    expect(mocks.networkConnections.mock.calls.length).toBe(connCallsAtClose);

    service.stop();
  });
});

describe('SystemStatsService — NET rate warmup', () => {
  it('discards the first sample after opening (no rate baseline yet) and reports from the second sample on', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    mocks.networkStats
      .mockResolvedValueOnce([{ iface: 'eth0', operstate: 'up', rx_sec: 111, tx_sec: 222 }]) // warmup, discarded
      .mockResolvedValueOnce([{ iface: 'eth0', operstate: 'up', rx_sec: 333, tx_sec: 444 }]); // first real rate

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next tick is now due at t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // net tick #1 (warmup) fires alone — no graph due at this instant

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes: still null after warmup
    expect(pushed[pushed.length - 1].net).toBeNull();

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // net tick #2 fires here too (coincides with a graph tick)
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // one clean graph tick later: net tick #2 has fully settled
    expect(pushed[pushed.length - 1].net).toEqual({ iface: 'eth0', rxSec: 333, txSec: 444 });

    service.stop();
  });
});

describe('SystemStatsService — per-call timeout', () => {
  it('a call that never resolves times out, keeps the last good value, and the loop survives to try again', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    mocks.networkStats
      .mockResolvedValueOnce([{ iface: 'eth0', operstate: 'up', rx_sec: 10, tx_sec: 10 }]) // warmup
      .mockResolvedValueOnce([{ iface: 'eth0', operstate: 'up', rx_sec: 20, tx_sec: 30 }]) // good value
      .mockImplementation(() => new Promise(() => {})); // every call after: hangs forever

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // net #1 (warmup)

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick alone
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // net #2 (good value) coincides with a graph tick here
    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // one clean tick later: good value visible
    expect(pushed[pushed.length - 1].net).toEqual({ iface: 'eth0', rxSec: 20, txSec: 30 });

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // net #3 starts here (hangs) — coincides with a graph tick
    expect(mocks.networkStats).toHaveBeenCalledTimes(3);

    // net #3's withTimeout rejects NET_TIMEOUT_MS after it started; the loop's
    // catch keeps the last good value (never resets it to null on failure).
    await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
    expect(pushed[pushed.length - 1].net).toEqual({ iface: 'eth0', rxSec: 20, txSec: 30 });

    // The loop survived the timeout and scheduled another attempt.
    await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
    expect(mocks.networkStats.mock.calls.length).toBeGreaterThanOrEqual(4);

    service.stop();
  });
});

describe('SystemStatsService — process list', () => {
  it('sorts by CPU descending and keeps only the top 10', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    const list = Array.from({ length: 15 }, (_, i) => ({
      pid: i,
      name: `proc-${i}`,
      cpu: i, // ascending on purpose — the service must sort descending itself
      memRss: 1024 + i,
    }));
    mocks.processes.mockResolvedValue({ list });

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next due is t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // proc tick #1 fires alone, resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the settled procs list

    const procs = pushed[pushed.length - 1].procs;
    expect(procs).toHaveLength(10);
    expect(procs?.map((p) => p.pid)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    expect(procs?.[0].memBytes).toBe((1024 + 14) * 1024); // memRss (KB) -> bytes

    service.stop();
  });
});

describe('SystemStatsService — disk usage', () => {
  it('maps fsSize() entries to {mount, usedBytes, sizeBytes}', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    mocks.fsSize.mockResolvedValue([
      { mount: 'C:', used: 500, size: 1000 },
      { mount: 'D:', used: 200, size: 2000 },
    ]);

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next due is t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // disk tick #1 fires alone, resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the settled disks list

    const disks = pushed[pushed.length - 1].disks;
    expect(disks).toEqual([
      { mount: 'C:', usedBytes: 500, sizeBytes: 1000 },
      { mount: 'D:', usedBytes: 200, sizeBytes: 2000 },
    ]);

    service.stop();
  });
});

describe('SystemStatsService — stop()', () => {
  it('clears every pending timer and unsubscribes powerMonitor — nothing fires again', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([]);
    const service = new SystemStatsService(null, vi.fn());
    service.start();
    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0);

    const loadCalls = mocks.currentLoad.mock.calls.length;
    const netCalls = mocks.networkStats.mock.calls.length;

    service.stop();
    expect(mocks.powerMonitorRemoveListener).toHaveBeenCalledWith('resume', expect.any(Function));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.currentLoad.mock.calls.length).toBe(loadCalls);
    expect(mocks.networkStats.mock.calls.length).toBe(netCalls);
  });
});

describe('SystemStatsService — CPU cores', () => {
  it('populates cpu.cores from currentLoad().cpus alongside the aggregate load', async () => {
    mocks.currentLoad.mockResolvedValue({
      currentLoad: 12.5,
      cpus: [{ load: 5 }, { load: 20 }],
    });
    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushed[0].cpu.cores).toEqual([5, 20]);

    service.stop();
  });

  it('defaults cpu.cores to [] when currentLoad() has no cpus field (e.g. very first tick)', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 5 });
    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushed[0].cpu.cores).toEqual([]);

    service.stop();
  });

  it('keeps the last cores array on a discarded (post-resume) sample, same as loadPct', async () => {
    mocks.currentLoad
      .mockResolvedValueOnce({ currentLoad: 5, cpus: [{ load: 5 }] })
      .mockResolvedValueOnce({ currentLoad: 99, cpus: [{ load: 99 }] })
      .mockResolvedValueOnce({ currentLoad: 7, cpus: [{ load: 7 }] });
    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushed[0].cpu.cores).toEqual([5]);

    resumeHandler()();

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS);
    expect(pushed[1].cpu.cores).toEqual([5]); // the 99-load sample was discarded, not shown

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS);
    expect(pushed[2].cpu.cores).toEqual([7]); // back to normal on the next sample

    service.stop();
  });
});

describe('SystemStatsService — memDetail (panel-open-only, si.mem())', () => {
  it('maps si.mem() into memDetail once the panel opens, and stops updating once it closes', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.networkConnections.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({
      available: 4_000_000_000,
      cached: 1_000_000_000,
      swapused: 500_000_000,
      swaptotal: 2_000_000_000,
    });

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next due is t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // memDetail tick #1 fires alone, resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the settled memDetail

    expect(pushed[pushed.length - 1].memDetail).toEqual({
      availableBytes: 4_000_000_000,
      cachedBytes: 1_000_000_000,
      swapUsedBytes: 500_000_000,
      swapTotalBytes: 2_000_000_000,
    });

    const memCallsAtOpen = mocks.mem.mock.calls.length;
    service.setPanelVisible(false);
    await vi.advanceTimersByTimeAsync(MEM_DETAIL_INTERVAL_MS * 3);
    expect(mocks.mem.mock.calls.length).toBe(memCallsAtOpen);

    service.stop();
  });

  it('a memDetail call that never resolves times out, keeps the last good value, and the loop survives to try again', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.networkConnections.mockResolvedValue([]);
    mocks.mem
      .mockResolvedValueOnce({ available: 1, cached: 2, swapused: 3, swaptotal: 4 }) // good value
      .mockImplementation(() => new Promise(() => {})); // every call after: hangs forever

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // memDetail #1 (good value) fires and resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the good value
    expect(pushed[pushed.length - 1].memDetail).toEqual({
      availableBytes: 1,
      cachedBytes: 2,
      swapUsedBytes: 3,
      swapTotalBytes: 4,
    });

    // memDetail #2 starts here (hangs) — coincides with a graph tick at t=MEM_DETAIL_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(MEM_DETAIL_INTERVAL_MS - GRAPH_INTERVAL_MS);
    expect(mocks.mem).toHaveBeenCalledTimes(2);

    // memDetail #2's withTimeout rejects MEM_DETAIL_TIMEOUT_MS after it started; the
    // loop's catch keeps the last good value (never resets it to null on failure).
    await vi.advanceTimersByTimeAsync(MEM_DETAIL_TIMEOUT_MS);
    expect(pushed[pushed.length - 1].memDetail).toEqual({
      availableBytes: 1,
      cachedBytes: 2,
      swapUsedBytes: 3,
      swapTotalBytes: 4,
    });

    // The loop survived the timeout and scheduled another attempt.
    await vi.advanceTimersByTimeAsync(MEM_DETAIL_INTERVAL_MS);
    expect(mocks.mem.mock.calls.length).toBeGreaterThanOrEqual(3);

    service.stop();
  });
});

describe('SystemStatsService — connections (Phase 2A, si.networkConnections())', () => {
  it('maps si.networkConnections() into conns once the panel opens, and stops updating once it closes', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    mocks.networkConnections.mockResolvedValue([
      {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: '5000',
        peerAddress: '10.0.0.1',
        peerPort: '443',
        state: 'ESTABLISHED',
        pid: 123,
        process: 'node',
      },
    ]);

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next due is t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // conn tick #1 fires alone, resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the settled conns list

    expect(pushed[pushed.length - 1].conns).toEqual([
      { proto: 'tcp', local: '127.0.0.1:5000', peer: '10.0.0.1:443', state: 'ESTABLISHED', process: 'node' },
    ]);

    const connCallsAtOpen = mocks.networkConnections.mock.calls.length;
    service.setPanelVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.networkConnections.mock.calls.length).toBe(connCallsAtOpen);

    service.stop();
  });

  it('keeps only the top 10 connections', async () => {
    mocks.currentLoad.mockResolvedValue({ currentLoad: 1, cpus: [] });
    mocks.networkStats.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ list: [] });
    mocks.fsSize.mockResolvedValue([]);
    mocks.mem.mockResolvedValue({ available: 1, cached: 1, swapused: 0, swaptotal: 0 });
    const list = Array.from({ length: 15 }, (_, i) => ({
      protocol: 'tcp',
      localAddress: '127.0.0.1',
      localPort: String(1000 + i),
      peerAddress: '10.0.0.1',
      peerPort: '443',
      state: 'ESTABLISHED',
      pid: i,
      process: `proc-${i}`,
    }));
    mocks.networkConnections.mockResolvedValue(list);

    const pushed: SystemStatsSnapshot[] = [];
    const service = new SystemStatsService(null, (s) => pushed.push(s));
    service.start();
    await vi.advanceTimersByTimeAsync(0); // graph #1 alone; graph's next due is t=1000

    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0); // conn tick #1 fires alone, resolves immediately

    await vi.advanceTimersByTimeAsync(GRAPH_INTERVAL_MS); // graph tick observes the settled conns list

    expect(pushed[pushed.length - 1].conns).toHaveLength(10);

    service.stop();
  });
});
