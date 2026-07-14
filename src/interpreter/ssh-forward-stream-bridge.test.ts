import { describe, expect, it, vi } from 'vitest';

import {
  SshForwardError,
  type MainToSshForwardStream,
  type SshForwardStreamToMain,
} from '../shared/ssh-forward';
import type { SshForwardChannelLike } from './external/ssh-client';
import {
  bridgeSshForwardStream,
  rejectSshForwardStream,
  type SshForwardPort,
} from './ssh-forward-stream-bridge';
import type { SshSession } from './ssh-session';

class FakePort implements SshForwardPort {
  readonly posted: SshForwardStreamToMain[] = [];
  closed = false;
  closeCalls = 0;
  private message?: (event: { data: unknown }) => void;
  private closeListener?: () => void;

  postMessage(message: SshForwardStreamToMain): void { this.posted.push(message); }
  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.message = listener as (event: { data: unknown }) => void;
    else this.closeListener = listener as () => void;
  }
  start(): void {}
  close(): void {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.();
  }
  receive(message: MainToSshForwardStream): void { this.message?.({ data: message }); }
}

function fakeForwardChannel() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const writes: Buffer[] = [];
  const calls = { paused: 0, resumed: 0, ended: 0, destroyed: 0 };
  const channel = {
    on(event: string, listener: (...args: never[]) => void): void {
      const values = listeners.get(event) ?? [];
      values.push(listener);
      listeners.set(event, values);
    },
    write(data: Buffer): boolean { writes.push(data); return true; },
    pause(): void { calls.paused += 1; },
    resume(): void { calls.resumed += 1; },
    end(): void { calls.ended += 1; },
    destroy(): void { calls.destroyed += 1; },
  } as SshForwardChannelLike;
  return {
    channel, writes, calls,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args as never[]);
    },
  };
}

function sessionWith(channel: SshForwardChannelLike) {
  const openForward = vi.fn(async () => channel);
  const session: SshSession = {
    connectionId: 'conn-1', ready: true, openForward,
    handlePromptResponse: () => {}, write: () => {}, resize: () => {}, ack: () => {}, dispose: () => {},
  };
  return { session, openForward };
}

