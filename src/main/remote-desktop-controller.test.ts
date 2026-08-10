import { describe, expect, it, vi } from 'vitest';

import { parseRemoteDesktopServiceProbe } from './native-desktop-protocol';
import { RemoteDesktopController } from './remote-desktop-controller';

class FakeNativeTransport {
  readonly sent: unknown[] = [];
  readonly stop = vi.fn<() => Promise<void>>(async () => undefined);
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
const connectionA = 'connection-a';
const connectionA2 = 'connection-a-2';
const connectionB = 'connection-b';

describe('RemoteDesktopController', () => {
  it('keeps PC Control available when the installed host probe emits v2 ready', async () => {
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      probeService: async () => parseRemoteDesktopServiceProbe(JSON.stringify({
        protocolVersion: 2,
        service: 'ready',
      })),
    });

    expect(controller.isAvailable()).toBe(false);
    await expect(controller.probeService()).resolves.toMatchObject({ service: 'ready' });
    expect(controller.isAvailable()).toBe(true);
  });

  it('isolates a throwing status observer from state transitions and later observers', async () => {
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      probeService: async () => 'ready',
    });
    const seen: string[] = [];
    controller.onStatus(() => {
      throw new Error('destroyed observer');
    });
    controller.onStatus((status) => seen.push(status.service));

