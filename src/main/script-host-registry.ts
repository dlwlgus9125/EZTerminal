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

export class ScriptHostRegistry {
  private readonly hosts = new Map<string, UtilityProcess>();

  constructor(private readonly scriptHostPath: string) {}

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
  ): SpawnResult {
    let host: UtilityProcess;
    try {
      host = utilityProcess.fork(this.scriptHostPath, [], {
        serviceName: `EZTerminal Script Host (${hostId})`,
        stdio: 'inherit',
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    this.hosts.set(hostId, host);
    host.once('exit', (code) => {
      this.hosts.delete(hostId);
      onExit(hostId, code);
    });

    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: 'init', hostId, scriptPath, args, cwd }, [port2]);
    return { interpreterPort: port1 };
  }

  /** Kill a host by id. Idempotent — a no-op if it already exited. */
  kill(hostId: string): void {
    this.hosts.get(hostId)?.kill();
  }

  /** Kill every live host (interpreter shared-fate on its own exit). */
  killAll(): void {
    for (const host of this.hosts.values()) host.kill();
    this.hosts.clear();
  }
}
