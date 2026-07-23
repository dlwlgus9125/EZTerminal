import { describe, expect, it, vi } from 'vitest';

import { RemoteDesktopController } from './remote-desktop-controller';

class FakeNativeTransport {
  readonly sent: unknown[] = [];
  readonly stop = vi.fn(async () => undefined);
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly exits = new Set<() => void>();

  send(message: unknown): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onExit(listener: () => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
  emit(message: unknown): void { for (const listener of this.messages) listener(message); }
  exit(): void { for (const listener of this.exits) listener(); }
}

const phoneA = {
  clientId: '01947000-0000-4000-8000-000000000001',
  clientName: 'Galaxy A',
  platform: 'android' as const,
};
const phoneB = {
  clientId: '01947000-0000-4000-8000-000000000002',
  clientName: 'Galaxy B',
  platform: 'android' as const,
};
const endpoint = { localAddress: '100.64.0.1', peerAddress: '100.64.0.2' };

describe('RemoteDesktopController', () => {
  it('grants one controller, forwards bounded signaling, and refuses takeover', async () => {
    const native = new FakeNativeTransport();
    const events: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });
    const starting = controller.start(phoneA, endpoint, (event) => events.push(event));
    native.emit({ type: 'ready', protocolVersion: 1, service: 'ready' });
    const started = await starting;
    expect(started).toMatchObject({ ok: true, resumed: false });
    if (!started.ok) throw new Error('expected a successful session');

    expect(native.sent[0]).toMatchObject({
      type: 'hello',
      clientId: phoneA.clientId,
      localAddress: endpoint.localAddress,
      peerAddress: endpoint.peerAddress,
      udpPort: 7422,
    });
    expect(controller.signal(phoneA.clientId, started.sessionId, { type: 'offer', sdp: 'v=0' })).toBe(true);
    expect(native.sent[1]).toEqual({ type: 'offer', sessionId: started.sessionId, sdp: 'v=0' });

    native.emit({ type: 'answer', sessionId: started.sessionId, sdp: 'v=0\r\na=answer' });
    expect(events).toContainEqual({
      kind: 'desktop-signal',
      sessionId: started.sessionId,
      signal: { type: 'answer', sdp: 'v=0\r\na=answer' },
    });
    await expect(controller.start(phoneB, endpoint, vi.fn())).resolves.toEqual({
      ok: false,
      reason: 'busy',
      controllerName: 'Galaxy A',
    });
  });

  it('reserves the lease for the same client for fifteen seconds after disconnect', async () => {
    let now = 1_000;
    const transports: FakeNativeTransport[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      now: () => now,
      createTransport: () => {
        const transport = new FakeNativeTransport();
        transports.push(transport);
        queueMicrotask(() => transport.emit({ type: 'ready', protocolVersion: 1, service: 'ready' }));
        return transport;
      },
    });
    const first = await controller.start(phoneA, endpoint, vi.fn());
    if (!first.ok) throw new Error('expected a successful session');
    controller.disconnected(phoneA.clientId);
    expect(transports[0].stop).toHaveBeenCalledOnce();

    now += 14_000;
    await expect(controller.start(phoneB, endpoint, vi.fn())).resolves.toMatchObject({ ok: false, reason: 'busy' });
    const resumed = await controller.start(phoneA, endpoint, vi.fn());
    expect(resumed).toMatchObject({ ok: true, sessionId: first.sessionId, resumed: true });

    controller.disconnected(phoneA.clientId);
    now += 15_000;
    const next = await controller.start(phoneB, endpoint, vi.fn());
    expect(next).toMatchObject({ ok: true, resumed: false });
    if (!next.ok) throw new Error('expected a successful replacement session');
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it('fails closed when the privileged service is unavailable', async () => {
    const native = new FakeNativeTransport();
    const controller = new RemoteDesktopController({ hostPath: 'unused', createTransport: () => native });
    const starting = controller.start(phoneA, endpoint, vi.fn());
    native.emit({ type: 'ready', protocolVersion: 1, service: 'missing' });
    await expect(starting).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(native.stop).toHaveBeenCalledOnce();
  });
});
