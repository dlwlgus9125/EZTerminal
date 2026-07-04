/**
 * SystemStatsService — status overlay panel stats collector (status-overlay-
 * panel, rev6/Option A″: .omc/plans/status-overlay-panel.md).
 *
 * `si.powerShellStart()` (a persistent PowerShell session) must NEVER be used
 * here. The T1-0 spike measured `si.processes()` hanging indefinitely under a
 * persistent session (100% reproducible, 3/3 attempts, session itself stayed
 * alive) and the always-on CPU+MEM+NET trio costing ~1.7x its latency budget
 * because the session serializes concurrent calls through one stdin pipe —
 * see .omc/artifacts/stats-spike/results.md. Every PowerShell-routed call
 * below therefore uses systeminformation's default (spawn-per-call) mode,
 * guarded by a per-call timeout so a hang can never wedge this service.
 *
 * Two independent self-scheduling loops (never `setInterval` — the next tick
 * is scheduled only after the previous one settles, so overlapping in-flight
 * calls are structurally impossible):
 *  - Graph loop: always on (app lifetime), 1s cadence, pure JS only —
 *    `si.currentLoad()` (confirmed PowerShell-free by the T1-0 spike) + Node's
 *    `os.totalmem()/os.freemem()`. Feeds the 60-sample CPU/MEM ring buffer.
 *  - Open-time loops: independent per metric, started when the panel becomes
 *    visible and stopped when it's hidden — NET (2s/5s timeout), PROC
 *    (3s/2.5s timeout), DISK (10s/5s timeout). Each keeps its last-known value
 *    on failure/timeout and logs to `LogFile` rather than throwing.
 */
import { powerMonitor } from 'electron';
import { totalmem, freemem } from 'node:os';
import * as si from 'systeminformation';
import type { SystemStatsSnapshot } from '../shared/ipc';
import type { LogFile } from './diagnostics';

const HISTORY_SIZE = 60;
const TOP_PROC_COUNT = 10;

