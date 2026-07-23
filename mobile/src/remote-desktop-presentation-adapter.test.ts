import { describe, expect, it, vi } from 'vitest';

import type {
  DesktopControlEndedMessage,
  DesktopControlStartResultMessage,
  DesktopControlStatusMessage,
  DesktopSessionSignal,
  DesktopSignalMessage,
} from '../../src/shared/remote-protocol';
import {
  MAX_DESKTOP_CLIPBOARD_BYTES,
  RemoteDesktopPresentationAdapter,
  decodeDesktopControlFrame,
  type DesktopPresentationDependencies,
  type DesktopPresentationTransport,
} from './remote-desktop-presentation-adapter';
import type { RemoteConnectionState } from './transport/connection-health';

const DISPLAY = {
  id: 'primary',
  name: 'Primary display',
  width: 1920,
  height: 1080,
  rotationDegrees: 0,
  primary: true,
} as const;

function success(
  sessionId = 'session-1',
): Extract<DesktopControlStartResultMessage, { readonly ok: true }> {
  return {
    kind: 'desktop-control-start-result',
    requestId: `request-${sessionId}`,
    ok: true,
    sessionId,
    displays: [DISPLAY],
    selectedDisplayId: DISPLAY.id,
    endpoint: { address: '127.0.0.1', port: 7422 },
    capabilities: {
      ctrlAltDelete: false,
      clipboardText: true,
      directTouch: true,
      multiMonitor: true,
    },
    resumed: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = 'closed';
  });

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('channel is closed');
    if (typeof data !== 'string') throw new Error('test channel only accepts text');
    this.sent.push(data);
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  readonly control = new FakeDataChannel();
  readonly pointer = new FakeDataChannel();
  readonly addTransceiver = vi.fn(() => ({} as RTCRtpTransceiver));
  readonly createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'offer',
    sdp: 'v=0',
  }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  createDataChannel(label: string): RTCDataChannel {
    return (label === 'ez-control-v1' ? this.control : this.pointer) as unknown as RTCDataChannel;
  }

  emitConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

class FakeTransport implements DesktopPresentationTransport {
  readonly startDesktopControl = vi.fn(() => {
    const next = this.starts.shift();
    if (!next) throw new Error('no queued desktop start');
    return next;
  });
  readonly sendDesktopSignal = vi.fn((sessionId: string, signal: DesktopSessionSignal) => {
    void sessionId;
    void signal;
    return true;
  });
  readonly stopDesktopControl = vi.fn((
    sessionId: string,
    reason: 'client-stop' | 'background' | 'navigation',
  ) => {
    void sessionId;
    void reason;
    return true;
  });
  private state: RemoteConnectionState = 'connected';
  private readonly signalListeners = new Set<(message: DesktopSignalMessage) => void>();
  private readonly statusListeners = new Set<(message: DesktopControlStatusMessage) => void>();
  private readonly endedListeners = new Set<(message: DesktopControlEndedMessage) => void>();
  private readonly connectionListeners = new Set<(state: RemoteConnectionState) => void>();

  constructor(readonly starts: Array<Promise<DesktopControlStartResultMessage>>) {}

