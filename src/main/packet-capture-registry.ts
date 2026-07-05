/**
 * PacketCaptureRegistry — main's broker for the packet-capture utilityProcess
 * (Phase 2B, off-by-default packet preview; M3 extends it with a mobile
 * mirror's viewer port). Mirrors ScriptHostRegistry (script-host-registry.ts)
 * for the fork + port-handoff shape, but is simpler: there is at most ONE live
 * capture host — re-subscribing kills any existing one first (the plan
 * rejects concurrent capture) — and the host never replies to main at all.
 * Its half of a fresh MessageChannelMain goes straight to the RENDERER
 * (main.ts's `packet-port` broker, the same never-relay-traffic shape as the
 * renderer's cmd-port); main only forks, hands the host its half of the
 * channel, and tracks the process for kill()/exit — it never sees packet rows
 * or capture status.
 *
 * `onLiveChange` (M3) reports host lifecycle transitions to `PacketMirror`
 * (src/main/packet-mirror.ts), which uses them to broadcast `'idle'` to
 * mobile viewers when there is no host to tee from. `addViewerPort()` hands
 * the LIVE host a SECOND, independent port via `{type:'add-port'}` — the
 * desktop's own direct port above is never touched by this, so a mobile
 * viewer attaching/detaching has zero effect on the desktop capture (this
 * class never calls `subscribe()`/`kill()` on the mobile viewer's behalf).
 */

import { MessageChannelMain, utilityProcess } from 'electron';
import type { MessagePortMain, UtilityProcess } from 'electron';

export class PacketCaptureRegistry {
  private host: UtilityProcess | null = null;

  constructor(
    private readonly hostPath: string,
    private readonly onLiveChange?: (live: boolean) => void,
  ) {}

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
      if (this.host === host) {
        this.host = null;
        this.onLiveChange?.(false);
      }
    });

    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: 'init' }, [port2]);
    this.onLiveChange?.(true);
    return port1;
  }

  /** Kill the live capture host, if any. Idempotent. */
  kill(): void {
    const hadHost = this.host !== null;
    this.host?.kill();
    this.host = null;
    if (hadHost) this.onLiveChange?.(false);
  }

  /**
   * Hand the live host a SECOND port (a mobile mirror's viewer port) —
   * `null` when no host is running (the caller broadcasts `'idle'` instead).
   */
  addViewerPort(): MessagePortMain | null {
    if (!this.host) return null;
    const { port1, port2 } = new MessageChannelMain();
    this.host.postMessage({ type: 'add-port' }, [port2]);
    return port1;
  }
}
