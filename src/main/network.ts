/**
 * NetworkCollector — T9 implementation.
 * Polls systeminformation for traffic/connections every 2s.
 * Optionally uses cap (Npcap) for packet capture when available.
 *
 * Npcap detection: dynamic require() wrapped in try/catch.
 * If cap fails to load → npcapAvailable=false, capture disabled.
 * SI networkStats/networkConnections always available as fallback.
 */

import type { BrowserWindow } from "electron";
import * as si from "systeminformation";
import type { ConnectionInfo, TrafficData } from "../shared/network-types";

// Previous SI stats for computing per-second delta
interface PrevStats {
  rx: number;
  tx: number;
  ts: number;
}

export class NetworkCollector {
  readonly npcapAvailable: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: cap is optional dynamic module
  private capModule: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: cap session is opaque
  private captureSession: any = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly getWindow: () => BrowserWindow | null;
  private prevStats: PrevStats | null = null;

  constructor(getWindow: () => BrowserWindow | null, intervalMs = 2000) {
    this.getWindow = getWindow;
    this.intervalMs = intervalMs;

    // Detect Npcap via cap module
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic optional require
      this.capModule = (require as (id: string) => any)("cap");
      this.npcapAvailable = true;
    } catch {
      this.capModule = null;
      this.npcapAvailable = false;
    }
  }

  start(): void {
    if (this.intervalId !== null) return;
    void this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.stopCapture();
  }

  startCapture(): void {
    if (!this.npcapAvailable || this.captureSession !== null) return;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: cap API is untyped
      const Cap = this.capModule.Cap as new () => any;
      // biome-ignore lint/suspicious/noExplicitAny: cap API is untyped
      const decoders = this.capModule.decoders as any;
      const cap = new Cap();
      const device = Cap.findDevice?.("0.0.0.0") ?? "";
      const filter = "ip";
      const bufSize = 10 * 1024 * 1024;
      const buffer = Buffer.alloc(65535);
      cap.open(device, filter, bufSize, buffer);
      cap.on("packet", (nbytes: number, _trunc: boolean) => {
        try {
          const ethernet = decoders.Ethernet(buffer);
          if (ethernet.info.type !== decoders.PROTOCOL.ETHERNET.IPV4) return;
          const ipv4 = decoders.IPV4(buffer, ethernet.offset);
          const win = this.getWindow();
          win?.webContents.send("network:packet", {
            src: ipv4.info.srcaddr,
            dst: ipv4.info.dstaddr,
            protocol: String(ipv4.info.protocol),
            length: nbytes,
            timestamp: Date.now(),
          });
        } catch {
          // malformed packet — skip
        }
      });
      this.captureSession = cap;
    } catch (err) {
      console.error("[NetworkCollector] startCapture error:", err);
    }
  }

  stopCapture(): void {
    if (this.captureSession === null) return;
    try {
      this.captureSession.close();
    } catch {
      // ignore close errors
    }
    this.captureSession = null;
  }

  async getConnections(): Promise<ConnectionInfo[]> {
    try {
      const conns = await si.networkConnections();
      return conns.map((c) => ({
        localAddress: c.localAddress ?? "",
        localPort: Number(c.localPort) || 0,
        remoteAddress: c.peerAddress ?? "",
        remotePort: Number(c.peerPort) || 0,
        protocol: (c.protocol ?? "tcp") as "tcp" | "udp",
        state: c.state ?? "",
        pid: Number(c.pid) || 0,
      }));
    } catch (err) {
      console.error("[NetworkCollector] getConnections error:", err);
      return [];
    }
  }

  private async poll(): Promise<void> {
    try {
      const stats = await si.networkStats();
      const now = Date.now();

      if (Array.isArray(stats) && stats.length > 0) {
        const s = stats[0];
        let rxPerSec = 0;
        let txPerSec = 0;

        if (this.prevStats !== null) {
          const dt = (now - this.prevStats.ts) / 1000;
          if (dt > 0) {
            rxPerSec = Math.max(0, ((s.rx_bytes ?? 0) - this.prevStats.rx) / dt);
            txPerSec = Math.max(0, ((s.tx_bytes ?? 0) - this.prevStats.tx) / dt);
          }
        }

        this.prevStats = {
          rx: s.rx_bytes ?? 0,
          tx: s.tx_bytes ?? 0,
          ts: now,
        };

        const traffic: TrafficData = {
          rxBytesPerSec: rxPerSec,
          txBytesPerSec: txPerSec,
          interface: s.iface ?? "",
          timestamp: now,
        };

        this.getWindow()?.webContents.send("network:traffic", traffic);
      }
    } catch (err) {
      console.error("[NetworkCollector] poll error:", err);
    }
  }
}