  onDesktopSignal(listener: (message: DesktopSignalMessage) => void): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  onDesktopStatus(listener: (message: DesktopControlStatusMessage) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onDesktopEnded(listener: (message: DesktopControlEndedMessage) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  onConnectionStateChange(listener: (state: RemoteConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.state);
    return () => this.connectionListeners.delete(listener);
  }

  emitConnection(state: RemoteConnectionState): void {
    this.state = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  emitSignal(message: DesktopSignalMessage): void {
    for (const listener of this.signalListeners) listener(message);
  }

  emitEnded(message: DesktopControlEndedMessage): void {
    for (const listener of this.endedListeners) listener(message);
  }

  get listenerCount(): number {
    return this.signalListeners.size
      + this.statusListeners.size
      + this.endedListeners.size
      + this.connectionListeners.size;
  }
}

class FakeVisibility {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  readonly adapter = {
    isHidden: () => this.hidden,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  emit(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function harness(
  starts: Array<Promise<DesktopControlStartResultMessage>>,
  options: {
    readonly readText?: () => Promise<string>;
    readonly writeText?: (text: string) => Promise<void>;
    readonly createPeerConnection?: () => RTCPeerConnection;
  } = {},
): {
  readonly adapter: RemoteDesktopPresentationAdapter;
  readonly transport: FakeTransport;
  readonly peers: FakePeerConnection[];
  readonly visibility: FakeVisibility;
  readonly readText: ReturnType<typeof vi.fn<() => Promise<string>>>;
  readonly writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
} {
  const transport = new FakeTransport(starts);
  const peers: FakePeerConnection[] = [];
  const visibility = new FakeVisibility();
  const readText = vi.fn(options.readText ?? (async () => 'mobile clipboard'));
  const writeText = vi.fn(options.writeText ?? (async () => undefined));
  const dependencies: DesktopPresentationDependencies = {
    clipboard: { readText, writeText },
    visibility: visibility.adapter,
    createPeerConnection: options.createPeerConnection ?? (() => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    }),
  };
  return {
    adapter: new RemoteDesktopPresentationAdapter(transport, dependencies),
    transport,
    peers,
    visibility,
    readText,
    writeText,
  };
}

describe('RemoteDesktopPresentationAdapter', () => {
  it('owns negotiation, sequenced input, and idempotent teardown behind one interface', async () => {
    const { adapter, peers, transport, visibility } = harness([Promise.resolve(success())]);
    const listener = vi.fn();
    adapter.subscribe(listener);

    adapter.start();
    adapter.start();
    await settle();

    expect(transport.startDesktopControl).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(1);
    expect(transport.sendDesktopSignal).toHaveBeenCalledWith(
      'session-1',
      { type: 'offer', sdp: 'v=0' },
    );
    expect(adapter.getSnapshot()).toMatchObject({
      phase: 'starting',
      selectedDisplayId: 'primary',
      capabilities: { ctrlAltDelete: false, clipboardText: true },
    });

    peers[0].emitConnectionState('connected');
    expect(adapter.getSnapshot().phase).toBe('active');
    expect(adapter.sendPointer({ type: 'pointer-absolute', x: 0.25, y: 0.75 })).toBe(true);
    expect(adapter.sendControl({
      type: 'key',
      code: 'Enter',
      down: true,
      modifiers: [],
    })).toBe(true);
    expect(JSON.parse(peers[0].pointer.sent[0])).toMatchObject({
      type: 'pointer-absolute',
      sessionId: 'session-1',
      sequence: 1,
    });
    expect(JSON.parse(peers[0].control.sent[0])).toMatchObject({
      type: 'key',
      sessionId: 'session-1',
      sequence: 2,
    });

    adapter.dispose();
    adapter.dispose();
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(transport.stopDesktopControl).toHaveBeenCalledWith('session-1', 'navigation');
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(transport.listenerCount).toBe(0);
    expect(visibility.listenerCount).toBe(0);
    expect(listener).toHaveBeenCalled();
  });

  it('fails closed when the host capability or browser WebRTC capability is absent', async () => {
    const unsupported = harness([Promise.resolve({
      kind: 'desktop-control-start-result',
      requestId: 'unsupported',
      ok: false,
      reason: 'unavailable',
      errorCode: 'UNSUPPORTED',
    })]);
    unsupported.adapter.start();
    await settle();
    expect(unsupported.peers).toHaveLength(0);
    expect(unsupported.adapter.getSnapshot()).toMatchObject({
      phase: 'error',
      detail: { kind: 'start-error', errorCode: 'UNSUPPORTED' },
      capabilities: null,
    });

    const missingWebRtc = harness([Promise.resolve(success('missing-webrtc'))], {
      createPeerConnection: () => {
        throw new Error('WebRTC unavailable');
      },
    });
    missingWebRtc.adapter.start();
    await settle();
    expect(missingWebRtc.adapter.getSnapshot()).toMatchObject({
      phase: 'error',
      detail: { kind: 'start-failed' },
    });
    expect(missingWebRtc.transport.stopDesktopControl).toHaveBeenCalledWith(
      'missing-webrtc',
      'navigation',
    );
  });

  it('does not transmit commands whose optional capability was not granted', async () => {
    const result = success('limited-capabilities');
    const limitedResult: Extract<
      DesktopControlStartResultMessage,
      { readonly ok: true }
    > = {
      ...result,
      capabilities: {
        ctrlAltDelete: false,
        clipboardText: false,
        directTouch: false,
        multiMonitor: false,
      },
    };
    const { adapter, peers } = harness([Promise.resolve(limitedResult)]);
    adapter.start();
    await settle();

    expect(adapter.sendControl({ type: 'secure-attention' })).toBe(false);
    adapter.copyRemoteClipboard();
    expect(adapter.getSnapshot().clipboardFeedback).toBe('input-unavailable');
    expect(adapter.sendPointer({ type: 'pointer-absolute', x: 0.5, y: 0.5 })).toBe(false);
    expect(adapter.sendControl({
      type: 'pointer-button',
      button: 'left',
      down: true,
      x: 0.5,
      y: 0.5,
    })).toBe(false);
    expect(adapter.selectDisplay('primary')).toBe(false);
    expect(peers[0].control.sent).toHaveLength(0);
    expect(peers[0].pointer.sent).toHaveLength(0);

    expect(adapter.sendPointer({ type: 'pointer-relative', dx: 1, dy: -1 })).toBe(true);
    adapter.dispose();
  });

  it('releases a successful late start and never revives a disposed generation', async () => {
    const pending = deferred<DesktopControlStartResultMessage>();
    const { adapter, peers, transport } = harness([pending.promise]);
    const listener = vi.fn();
    adapter.subscribe(listener);
    adapter.start();
    adapter.dispose();
    listener.mockClear();

    pending.resolve(success('late-session'));
    await settle();

    expect(peers).toHaveLength(0);
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(transport.stopDesktopControl).toHaveBeenCalledWith('late-session', 'navigation');
    expect(transport.listenerCount).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().phase).toBe('starting');
  });

  it('reuses an in-flight start across a StrictMode-style dispose/start cycle', async () => {
    const pending = deferred<DesktopControlStartResultMessage>();
    const { adapter, peers, transport } = harness([pending.promise]);
    adapter.start();
    adapter.dispose();
    adapter.start();

    expect(transport.startDesktopControl).toHaveBeenCalledOnce();
    pending.resolve(success('strict-session'));
    await settle();

    expect(peers).toHaveLength(1);
    expect(transport.stopDesktopControl).not.toHaveBeenCalled();
    peers[0].emitConnectionState('connected');
    expect(adapter.getSnapshot().phase).toBe('active');
    adapter.dispose();
    expect(transport.stopDesktopControl).toHaveBeenCalledWith(
      'strict-session',
      'navigation',
    );
  });

  it('invalidates old peer callbacks across reconnect generations', async () => {
    const resumed = deferred<DesktopControlStartResultMessage>();
    const { adapter, peers, transport } = harness([
      Promise.resolve(success('reconnect-session')),
      resumed.promise,
    ]);
    adapter.start();
    await settle();
    const oldPeer = peers[0];
    oldPeer.emitConnectionState('connected');
    expect(adapter.sendControl({
      type: 'key',
      code: 'Enter',
      down: true,
      modifiers: [],
    })).toBe(true);
    expect(JSON.parse(oldPeer.control.sent[0]).sequence).toBe(1);
    expect(adapter.getSnapshot().phase).toBe('active');

    transport.emitConnection('reconnecting');
    expect(oldPeer.close).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().phase).toBe('reconnecting');
    oldPeer.emitConnectionState('connected');
    oldPeer.control.emit(JSON.stringify({ type: 'input-error' }));
    expect(adapter.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      clipboardFeedback: 'none',
    });

    transport.emitConnection('connected');
    expect(transport.startDesktopControl).toHaveBeenCalledTimes(2);
    resumed.resolve({ ...success('reconnect-session'), resumed: true });
    await settle();
    expect(peers).toHaveLength(2);
    peers[1].emitConnectionState('connected');
    expect(adapter.getSnapshot().phase).toBe('active');
    expect(adapter.sendControl({
      type: 'key',
      code: 'Enter',
      down: false,
      modifiers: [],
    })).toBe(true);
    expect(JSON.parse(peers[1].control.sent[0]).sequence).toBe(2);

    transport.emitEnded({
      kind: 'desktop-control-ended',
      sessionId: 'another-session',
      reason: 'peer-timeout',
    });
    expect(adapter.getSnapshot().phase).toBe('active');
    adapter.dispose();
  });

  it('reuses a pre-session start across a connection-generation change', async () => {
    const pending = deferred<DesktopControlStartResultMessage>();
    const { adapter, transport, peers } = harness([pending.promise]);
    adapter.start();
    transport.emitConnection('reconnecting');
    transport.emitConnection('connected');
    expect(transport.startDesktopControl).toHaveBeenCalledOnce();

    pending.resolve(success('shared-session'));
    await settle();

    expect(peers).toHaveLength(1);
    expect(transport.stopDesktopControl).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().selectedDisplayId).toBe('primary');
    adapter.dispose();
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
  });

  it('never adopts a start that completes after the app moves to the background', async () => {
    const pending = deferred<DesktopControlStartResultMessage>();
    const { adapter, peers, transport, visibility } = harness([pending.promise]);
    adapter.start();

    visibility.emit(true);
    pending.resolve(success('background-session'));
    await settle();

    expect(peers).toHaveLength(0);
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(transport.stopDesktopControl).toHaveBeenCalledWith(
      'background-session',
      'background',
    );
    adapter.dispose();
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();

    const initiallyHidden = harness([Promise.resolve(success('never-started'))]);
    initiallyHidden.visibility.hidden = true;
    initiallyHidden.adapter.start();
    await settle();
    expect(initiallyHidden.transport.startDesktopControl).not.toHaveBeenCalled();
    expect(initiallyHidden.peers).toHaveLength(0);
    initiallyHidden.adapter.dispose();
  });

  it('applies the remote answer before ordered ICE candidates', async () => {
    const { adapter, peers, transport } = harness([Promise.resolve(success('ice-order'))]);
    adapter.start();
    await settle();
    const remoteDescription = deferred<undefined>();
    peers[0].setRemoteDescription.mockImplementationOnce(() => remoteDescription.promise);
    const candidate = {
      candidate: 'candidate:1 1 UDP 1 127.0.0.1 7422 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };

    transport.emitSignal({
      kind: 'desktop-signal',
      sessionId: 'ice-order',
      signal: { type: 'answer', sdp: 'v=0 answer' },
    });
    transport.emitSignal({
      kind: 'desktop-signal',
      sessionId: 'ice-order',
      signal: { type: 'ice', candidate },
    });
    await settle();

    expect(peers[0].setRemoteDescription).toHaveBeenCalledOnce();
    expect(peers[0].addIceCandidate).not.toHaveBeenCalled();
    remoteDescription.resolve(undefined);
    await settle();
    expect(peers[0].addIceCandidate).toHaveBeenCalledOnce();
    expect(peers[0].addIceCandidate).toHaveBeenCalledWith(candidate);
    adapter.dispose();
  });

  it('bounds pre-answer ICE and fails closed when the host exceeds the limit', async () => {
    const { adapter, peers, transport } = harness([Promise.resolve(success('ice-overflow'))]);
    adapter.start();
    await settle();

    for (let index = 0; index <= 128; index += 1) {
      transport.emitSignal({
        kind: 'desktop-signal',
        sessionId: 'ice-overflow',
        signal: {
          type: 'ice',
          candidate: { candidate: `candidate:${index}` },
        },
      });
    }

    expect(peers[0].addIceCandidate).not.toHaveBeenCalled();
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot()).toMatchObject({
      phase: 'error',
      detail: { kind: 'negotiation-failed' },
    });
    adapter.dispose();
    expect(transport.stopDesktopControl).toHaveBeenCalledOnce();
  });

  it('releases the host session once on terminal peer negotiation failures', async () => {
    const rejected = harness([Promise.resolve(success('answer-rejected'))]);
    rejected.adapter.start();
    await settle();
    rejected.peers[0].setRemoteDescription.mockRejectedValueOnce(new Error('invalid answer'));
    rejected.transport.emitSignal({
      kind: 'desktop-signal',
      sessionId: 'answer-rejected',
      signal: { type: 'answer', sdp: 'v=0 invalid' },
    });
    await settle();

    expect(rejected.peers[0].close).toHaveBeenCalledOnce();
    expect(rejected.transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(rejected.transport.stopDesktopControl).toHaveBeenCalledWith(
      'answer-rejected',
      'navigation',
    );
    expect(rejected.adapter.getSnapshot()).toMatchObject({
      phase: 'error',
      detail: { kind: 'negotiation-failed' },
    });
    rejected.adapter.dispose();
    expect(rejected.transport.stopDesktopControl).toHaveBeenCalledOnce();

    const failed = harness([Promise.resolve(success('peer-failed'))]);
    failed.adapter.start();
    await settle();
    failed.peers[0].emitConnectionState('failed');
    expect(failed.peers[0].close).toHaveBeenCalledOnce();
    expect(failed.transport.stopDesktopControl).toHaveBeenCalledOnce();
    expect(failed.transport.stopDesktopControl).toHaveBeenCalledWith(
      'peer-failed',
      'navigation',
    );
    failed.adapter.dispose();
    expect(failed.transport.stopDesktopControl).toHaveBeenCalledOnce();
  });

  it('ignores malformed runtime desktop signals instead of throwing', async () => {
    const { adapter, peers, transport } = harness([Promise.resolve(success('invalid-signal'))]);
    adapter.start();
    await settle();
    const malformed = [
      null,
      { type: 'answer' },
      { type: 'ice', candidate: null },
      { type: 'ice', candidate: { candidate: 42 } },
      { type: 'unexpected', sdp: 'v=0' },
    ];

    for (const signal of malformed) {
      expect(() => transport.emitSignal({
        kind: 'desktop-signal',
        sessionId: 'invalid-signal',
        signal,
      } as unknown as DesktopSignalMessage)).not.toThrow();
    }

    expect(peers[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(peers[0].addIceCandidate).not.toHaveBeenCalled();
    expect(transport.stopDesktopControl).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('rejects malformed, binary, and oversized control messages and validates UTF-8 clipboard text', async () => {
    const { adapter, peers, readText, writeText } = harness([Promise.resolve(success())]);
    adapter.start();
    await settle();
    const control = peers[0].control;

    adapter.copyRemoteClipboard();
    control.emit('{');
    expect(adapter.getSnapshot().clipboardFeedback).toBe('input-unavailable');
    expect(writeText).not.toHaveBeenCalled();

    adapter.copyRemoteClipboard();
    control.emit(new Uint8Array([1, 2, 3]).buffer);
    expect(adapter.getSnapshot().clipboardFeedback).toBe('input-unavailable');
    expect(writeText).not.toHaveBeenCalled();

    adapter.copyRemoteClipboard();
    control.emit(JSON.stringify({ type: 'clipboard-text', text: '😀'.repeat(70_000) }));
    expect(adapter.getSnapshot().clipboardFeedback).toBe('input-unavailable');
    expect(writeText).not.toHaveBeenCalled();

    adapter.copyRemoteClipboard();
    control.emit(JSON.stringify({ type: 'clipboard-text', text: '안녕 👋' }));
    await settle();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('안녕 👋');
    expect(adapter.getSnapshot().clipboardFeedback).toBe('copied');

    readText.mockResolvedValueOnce('x'.repeat(70 * 1024));
    const sentBeforeOversize = control.sent.length;
    await adapter.sendLocalClipboard();
    expect(control.sent).toHaveLength(sentBeforeOversize);
    expect(adapter.getSnapshot().clipboardFeedback).toBe('input-unavailable');

    readText.mockResolvedValueOnce('x'.repeat(MAX_DESKTOP_CLIPBOARD_BYTES + 1));
    await adapter.sendLocalClipboard();
    expect(adapter.getSnapshot().clipboardFeedback).toBe('invalid');
    adapter.dispose();
  });

  it('suppresses clipboard completion and cleans every listener over repeated mount cycles', async () => {
    const pendingWrite = deferred<void>();
    const starts = [
      Promise.resolve(success('mount-1')),
      Promise.resolve(success('mount-2')),
      Promise.resolve(success('mount-3')),
    ];
    const transport = new FakeTransport(starts);

    for (let index = 1; index <= 3; index += 1) {
      const peers: FakePeerConnection[] = [];
      const visibility = new FakeVisibility();
      const adapter = new RemoteDesktopPresentationAdapter(transport, {
        clipboard: {
          readText: async () => 'text',
          writeText: index === 1
            ? async () => pendingWrite.promise
            : async () => undefined,
        },
        visibility: visibility.adapter,
        createPeerConnection: () => {
          const peer = new FakePeerConnection();
          peers.push(peer);
          return peer as unknown as RTCPeerConnection;
        },
      });
      adapter.start();
      await settle();
      if (index === 1) {
        adapter.copyRemoteClipboard();
        peers[0].control.emit(JSON.stringify({ type: 'clipboard-text', text: 'late' }));
      }
      adapter.dispose();
      expect(transport.listenerCount).toBe(0);
      expect(visibility.listenerCount).toBe(0);
    }

    pendingWrite.resolve();
    await settle();
    expect(transport.stopDesktopControl).toHaveBeenCalledTimes(3);
  });
});

describe('decodeDesktopControlFrame', () => {
  it('keeps the inbound interface closed to unknown schemas', () => {
    expect(decodeDesktopControlFrame(JSON.stringify({
      type: 'clipboard-text',
      text: 'valid',
    }))).toEqual({ type: 'clipboard-text', text: 'valid' });
    expect(decodeDesktopControlFrame(JSON.stringify({
      type: 'clipboard-text',
      text: 42,
    }))).toBeNull();
    expect(decodeDesktopControlFrame(JSON.stringify({
      type: 'future-control',
      text: 'ignored',
    }))).toBeNull();
    expect(decodeDesktopControlFrame('{"type":"clipboard-text","text":"\\ud800"}')).toBeNull();
  });
});
