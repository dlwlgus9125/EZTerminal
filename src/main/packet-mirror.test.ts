import { describe, expect, it } from 'vitest';

import { PacketMirror, type RemotePort, type ViewerPortFactory } from './packet-mirror';
import type { RemotePacketFrame } from '../shared/remote-protocol';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakePort implements RemotePort {
  closed = false;
  started = false;
  private readonly messageHandlers: Array<(event: { data: unknown }) => void> = [];

  postMessage(): void {
    /* the mirror never posts to a viewer port — only relays FROM it */
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: simulate the host relaying a frame over this port. A closed
   * port delivers nothing — mirrors a real MessagePortMain. */
  emit(frame: RemotePacketFrame): void {
    if (this.closed) return;
    for (const h of this.messageHandlers) h({ data: frame });
  }
}

class FakeFactory implements ViewerPortFactory {
  readonly created: FakePort[] = [];

  addViewerPort(): RemotePort | null {
    const port = new FakePort();
    this.created.push(port);
    return port;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PacketMirror', () => {
  it('subscribing while NOT live immediately reports idle, without attaching a port', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    const received: RemotePacketFrame[] = [];

    mirror.subscribe((f) => received.push(f));

    expect(received).toEqual([{ type: 'status', status: 'idle' }]);
    expect(factory.created).toHaveLength(0);
  });

  it('subscribing while live attaches a viewer port and relays the frames it sends', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    mirror.setLive(true);
    const received: RemotePacketFrame[] = [];

    mirror.subscribe((f) => received.push(f));

    expect(factory.created).toHaveLength(1);
    expect(factory.created[0].started).toBe(true);

    factory.created[0].emit({ type: 'status', status: 'capturing' });
    expect(received).toEqual([{ type: 'status', status: 'capturing' }]);
  });

  it('setLive(true) attaches a port to a subscriber that joined while not-live', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    const received: RemotePacketFrame[] = [];
    mirror.subscribe((f) => received.push(f)); // not live -> idle only
    expect(factory.created).toHaveLength(0);

    mirror.setLive(true);
    expect(factory.created).toHaveLength(1);

    factory.created[0].emit({ type: 'packets', rows: [] });
    expect(received).toEqual([
      { type: 'status', status: 'idle' },
      { type: 'packets', rows: [] },
    ]);
  });

  it('setLive(false) closes every viewer port and broadcasts idle to every subscriber', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    mirror.setLive(true);
    const receivedA: RemotePacketFrame[] = [];
    const receivedB: RemotePacketFrame[] = [];
    mirror.subscribe((f) => receivedA.push(f));
    mirror.subscribe((f) => receivedB.push(f));
    expect(factory.created).toHaveLength(2);

    mirror.setLive(false);

    expect(factory.created.every((p) => p.closed)).toBe(true);
    expect(receivedA).toEqual([{ type: 'status', status: 'idle' }]);
    expect(receivedB).toEqual([{ type: 'status', status: 'idle' }]);
  });

  it('unsubscribe closes that subscriber\'s port and stops further delivery to it', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    mirror.setLive(true);
    const received: RemotePacketFrame[] = [];
    const unsub = mirror.subscribe((f) => received.push(f));
    const port = factory.created[0];

    unsub();

    expect(port.closed).toBe(true);
    port.emit({ type: 'status', status: 'capturing' }); // closed — delivers nothing
    expect(received).toEqual([]);
  });

  it('does not double-attach: a redundant setLive(true) does not create a second port', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    mirror.setLive(true);
    mirror.subscribe(() => undefined);
    expect(factory.created).toHaveLength(1);

    mirror.setLive(true); // already live — no-op
    expect(factory.created).toHaveLength(1);
  });

  it('does not double-attach: subscribing twice while live gives each subscriber its own port', () => {
    const factory = new FakeFactory();
    const mirror = new PacketMirror(factory);
    mirror.setLive(true);

    mirror.subscribe(() => undefined);
    mirror.subscribe(() => undefined);

    expect(factory.created).toHaveLength(2);
  });
});
