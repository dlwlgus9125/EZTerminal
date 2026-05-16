/**
 * PtyManager — T1 skeleton scope.
 * create/kill PTY sessions; store in Map by UUID.
 * Orphan scan NOT implemented (deferred to T2).
 */

import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import * as nodePty from "node-pty";
import type { IpcResult } from "../shared/ipc-types";
import type { PtyCreateOptions } from "../shared/terminal-types";

export class PtyManager {
  private readonly sessions = new Map<string, IPty>();

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
      this.sessions.set(id, pty);
      console.log(`[PtyManager] created session ${id} pid=${pty.pid}`);
      return { ok: true, data: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[PtyManager] create failed: ${message}`);
      return { ok: false, code: "PTY_CREATE_FAILED", message };
    }
  }

  kill(id: string): void {
    const pty = this.sessions.get(id);
    if (!pty) return;
    try {
      pty.kill();
    } catch {
      // already dead
    }
    this.sessions.delete(id);
    console.log(`[PtyManager] killed session ${id}`);
  }

  killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }

  getSession(id: string): IPty | undefined {
    return this.sessions.get(id);
  }
}