const GRAPH_INTERVAL_MS = 1000;
const NET_INTERVAL_MS = 2000;
const NET_TIMEOUT_MS = 5000;
const PROC_INTERVAL_MS = 3000;
const PROC_TIMEOUT_MS = 2500;
const DISK_INTERVAL_MS = 10000;
const DISK_TIMEOUT_MS = 5000;
const MEM_DETAIL_INTERVAL_MS = 3000;
const MEM_DETAIL_TIMEOUT_MS = 2500;
const CONN_INTERVAL_MS = 3000;
const CONN_TIMEOUT_MS = 2500;
const TOP_CONN_COUNT = 10;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class SystemStatsService {
  private readonly log: LogFile | null;
  private readonly onSnapshot: (snapshot: SystemStatsSnapshot) => void;

  private history: SystemStatsSnapshot[] = [];
  private latestNet: SystemStatsSnapshot['net'] = null;
  private latestDisks: SystemStatsSnapshot['disks'] = null;
  private latestProcs: SystemStatsSnapshot['procs'] = null;
  private latestMemDetail: SystemStatsSnapshot['memDetail'] = null;
  private latestConns: SystemStatsSnapshot['conns'] = null;
  private lastCpuPct = 0;
  private lastCores: number[] = [];
  private netWarmedUp = false;

  private stopped = true;
  private panelVisible = false;
  private discardNextCpuSample = false;

  private graphTimer: ReturnType<typeof setTimeout> | null = null;
  private netTimer: ReturnType<typeof setTimeout> | null = null;
  private procTimer: ReturnType<typeof setTimeout> | null = null;
  private diskTimer: ReturnType<typeof setTimeout> | null = null;
  private memDetailTimer: ReturnType<typeof setTimeout> | null = null;
  private connTimer: ReturnType<typeof setTimeout> | null = null;

  // powerMonitor 'resume' can fire a CPU delta that spans the sleep gap — the
  // next graph tick discards that one sample rather than showing a bogus spike.
  private readonly onResume = (): void => {
    this.discardNextCpuSample = true;
  };

  constructor(log: LogFile | null, onSnapshot: (snapshot: SystemStatsSnapshot) => void) {
    this.log = log;
    this.onSnapshot = onSnapshot;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    powerMonitor.on('resume', this.onResume);
    this.scheduleGraphTick(0);
  }

  /** Clears every pending timer (graph + any open-time loop) and unsubscribes powerMonitor. */
  stop(): void {
    this.stopped = true;
    powerMonitor.removeListener('resume', this.onResume);
    if (this.graphTimer) clearTimeout(this.graphTimer);
    this.graphTimer = null;
    this.stopOpenTimeLoops();
  }

  /** Idempotent — a same-value call is a no-op (didn't just re-warm NET for nothing). */
  setPanelVisible(visible: boolean): void {
    if (this.panelVisible === visible) return;
    this.panelVisible = visible;
    if (visible) {
      this.netWarmedUp = false;
      this.latestNet = null;
      this.latestDisks = null;
      this.latestProcs = null;
      this.latestMemDetail = null;
      this.latestConns = null;
      this.scheduleNetTick(0);
      this.scheduleProcTick(0);
      this.scheduleDiskTick(0);
      this.scheduleMemDetailTick(0);
      this.scheduleConnTick(0);
    } else {
      this.stopOpenTimeLoops();
    }
  }

  isPanelVisible(): boolean {
    return this.panelVisible;
  }

  /** Up to the last 60 graph snapshots, oldest first. */
  getHistory(): SystemStatsSnapshot[] {
    return this.history.slice();
  }

  private stopOpenTimeLoops(): void {
    if (this.netTimer) clearTimeout(this.netTimer);
    if (this.procTimer) clearTimeout(this.procTimer);
    if (this.diskTimer) clearTimeout(this.diskTimer);
    if (this.memDetailTimer) clearTimeout(this.memDetailTimer);
    if (this.connTimer) clearTimeout(this.connTimer);
    this.netTimer = null;
    this.procTimer = null;
    this.diskTimer = null;
    this.memDetailTimer = null;
    this.connTimer = null;
  }

  // ── Graph loop (always on, pure JS) ────────────────────────────────────────

  private scheduleGraphTick(delayMs: number): void {
    if (this.stopped) return;
    this.graphTimer = setTimeout(() => {
      void this.graphTick().finally(() => this.scheduleGraphTick(GRAPH_INTERVAL_MS));
    }, delayMs);
  }

  private async graphTick(): Promise<void> {
    const discard = this.discardNextCpuSample;
    this.discardNextCpuSample = false;
    try {
      const load = await si.currentLoad();
      if (!discard) {
        this.lastCpuPct = load.currentLoad;
        this.lastCores = (load.cpus ?? []).map((c) => c.load);
      }
    } catch (err) {
      this.log?.line(`SystemStatsService: currentLoad() failed, keeping last value: ${String(err)}`);
    }

    const totalBytes = totalmem();
    const usedBytes = totalBytes - freemem();

    const snapshot: SystemStatsSnapshot = {
      at: Date.now(),
      cpu: { loadPct: this.lastCpuPct, cores: this.lastCores },
      mem: { usedBytes, totalBytes },
      memDetail: this.latestMemDetail,
      net: this.latestNet,
      disks: this.latestDisks,
      procs: this.latestProcs,
      conns: this.latestConns,
    };
    this.pushHistory(snapshot);
    this.onSnapshot(snapshot);
  }

  private pushHistory(snapshot: SystemStatsSnapshot): void {
    const last = this.history[this.history.length - 1];
    if (last && snapshot.at <= last.at) return; // monotonic `at` guard
    this.history.push(snapshot);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
  }

  // ── Open-time loops (panel-visible only, spawn-per-call PowerShell) ───────

  private scheduleNetTick(delayMs: number): void {
    if (this.stopped || !this.panelVisible) return;
    this.netTimer = setTimeout(() => {
      void this.netTick().finally(() => this.scheduleNetTick(NET_INTERVAL_MS));
    }, delayMs);
  }

  private async netTick(): Promise<void> {
    try {
      const stats = await withTimeout(si.networkStats(), NET_TIMEOUT_MS);
      const primary = stats.find((s) => s.operstate === 'up') ?? stats[0];
      if (primary && Number.isFinite(primary.rx_sec) && Number.isFinite(primary.tx_sec)) {
        if (!this.netWarmedUp) {
          // First real sample after opening (or after the process's first-ever
          // call) has no prior baseline — discard it and show "measuring..."
          // for one more cycle rather than a misleading long-window average.
          this.netWarmedUp = true;
        } else {
          this.latestNet = { iface: primary.iface, rxSec: primary.rx_sec, txSec: primary.tx_sec };
        }
      }
    } catch (err) {
      this.log?.line(`SystemStatsService: networkStats() failed, keeping last value: ${String(err)}`);
    }
  }

  private scheduleProcTick(delayMs: number): void {
    if (this.stopped || !this.panelVisible) return;
    this.procTimer = setTimeout(() => {
      void this.procTick().finally(() => this.scheduleProcTick(PROC_INTERVAL_MS));
    }, delayMs);
  }

  private async procTick(): Promise<void> {
    try {
      const result = await withTimeout(si.processes(), PROC_TIMEOUT_MS);
      this.latestProcs = result.list
        .slice()
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, TOP_PROC_COUNT)
        .map((p) => ({ pid: p.pid, name: p.name, cpuPct: p.cpu, memBytes: p.memRss * 1024 }));
    } catch (err) {
      this.log?.line(`SystemStatsService: processes() failed, keeping last value: ${String(err)}`);
    }
  }

  private scheduleDiskTick(delayMs: number): void {
    if (this.stopped || !this.panelVisible) return;
    this.diskTimer = setTimeout(() => {
      void this.diskTick().finally(() => this.scheduleDiskTick(DISK_INTERVAL_MS));
    }, delayMs);
  }

  private async diskTick(): Promise<void> {
    try {
      const result = await withTimeout(si.fsSize(), DISK_TIMEOUT_MS);
      this.latestDisks = result.map((d) => ({ mount: d.mount, usedBytes: d.used, sizeBytes: d.size }));
    } catch (err) {
      this.log?.line(`SystemStatsService: fsSize() failed, keeping last value: ${String(err)}`);
    }
  }

  private scheduleMemDetailTick(delayMs: number): void {
    if (this.stopped || !this.panelVisible) return;
    this.memDetailTimer = setTimeout(() => {
      void this.memDetailTick().finally(() => this.scheduleMemDetailTick(MEM_DETAIL_INTERVAL_MS));
    }, delayMs);
  }

  private async memDetailTick(): Promise<void> {
    try {
      const result = await withTimeout(si.mem(), MEM_DETAIL_TIMEOUT_MS);
      this.latestMemDetail = {
        availableBytes: result.available,
        cachedBytes: result.cached,
        swapUsedBytes: result.swapused,
        swapTotalBytes: result.swaptotal,
      };
    } catch (err) {
      this.log?.line(`SystemStatsService: mem() failed, keeping last value: ${String(err)}`);
    }
  }

  private scheduleConnTick(delayMs: number): void {
    if (this.stopped || !this.panelVisible) return;
    this.connTimer = setTimeout(() => {
      void this.connTick().finally(() => this.scheduleConnTick(CONN_INTERVAL_MS));
    }, delayMs);
  }

  private async connTick(): Promise<void> {
    try {
      const result = await withTimeout(si.networkConnections(), CONN_TIMEOUT_MS);
      this.latestConns = result.slice(0, TOP_CONN_COUNT).map((c) => ({
        proto: c.protocol,
        local: `${c.localAddress}:${c.localPort}`,
        peer: `${c.peerAddress}:${c.peerPort}`,
        state: c.state,
        process: c.process,
      }));
    } catch (err) {
      this.log?.line(`SystemStatsService: networkConnections() failed, keeping last value: ${String(err)}`);
    }
  }
}