describe('bridgeSshForwardStream', () => {
  it('opens direct-tcpip with the selected endpoints and relays both directions with cumulative acks', async () => {
    const forward = fakeForwardChannel();
    const { session, openForward } = sessionWith(forward.channel);
    const port = new FakePort();
    await bridgeSshForwardStream(session, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, port);

    expect(openForward).toHaveBeenCalledWith(
      '127.0.0.1',
      50000,
      'db.internal',
      5432,
      expect.any(AbortSignal),
    );
    expect(port.posted[0]).toEqual({ type: 'ready' });
    port.receive({ type: 'data', data: new TextEncoder().encode('request'), bytes: 7 });
    expect(Buffer.concat(forward.writes).toString('utf8')).toBe('request');
    expect(port.posted).toContainEqual({ type: 'ack', bytes: 7 });

    forward.emit('data', Buffer.from('response'));
    expect(port.posted.at(-1)).toMatchObject({ type: 'data', bytes: 8 });
    port.receive({ type: 'ack', bytes: 8 });
    port.receive({ type: 'end' });
    expect(forward.calls.ended).toBe(1);
  });

  it('fails closed on a non-cumulative or oversized local stream frame', async () => {
    const forward = fakeForwardChannel();
    const { session } = sessionWith(forward.channel);
    const port = new FakePort();
    await bridgeSshForwardStream(session, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, port);
    port.receive({ type: 'data', data: new Uint8Array([1]), bytes: 99 });
    expect(forward.calls.destroyed).toBe(1);
    expect(port.posted.at(-1)).toMatchObject({ type: 'error', error: { code: 'STREAM_OPEN_FAILED' } });
    expect(port.closed).toBe(true);
  });

  it('observes port close before open resolves and destroys a late channel without ready', async () => {
    const forward = fakeForwardChannel();
    let resolveOpen: ((channel: SshForwardChannelLike) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const session: SshSession = {
      connectionId: 'conn-1',
      ready: true,
      openForward: (_sourceHost, _sourcePort, _remoteHost, _remotePort, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => { resolveOpen = resolve; });
      },
      handlePromptResponse: () => {},
      write: () => {},
      resize: () => {},
      ack: () => {},
      dispose: () => {},
    };
    const port = new FakePort();
    const bridging = bridgeSshForwardStream(session, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, port);

    port.close();
    expect(observedSignal?.aborted).toBe(true);
    resolveOpen?.(forward.channel);
    await bridging;

    expect(forward.calls.destroyed).toBe(1);
    expect(port.posted).not.toContainEqual({ type: 'ready' });
  });

  it('contains ready-post failure and closes both sides exactly once', async () => {
    const forward = fakeForwardChannel();
    const { session } = sessionWith(forward.channel);
    const port = new FakePort();
    port.postMessage = vi.fn(() => { throw new Error('port already closed'); });

    await expect(bridgeSshForwardStream(session, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, port)).resolves.toBeUndefined();

    expect(forward.calls.destroyed).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it('contains port listener-registration and start failures before opening SSH', async () => {
    const registration = fakeForwardChannel();
    const { session: registrationSession, openForward: registrationOpen } = sessionWith(registration.channel);
    const registrationPort = new FakePort();
    registrationPort.on = vi.fn(() => { throw new Error('cannot register port listener'); }) as SshForwardPort['on'];

    await expect(bridgeSshForwardStream(registrationSession, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, registrationPort)).resolves.toBeUndefined();
    expect(registrationOpen).not.toHaveBeenCalled();
    expect(registrationPort.closeCalls).toBe(1);

    const starting = fakeForwardChannel();
    const { session: startingSession, openForward: startingOpen } = sessionWith(starting.channel);
    const startingPort = new FakePort();
    startingPort.start = vi.fn(() => { throw new Error('cannot start port'); });

    await expect(bridgeSshForwardStream(startingSession, {
      sourceHost: '127.0.0.1', sourcePort: 50001, remoteHost: 'db.internal', remotePort: 5432,
    }, startingPort)).resolves.toBeUndefined();
    expect(startingOpen).not.toHaveBeenCalled();
    expect(startingPort.closeCalls).toBe(1);
  });

  it('contains port-post and channel-write throws raised inside event callbacks', async () => {
    const outbound = fakeForwardChannel();
    const { session: outboundSession } = sessionWith(outbound.channel);
    const outboundPort = new FakePort();
    await bridgeSshForwardStream(outboundSession, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, outboundPort);
    outboundPort.postMessage = vi.fn(() => { throw new Error('main port closed'); });

    expect(() => outbound.emit('data', Buffer.from('response'))).not.toThrow();
    expect(outbound.calls.destroyed).toBe(1);
    expect(outboundPort.closed).toBe(true);

    const inbound = fakeForwardChannel();
    inbound.channel.write = vi.fn(() => { throw new Error('channel closed'); });
    const { session: inboundSession } = sessionWith(inbound.channel);
    const inboundPort = new FakePort();
    await bridgeSshForwardStream(inboundSession, {
      sourceHost: '127.0.0.1', sourcePort: 50001, remoteHost: 'db.internal', remotePort: 5432,
    }, inboundPort);

    expect(() => inboundPort.receive({
      type: 'data', data: new Uint8Array([1]), bytes: 1,
    })).not.toThrow();
    expect(inbound.calls.destroyed).toBe(1);
    expect(inboundPort.closed).toBe(true);
  });

  it('contains channel event-registration and late-destroy throws', async () => {
    const registration = fakeForwardChannel();
    registration.channel.on = vi.fn(() => { throw new Error('cannot register listener'); });
    const { session: registrationSession } = sessionWith(registration.channel);
    const registrationPort = new FakePort();

    await expect(bridgeSshForwardStream(registrationSession, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, registrationPort)).resolves.toBeUndefined();
    expect(registration.calls.destroyed).toBe(1);
    expect(registrationPort.closed).toBe(true);

    const late = fakeForwardChannel();
    late.channel.destroy = vi.fn(() => {
      late.calls.destroyed += 1;
      throw new Error('already destroyed');
    });
    let resolveOpen: ((channel: SshForwardChannelLike) => void) | undefined;
    const lateSession = sessionWith(late.channel).session;
    lateSession.openForward = () => new Promise((resolve) => { resolveOpen = resolve; });
    const latePort = new FakePort();
    const bridging = bridgeSshForwardStream(lateSession, {
      sourceHost: '127.0.0.1', sourcePort: 50002, remoteHost: 'db.internal', remotePort: 5432,
    }, latePort);

    latePort.close();
    resolveOpen?.(late.channel);
    await expect(bridging).resolves.toBeUndefined();
    expect(late.calls.destroyed).toBe(1);
  });

  it('contains channel pause, resume, and end throws from event callbacks', async () => {
    const pausing = fakeForwardChannel();
    pausing.channel.pause = vi.fn(() => { throw new Error('pause failed'); });
    const { session: pausingSession } = sessionWith(pausing.channel);
    const pausingPort = new FakePort();
    await bridgeSshForwardStream(pausingSession, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, pausingPort);
    expect(() => pausing.emit('data', Buffer.alloc(1024 * 1024 + 1))).not.toThrow();
    expect(pausing.calls.destroyed).toBe(1);

    const resuming = fakeForwardChannel();
    const { session: resumingSession } = sessionWith(resuming.channel);
    const resumingPort = new FakePort();
    await bridgeSshForwardStream(resumingSession, {
      sourceHost: '127.0.0.1', sourcePort: 50001, remoteHost: 'db.internal', remotePort: 5432,
    }, resumingPort);
    resuming.emit('data', Buffer.alloc(1024 * 1024 + 1));
    resuming.channel.resume = vi.fn(() => { throw new Error('resume failed'); });
    expect(() => resumingPort.receive({ type: 'ack', bytes: 1024 * 1024 + 1 })).not.toThrow();
    expect(resuming.calls.destroyed).toBe(1);

    const ending = fakeForwardChannel();
    ending.channel.end = vi.fn(() => { throw new Error('end failed'); });
    const { session: endingSession } = sessionWith(ending.channel);
    const endingPort = new FakePort();
    await bridgeSshForwardStream(endingSession, {
      sourceHost: '127.0.0.1', sourcePort: 50002, remoteHost: 'db.internal', remotePort: 5432,
    }, endingPort);
    expect(() => endingPort.receive({ type: 'end' })).not.toThrow();
    expect(ending.calls.destroyed).toBe(1);
  });

  it('keeps cleanup idempotent when failure, close, and error events race', async () => {
    const forward = fakeForwardChannel();
    const { session } = sessionWith(forward.channel);
    const port = new FakePort();
    await bridgeSshForwardStream(session, {
      sourceHost: '127.0.0.1', sourcePort: 50000, remoteHost: 'db.internal', remotePort: 5432,
    }, port);
    port.postMessage = vi.fn(() => { throw new Error('port closed'); });

    expect(() => forward.emit('error', new Error('channel failed'))).not.toThrow();
    expect(() => forward.emit('close')).not.toThrow();
    expect(() => forward.emit('drain')).not.toThrow();
    expect(forward.calls.destroyed).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it('never lets failure reporting or port close throw to the interpreter event loop', () => {
    const port = new FakePort();
    port.postMessage = vi.fn(() => { throw new Error('post failed'); });
    port.close = vi.fn(() => { throw new Error('close failed'); });

    expect(() => rejectSshForwardStream(
      port,
      new SshForwardError('CONNECTION_NOT_FOUND', 'missing connection'),
    )).not.toThrow();
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
  });
});
