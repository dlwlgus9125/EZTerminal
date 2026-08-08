/**
 * ScriptHostRegistry — main's broker for `run-script` (E4 §6.1).
 *
 * The interpreter cannot fork a utilityProcess itself (C1/C2: fuses disable
 * `ELECTRON_RUN_AS_NODE`, and `utilityProcess.fork` is a main-only API), so it
 * asks main to spawn a script-host per `run-script` invocation, correlated by
 * a `hostId` it mints. This registry owns the `Map<hostId, UtilityProcess>`,
 * forks the host, hands it its half of a fresh `MessageChannelMain` (the OTHER
 * half goes straight to the interpreter — main never relays `ez-run`/
 * `script-print`/etc. traffic, same as the renderer's cmd-port), and reports
 * the host's exit back through `onExit` so main.ts can relay `script-host-exit`
 * and (on the interpreter's own death) kill every live host — shared-fate,
 * mirroring the existing `pendingCreates`/interpreter-exit handling.
 */

import { MessageChannelMain, utilityProcess } from 'electron';
import type { MessagePortMain, UtilityProcess } from 'electron';

export type SpawnResult = { readonly interpreterPort: MessagePortMain } | { readonly error: string };

export interface ScriptHostGuardian {
  createGroup(groupId: string, pid: number, parentGroupId?: string): Promise<void>;
  terminateGroup(groupId: string): Promise<void>;
}

interface HostEntry {
  readonly process: UtilityProcess;
  groupId: string | null;
  readonly exited: Promise<void>;
}

function waitForSpawn(host: UtilityProcess): Promise<number> {
  if (host.pid !== undefined) return Promise.resolve(host.pid);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      host.off('spawn', onSpawn);
      host.off('exit', onExit);
    };
    const onSpawn = (): void => {
      cleanup();
      if (host.pid === undefined) reject(new Error('script host spawned without a process id'));
      else resolve(host.pid);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error('script host exited before process ownership was established'));
    };
    host.once('spawn', onSpawn);
    host.once('exit', onExit);
  });
}

export class ScriptHostRegistry {
  private readonly hosts = new Map<string, HostEntry>();

  constructor(
    private readonly scriptHostPath: string,
    private readonly guardian?: ScriptHostGuardian,
    private readonly parentGroupId?: () => string | null,
  ) {}

  /**
   * Fork a script-host, wire its half of a fresh port pair, and hand back the
   * OTHER half for the interpreter. `onExit` fires exactly once, however the
   * host ends (normal exit, kill, or crash).
   */
  spawn(
    hostId: string,
    scriptPath: string,
    args: readonly string[],
    cwd: string,
    onExit: (hostId: string, code: number | null) => void,
  ): Promise<SpawnResult> {
    let host: UtilityProcess;
    try {
      host = utilityProcess.fork(this.scriptHostPath, [], {
        serviceName: `EZTerminal Script Host (${hostId})`,
        stdio: 'inherit',
      });
    } catch (err) {
      return Promise.resolve({ error: err instanceof Error ? err.message : String(err) });
    }

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const entry: HostEntry = { process: host, groupId: null, exited };
    const groupId = this.guardian ? `script-host:${hostId}` : null;
    this.hosts.set(hostId, entry);
    host.once('exit', (code) => {
      if (this.hosts.get(hostId) === entry) this.hosts.delete(hostId);
      resolveExited();
      onExit(hostId, code);
    });

    return waitForSpawn(host)
      .then(async (pid) => {
        if (this.guardian && groupId) {
          const parent = this.parentGroupId?.() ?? undefined;
          if (!parent) throw new Error('interpreter process group is unavailable');
          await this.guardian.createGroup(groupId, pid, parent);
          entry.groupId = groupId;
        }
        const { port1, port2 } = new MessageChannelMain();
        host.postMessage({ type: 'init', hostId, scriptPath, args, cwd }, [port2]);
        return { interpreterPort: port1 };
      })
      .catch(async (error: unknown) => {
        await this.kill(hostId);
        return { error: error instanceof Error ? error.message : String(error) };
      });
  }

  /** Kill a host by id. Idempotent — a no-op if it already exited. */
  async kill(hostId: string): Promise<void> {
    const entry = this.hosts.get(hostId);
    if (!entry) return;
    if (this.guardian && entry.groupId) {
      try {
        await this.guardian.terminateGroup(entry.groupId);
      } catch {
        try {
          entry.process.kill();
        } catch {
          // Already exited.
        }
      }
    } else {
      try {
        entry.process.kill();
      } catch {
        // Already exited.
      }
    }
    await Promise.race([
      entry.exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  /** Kill every live host (interpreter shared-fate on its own exit). */
  async killAll(): Promise<void> {
    await Promise.all([...this.hosts.keys()].map((hostId) => this.kill(hostId)));
  }
}
