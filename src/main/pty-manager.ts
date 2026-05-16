/**
 * PtyManager — T1+T2 scope.
 * create/kill PTY sessions; store in Map by UUID.
 * Orphan scan: 30s interval removes exited sessions.
 * Error paths: killSession returns IpcResult (SESSION_NOT_FOUND).
 */

import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import * as nodePty from "node-pty";
import type { IpcResult } from "../shared/ipc-types";
import type { PtyCreateOptions } from "../shared/terminal-types";

const ORPHAN_SCAN_INTERVAL_MS = 30_000;

interface SessionEntry {
  pty: IPty;
  exited: boolean;
}

export class PtyManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private orphanTimer: ReturnType<typeof setInterval> | null = null;

  async create(opts: PtyCreateOptions): Promise<IpcResult<string>> {
    const shell =
      opts.shell ??
      (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"));
    try {
      const pty = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: process.env.HOME ?? process.cwd(),
        env: process.env as Record<string, string>,
      });
      const id = randomUUID();
      const entry: SessionEntry = { pty, exited: false };
      this.sessions.set(id, entry);

      // Track exit so orphan scan can remove it
      pty.onExit(() => {
        const e = this.sessions.get(id);
        if (e) e.exited = true;
      });

      console.log(`[PtyManager] created session ${id} pid=${pty.pid}`);
      return { ok: true, data: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[PtyManager] create failed: ${message}`);
      return { ok: false, code: "PTY_CREATE_FAILED", message };
    }
  }

  /** Kill a session and remove from Map. Returns void — no error on missing ID. */
  kill(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    try {
      entry.pty.kill();
    } catch {
      // already dead
    }
    this.sessions.delete(id);
    console.log(`[PtyManager] killed session ${id}`);
  }

  /** Kill with explicit IpcResult — SESSION_NOT_FOUND if missing. */
  killSession(id: string): IpcResult<void> {
    const entry = this.sessions.get(id);
    if (!entry) {
      return { ok: false, code: "SESSION_NOT_FOUND", message: `Session ${id} not found` };
    }
    this.kill(id);
    return { ok: true, data: undefined };
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }

  getSession(id: string): IPty | undefined {
    return this.sessions.get(id)?.pty;
  }

  /** Start 30s orphan scan. Call once at app startup. */
  startOrphanScan(): void {
    if (this.orphanTimer !== null) return;
    this.orphanTimer = setInterval(() => {
      this.scanOrphans();
    }, ORPHAN_SCAN_INTERVAL_MS);
  }

  /** Stop orphan scan. Call before tests or app quit. */
  stopOrphanScan(): void {
    if (this.orphanTimer !== null) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  private scanOrphans(): void {
    for (const [id, entry] of this.sessions) {
      if (entry.exited) {
        console.log(`[PtyManager] removing orphan session ${id}`);
        this.sessions.delete(id);
      }
    }
  }
}
