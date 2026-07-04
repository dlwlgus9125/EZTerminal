/**
 * PacketCaptureRegistry — main's broker for the packet-capture utilityProcess
 * (Phase 2B, off-by-default packet preview). Mirrors ScriptHostRegistry
 * (script-host-registry.ts) for the fork + port-handoff shape, but is
 * simpler: there is at most ONE live capture host — re-subscribing kills any
 * existing one first (the plan rejects concurrent capture) — and the host
 * never replies to main at all. Its half of a fresh MessageChannelMain goes
 * straight to the RENDERER (main.ts's `packet-port` broker, the same
 * never-relay-traffic shape as the renderer's cmd-port); main only forks,
 * hands the host its half of the channel, and tracks the process for
 * kill()/exit — it never sees packet rows or capture status.
 */

import { MessageChannelMain, utilityProcess } from 'electron';
import type { MessagePortMain, UtilityProcess } from 'electron';

export class PacketCaptureRegistry {
  private host: UtilityProcess | null = null;

  constructor(private readonly hostPath: string) {}

  /**
   * Kill any existing capture host, fork a fresh one, and hand back the
   * renderer's half of a fresh MessageChannelMain for main to broker onward.
   */
  subscribe(): MessagePortMain {
    this.kill();
    const host = utilityProcess.fork(this.hostPath, [], {
      serviceName: 'EZTerminal Packet Capture',
      stdio: 'inherit',
    });
    this.host = host;
    // Guard against a stale exit callback clobbering a NEWER host: if this
    // host has already been superseded by a later subscribe() by the time it
    // exits, `this.host` no longer points at it and must be left alone.
    host.once('exit', () => {
      if (this.host === host) this.host = null;
    });

    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: 'init' }, [port2]);
    return port1;
  }

  /** Kill the live capture host, if any. Idempotent. */
  kill(): void {
    this.host?.kill();
    this.host = null;
  }
}
