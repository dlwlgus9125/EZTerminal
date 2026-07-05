/**
 * PacketMirror — brokers the mobile packet-tee's VIEWER side (M3). Electron-
 * free: it only depends on the narrow `RemotePort` shape already defined by
 * `remote-bridge.ts` (postMessage/on/start/close — a real `MessagePortMain`
 * satisfies it structurally), so this class is unit-testable with a fake
 * factory/port, same discipline as `remote-bridge.ts`'s own DI seams.
 *
 * One `PacketMirror` instance serves every remote (mobile) connection that
 * subscribes to packets: each subscriber gets its OWN viewer port (via
 * `ViewerPortFactory.addViewerPort()`, which under the hood asks
 * `PacketCaptureRegistry` to fan out ANOTHER port from the live capture host
 * — see that class's header comment). The desktop's own direct port is never
 * touched here, so mobile viewers attaching/detaching has zero effect on the
 * desktop capture.
 *
 * `setLive(...)` is driven by `PacketCaptureRegistry`'s `onLiveChange`
 * callback (host forked/killed/exited): while NOT live, every subscriber
 * (present and future) is told `'idle'` instead of getting a port, since
 * there is no host to tee frames from.
 */
import type { RemotePacketFrame } from '../shared/remote-protocol';

/** Narrow seam over `PacketCaptureRegistry.addViewerPort()` — real instances
 * satisfy this structurally (a `MessagePortMain` IS a `RemotePort`). */
export interface ViewerPortFactory {
  addViewerPort(): RemotePort | null;
}

/** Same shape as `remote-bridge.ts`'s `RemotePort` — duplicated (not
 * imported) to keep this module free of any dependency ON the bridge. */
export interface RemotePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

interface Subscriber {
  readonly listener: (frame: RemotePacketFrame) => void;
  port: RemotePort | null;
}

const IDLE_FRAME: RemotePacketFrame = { type: 'status', status: 'idle' };

export class PacketMirror {
  private live = false;
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly factory: ViewerPortFactory) {}

  /** Driven by `PacketCaptureRegistry.onLiveChange`. A transition only —
   * calling with the current value again is a no-op (no double-attach). */
  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    if (live) {
      for (const sub of this.subscribers) {
        if (!sub.port) this.attach(sub);
      }
    } else {
      for (const sub of this.subscribers) {
        sub.port?.close();
        sub.port = null;
        sub.listener(IDLE_FRAME);
      }
    }
  }

  /** Subscribe to packet frames. While live, attaches a viewer port right
   * away and relays every frame the host sends over it (including its own
   * status replay). While not live, immediately reports `'idle'` and attaches
   * a port only once `setLive(true)` fires. Returns an unsubscribe. */
  subscribe(listener: (frame: RemotePacketFrame) => void): () => void {
    const sub: Subscriber = { listener, port: null };
    this.subscribers.add(sub);
    if (this.live) {
      this.attach(sub);
    } else {
      listener(IDLE_FRAME);
    }
    return () => {
      this.subscribers.delete(sub);
      sub.port?.close();
      sub.port = null;
    };
  }

  private attach(sub: Subscriber): void {
    const port = this.factory.addViewerPort();
    if (!port) return; // defensive — `live` should already imply a host exists
    sub.port = port;
    port.on('message', (event) => sub.listener(event.data as RemotePacketFrame));
    port.start();
  }
}