    await expect(controller.probeService()).resolves.toMatchObject({ service: 'ready' });
    expect(seen).toEqual(['ready']);
  });

  it('grants one controller, forwards bounded signaling, and refuses takeover', async () => {
    const native = new FakeNativeTransport();
    const events: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });
    const starting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      (event) => events.push(event),
      {
        pixelWidth: 1_170,
        pixelHeight: 2_160,
        visibleRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.75 },
        revision: 3,
      },
      'clarity',
    );
    native.emit({
      type: 'ready',
      protocolVersion: 2,
      service: 'ready',
      features: ['adaptive-region-v1', 'quality-preference-v1', 'client-video-stats-v2'],
    });
    const started = await starting;
    expect(started).toMatchObject({ ok: true, resumed: false });
    if (!started.ok) throw new Error('expected a successful session');
    expect(started.capabilities).toMatchObject({
      adaptiveRegion: true,
      qualityPreferences: ['balanced', 'clarity', 'responsiveness'],
      clientVideoStatsV2: true,
    });

    expect(native.sent[0]).toMatchObject({
      type: 'hello',
      clientId: phoneA.clientId,
      localAddress: endpoint.localAddress,
      peerAddress: endpoint.peerAddress,
      udpPort: 7422,
      viewport: {
        pixelWidth: 1_170,
        pixelHeight: 2_160,
        visibleRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.75 },
        revision: 3,
      },
      qualityPreference: 'clarity',
    });
    expect(
      controller.signal(
        phoneA.clientId,
        connectionA,
        started.sessionId,
        { type: 'offer', sdp: 'v=0' },
      ),
    ).toBe(true);
    expect(native.sent[1]).toEqual({ type: 'offer', sessionId: started.sessionId, sdp: 'v=0' });

    native.emit({ type: 'answer', sessionId: started.sessionId, sdp: 'v=0\r\na=answer' });
    expect(events).toContainEqual({
      kind: 'desktop-signal',
      sessionId: started.sessionId,
      signal: { type: 'answer', sdp: 'v=0\r\na=answer' },
    });
    native.emit({
      type: 'state',
      sessionId: started.sessionId,
      state: 'active',
      metrics: {
        framesPerSecond: 30,
        bitrateBps: 2_000_000,
        roundTripTimeMs: 20,
        packetLossPercent: 0,
        qualityTier: 'high',
        streamWidth: 1_170,
        streamHeight: 658,
        qualityPreference: 'clarity',
        targetFramesPerSecond: 30,
        decodedFramesPerSecond: 29,
        clientDroppedFramePercent: 1.5,
        clientFreezeDurationMs: 0,
        captureBackend: 'dxgi',
        encoderBackend: 'media-foundation-hardware',
        appliedViewRevision: 3,
        sourceRegion: { x: 0.15, y: 0.05, width: 0.6, height: 0.85 },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'desktop-control-status',
      streamWidth: 1_170,
      streamHeight: 658,
      qualityPreference: 'clarity',
      captureBackend: 'dxgi',
      encoderBackend: 'media-foundation-hardware',
      appliedViewRevision: 3,
      sourceRegion: { x: 0.15, y: 0.05, width: 0.6, height: 0.85 },
    }));
    await expect(controller.start(phoneB, connectionB, endpoint, vi.fn())).resolves.toEqual({
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
        queueMicrotask(() => transport.emit({ type: 'ready', protocolVersion: 2, service: 'ready' }));
        return transport;
      },
    });
    const first = await controller.start(phoneA, connectionA, endpoint, vi.fn());
    if (!first.ok) throw new Error('expected a successful session');
    controller.disconnected(phoneA.clientId, connectionA);
    expect(transports[0].stop).toHaveBeenCalledOnce();

    now += 14_000;
    await expect(
      controller.start(phoneB, connectionB, endpoint, vi.fn()),
    ).resolves.toMatchObject({ ok: false, reason: 'busy' });
    const resumed = await controller.start(phoneA, connectionA2, endpoint, vi.fn());
    expect(resumed).toMatchObject({ ok: true, sessionId: first.sessionId, resumed: true });

    controller.disconnected(phoneA.clientId, connectionA2);
    now += 15_000;
    const next = await controller.start(phoneB, connectionB, endpoint, vi.fn());
    expect(next).toMatchObject({ ok: true, resumed: false });
    if (!next.ok) throw new Error('expected a successful replacement session');
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it('ignores late close, signal, and stop work from a superseded socket generation', async () => {
    const native = new FakeNativeTransport();
    const firstEvents: unknown[] = [];
    const resumedEvents: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });
    const firstStarting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      (event) => firstEvents.push(event),
    );
    native.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    const first = await firstStarting;
    if (!first.ok) throw new Error('expected a successful session');

    await expect(
      controller.start(
        phoneA,
        connectionA2,
        endpoint,
        (event) => resumedEvents.push(event),
      ),
    ).resolves.toMatchObject({ ok: true, sessionId: first.sessionId });

    controller.disconnected(phoneA.clientId, connectionA);
    expect(native.stop).not.toHaveBeenCalled();
    expect(
      controller.signal(
        phoneA.clientId,
        connectionA,
        first.sessionId,
        { type: 'offer', sdp: 'stale' },
      ),
    ).toBe(false);
    await expect(
      controller.stop(phoneA.clientId, connectionA, first.sessionId),
    ).resolves.toBe(false);

    expect(
      controller.signal(
        phoneA.clientId,
        connectionA2,
        first.sessionId,
        { type: 'offer', sdp: 'current' },
      ),
    ).toBe(true);
    native.emit({ type: 'answer', sessionId: first.sessionId, sdp: 'answer' });
    expect(firstEvents).toEqual([]);
    expect(resumedEvents).toContainEqual({
      kind: 'desktop-signal',
      sessionId: first.sessionId,
      signal: { type: 'answer', sdp: 'answer' },
    });
  });

  it('fails closed when the privileged service is unavailable', async () => {
    const native = new FakeNativeTransport();
    const controller = new RemoteDesktopController({ hostPath: 'unused', createTransport: () => native });
    const starting = controller.start(phoneA, connectionA, endpoint, vi.fn());
    native.emit({ type: 'ready', protocolVersion: 2, service: 'missing' });
    await expect(starting).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(native.stop).toHaveBeenCalledOnce();
  });

  it('fails immediately and silently when broker acquisition rejects before native readiness', async () => {
    const native = new FakeNativeTransport();
    const events: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });

    const starting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      (event) => events.push(event),
    );
    native.emit({
      type: 'error',
      sessionId: null,
      code: 'lease-busy',
      message: 'not public',
    });

    await expect(starting).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(native.stop).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it('serializes duplicate same-client starts behind one native readiness result', async () => {
    const native = new FakeNativeTransport();
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });
    let duplicateSettled = false;

    const first = controller.start(phoneA, connectionA, endpoint, vi.fn());
    const duplicate = controller.start(phoneA, connectionA, endpoint, vi.fn()).finally(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();

    expect(duplicateSettled).toBe(false);
    expect(native.sent).toHaveLength(1);
    native.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toMatchObject({ ok: true, resumed: false });
    expect(duplicateResult).toMatchObject({
      ok: true,
      sessionId: firstResult.ok ? firstResult.sessionId : 'unexpected',
      resumed: false,
    });
  });

  it('fails a start superseded by a newer socket generation before native readiness', async () => {
    const native = new FakeNativeTransport();
    const firstEvents: unknown[] = [];
    const replacementEvents: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });

    const first = controller.start(
      phoneA,
      connectionA,
      endpoint,
      (event) => firstEvents.push(event),
    );
    const replacement = controller.start(
      phoneA,
      connectionA2,
      endpoint,
      (event) => replacementEvents.push(event),
    );
    native.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });

    await expect(first).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    const replacementResult = await replacement;
    expect(replacementResult).toMatchObject({ ok: true, resumed: false });
    if (!replacementResult.ok) throw new Error('expected the replacement to own the session');

    expect(controller.signal(
      phoneA.clientId,
      connectionA,
      replacementResult.sessionId,
      { type: 'offer', sdp: 'stale' },
    )).toBe(false);
    expect(controller.signal(
      phoneA.clientId,
      connectionA2,
      replacementResult.sessionId,
      { type: 'offer', sdp: 'current' },
    )).toBe(true);
    native.emit({ type: 'answer', sessionId: replacementResult.sessionId, sdp: 'answer' });
    expect(firstEvents).toEqual([]);
    expect(replacementEvents).toContainEqual({
      kind: 'desktop-signal',
      sessionId: replacementResult.sessionId,
      signal: { type: 'answer', sdp: 'answer' },
    });
  });

  it('waits for the prior PID teardown before starting a fast same-client resume', async () => {
    let finishFirstStop!: () => void;
    const firstStop = new Promise<void>((resolve) => {
      finishFirstStop = resolve;
    });
    const transports: FakeNativeTransport[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => {
        const transport = new FakeNativeTransport();
        if (transports.length === 0) {
          transport.stop.mockImplementationOnce(() => firstStop);
        }
        transports.push(transport);
        return transport;
      },
    });

    const firstStarting = controller.start(phoneA, connectionA, endpoint, vi.fn());
    transports[0].emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    const first = await firstStarting;
    if (!first.ok) throw new Error('expected a successful first session');

    controller.disconnected(phoneA.clientId, connectionA);
    const resumedStarting = controller.start(phoneA, connectionA2, endpoint, vi.fn());
    await Promise.resolve();
    expect(transports).toHaveLength(1);

    finishFirstStop();
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    transports[1].emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    await expect(resumedStarting).resolves.toMatchObject({
      ok: true,
      sessionId: first.sessionId,
      resumed: true,
    });
  });

  it('ignores late native events from the transport replaced by a same-client resume', async () => {
    const transports: FakeNativeTransport[] = [];
    const resumedEvents: unknown[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => {
        const transport = new FakeNativeTransport();
        transports.push(transport);
        return transport;
      },
    });

    const firstStarting = controller.start(phoneA, connectionA, endpoint, vi.fn());
    transports[0].emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    const first = await firstStarting;
    if (!first.ok) throw new Error('expected a successful first session');

    controller.disconnected(phoneA.clientId, connectionA);
    const resumedStarting = controller.start(
      phoneA,
      connectionA2,
      endpoint,
      (event) => resumedEvents.push(event),
    );
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    transports[1].emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    await expect(resumedStarting).resolves.toMatchObject({
      ok: true,
      sessionId: first.sessionId,
      resumed: true,
    });
    transports[1].emit({
      type: 'state',
      sessionId: first.sessionId,
      state: 'active',
    });

    transports[0].emit({
      type: 'answer',
      sessionId: first.sessionId,
      sdp: 'stale-answer',
    });
    transports[0].emit({
      type: 'error',
      sessionId: first.sessionId,
      code: 'STALE_OLD_TRANSPORT',
    });
    transports[0].exit();

    expect(controller.getStatus()).toMatchObject({
      state: 'active',
      controllerName: phoneA.clientName,
      errorCode: null,
    });
    expect(resumedEvents).not.toContainEqual(expect.objectContaining({
      kind: 'desktop-signal',
      signal: expect.objectContaining({ sdp: 'stale-answer' }),
    }));
    expect(resumedEvents).not.toContainEqual(expect.objectContaining({
      kind: 'desktop-control-ended',
      errorCode: 'STALE_OLD_TRANSPORT',
    }));
  });

  it('does not let an older authenticated socket reclaim a newer same-client connection', async () => {
    const native = new FakeNativeTransport();
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });
    const connectionAuthority = controller as RemoteDesktopController & {
      connected?: (clientId: string, connectionId: string) => void;
    };

    connectionAuthority.connected?.(phoneA.clientId, connectionA);
    const firstStarting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      vi.fn(),
    );
    native.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    const first = await firstStarting;
    if (!first.ok) throw new Error('expected a successful first session');

    connectionAuthority.connected?.(phoneA.clientId, connectionA2);
    await expect(
      controller.start(phoneA, connectionA2, endpoint, vi.fn()),
    ).resolves.toMatchObject({
      ok: true,
      sessionId: first.sessionId,
    });

    await expect(
      controller.start(phoneA, connectionA, endpoint, vi.fn()),
    ).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(controller.signal(
      phoneA.clientId,
      connectionA,
      first.sessionId,
      { type: 'offer', sdp: 'stale' },
    )).toBe(false);
    expect(controller.signal(
      phoneA.clientId,
      connectionA2,
      first.sessionId,
      { type: 'offer', sdp: 'current' },
    )).toBe(true);
  });

  it('keeps a superseded socket stale after the newest same-client socket disconnects', async () => {
    const transports: FakeNativeTransport[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => {
        const transport = new FakeNativeTransport();
        transports.push(transport);
        queueMicrotask(() => {
          transport.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
        });
        return transport;
      },
    });

    controller.connected(phoneA.clientId, connectionA);
    const first = await controller.start(phoneA, connectionA, endpoint, vi.fn());
    if (!first.ok) throw new Error('expected a successful first session');
    controller.connected(phoneA.clientId, connectionA2);
    await expect(
      controller.start(phoneA, connectionA2, endpoint, vi.fn()),
    ).resolves.toMatchObject({ ok: true, sessionId: first.sessionId });

    controller.disconnected(phoneA.clientId, connectionA2);
    await expect(
      controller.start(phoneA, connectionA, endpoint, vi.fn()),
    ).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(transports).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      state: 'reconnecting',
      controllerName: phoneA.clientName,
    });
  });

  it('rejects an in-flight start superseded by a newer authenticated socket', async () => {
    const native = new FakeNativeTransport();
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => native,
    });

    controller.connected(phoneA.clientId, connectionA);
    const staleStarting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      vi.fn(),
    );
    controller.connected(phoneA.clientId, connectionA2);
    native.emit({ type: 'ready', protocolVersion: 2, service: 'ready' });

    await expect(staleStarting).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(native.stop).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toMatchObject({ state: 'idle' });
  });

  it('starts a fresh native child when reconnecting while initial readiness is pending', async () => {
    let finishFirstStop!: () => void;
    const firstStop = new Promise<void>((resolve) => {
      finishFirstStop = resolve;
    });
    const transports: FakeNativeTransport[] = [];
    const controller = new RemoteDesktopController({
      hostPath: 'unused',
      createTransport: () => {
        const transport = new FakeNativeTransport();
        if (transports.length === 0) {
          transport.stop.mockImplementationOnce(() => firstStop);
        }
        transports.push(transport);
        return transport;
      },
    });

    const firstStarting = controller.start(
      phoneA,
      connectionA,
      endpoint,
      vi.fn(),
    );
    expect(transports).toHaveLength(1);
    controller.disconnected(phoneA.clientId, connectionA);

    const resumedStarting = controller.start(
      phoneA,
      connectionA2,
      endpoint,
      vi.fn(),
    );
    finishFirstStop();
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    transports[1].emit({ type: 'ready', protocolVersion: 2, service: 'ready' });
    const resumed = await resumedStarting;
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    if (!resumed.ok) throw new Error('expected a successful resumed session');

    transports[0].exit();
    await expect(firstStarting).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(controller.signal(
      phoneA.clientId,
      connectionA2,
      resumed.sessionId,
      { type: 'offer', sdp: 'current' },
    )).toBe(true);

    transports[1].exit();
    expect(controller.getStatus()).toMatchObject({
      state: 'error',
      errorCode: 'NATIVE_PROCESS_EXITED',
    });
  });
});
