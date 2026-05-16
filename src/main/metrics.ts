/**
 * MetricsCollector — T8 implementation.
 * Polls systeminformation every 2s and pushes MetricsData to renderer via IPC.
 *
 * Error resilience: SI errors are logged; next interval retries. No crash.
 */

import type { BrowserWindow } from "electron";
import * as si from "systeminformation";
import type { MetricsData } from "../shared/metrics-types";

export class MetricsCollector {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null, intervalMs = 2000) {
    this.getWindow = getWindow;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.intervalId !== null) return; // already running
    // Fire immediately then on interval
    void this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private async poll(): Promise<void> {
    try {
      const [cpuLoad, mem, diskIO] = await Promise.all([si.currentLoad(), si.mem(), si.disksIO()]);

      const data: MetricsData = {
        cpu: {
          usage: cpuLoad.currentLoad ?? 0,
          cores: (cpuLoad.cpus ?? []).map((c) => c.load ?? 0),
        },
        memory: {
          total: mem.total ?? 0,
          used: mem.used ?? 0,
          free: mem.free ?? 0,
        },
        disk: {
          readBytesPerSec: diskIO.rIO_sec ?? 0,
          writeBytesPerSec: diskIO.wIO_sec ?? 0,
        },
        timestamp: Date.now(),
      };

      this.getWindow()?.webContents.send("metrics:update", data);
    } catch (err) {
      console.error("[MetricsCollector] poll error:", err);
      // Next interval will retry automatically
    }
  }
}
