import { connect } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InterpreterToMain, MainToInterpreter } from '../shared/ipc';
import {
  SSH_FORWARD_BIND_HOST,
  type MainToSshForwardStream,
  type SshForwardStreamToMain,
} from '../shared/ssh-forward';
import type { RemoteInterpreter, RemoteMessageChannel, RemotePort } from './interpreter-broker';
import { SshForwardService } from './ssh-forward-service';

class FakePort implements RemotePort {
  peer: FakePort | null = null;
  throwOnPost = false;
  private started = false;
  private closed = false;
  private readonly queued: unknown[] = [];
  private readonly messages: Array<(event: { data: unknown }) => void> = [];
  private readonly closes: Array<() => void> = [];

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error('port unavailable');
    if (!this.closed) this.peer?.deliver(message);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)): void {
    if (event === 'message') this.messages.push(listener as (event: { data: unknown }) => void);
    else this.closes.push(listener as () => void);
  }

  start(): void {
    this.started = true;
    for (const message of this.queued.splice(0)) this.deliver(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
    this.peer?.peerClosed();
  }

  private deliver(message: unknown): void {
    if (this.closed) return;
    if (!this.started) this.queued.push(message);
    else for (const listener of this.messages) listener({ data: message });
  }

  private peerClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
  }
}

function channel(): RemoteMessageChannel {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

class FakeInterpreter implements RemoteInterpreter {
  readonly posted: Array<{ message: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  onPost?: (message: MainToInterpreter, transfer?: readonly RemotePort[]) => void;
  private readonly listeners = new Set<(message: InterpreterToMain) => void>();

  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    this.posted.push({ message, transfer });
    this.onPost?.(message, transfer);
  }

  on(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.delete(listener);
  }

  emit(message: InterpreterToMain): void {
    for (const listener of this.listeners) listener(message);
  }
}

const services: SshForwardService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

function makeService(interpreter = new FakeInterpreter()): { service: SshForwardService; interpreter: FakeInterpreter } {
  let id = 0;
  const service = new SshForwardService({
    interpreter,
    createMessageChannel: channel,
    newId: () => `id-${++id}`,
  });
  services.push(service);
  return { service, interpreter };
}

function expectConnectFailure(host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      rejectPromise(new Error(`unexpectedly connected to ${host}:${port}`));
    });
    socket.once('error', () => resolvePromise());
  });
}

function connectUntilClosed(port: number, data?: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: SSH_FORWARD_BIND_HOST, port }, () => {
      if (data) socket.write(data);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error('forwarded socket did not close'));
    }, 5_000);
    const finish = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    socket.once('error', finish);
    socket.once('close', finish);
  });
}

describe('SshForwardService', () => {
  it('starts/lists/stops only for an explicit live connection and binds exactly IPv4 loopback', async () => {
    const { service } = makeService();
    service.markConnectionReady('conn-1');
    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    });

    expect(info).toMatchObject({ connectionId: 'conn-1', bindHost: '127.0.0.1', remoteHost: 'db.internal', state: 'listening' });
    expect(info.localPort).toBeGreaterThan(0);
    expect(service.list('conn-1')).toEqual([info]);
    expect(service.listAll()).toEqual([info]);
    await expect(service.stop('conn-other', info.forwardId)).rejects.toMatchObject({ code: 'FORWARD_NOT_OWNED' });
    await expect(service.start({
      connectionId: 'conn-1', remoteHost: 'other.internal', remotePort: 443, localPort: info.localPort,
    })).rejects.toMatchObject({ code: 'BIND_FAILED' });
    await expect(expectConnectFailure('::1', info.localPort)).resolves.toBeUndefined();

    await service.stop('conn-1', info.forwardId);
    expect(service.list('conn-1')).toEqual([]);
    expect(service.listAll()).toEqual([]);
    await expect(expectConnectFailure('127.0.0.1', info.localPort)).resolves.toBeUndefined();
  });

  it('relays bytes through a dedicated stream port and preserves the selected remote destination', async () => {
    const interpreter = new FakeInterpreter();
    const { service } = makeService(interpreter);
    service.markConnectionReady('conn-1');
    let opened: Extract<MainToInterpreter, { type: 'ssh-forward-stream-open' }> | undefined;
    interpreter.onPost = (message, transfer) => {
      if (message.type !== 'ssh-forward-stream-open') return;
      opened = message;
      const port = transfer?.[0] as FakePort;
      let toMain = 0;
      port.on('message', (event) => {
        const frame = event.data as MainToSshForwardStream;
        if (frame.type !== 'data') return;
        port.postMessage({ type: 'ack', bytes: frame.bytes } satisfies SshForwardStreamToMain);
        toMain += frame.data.byteLength;
        port.postMessage({ type: 'data', data: frame.data, bytes: toMain } satisfies SshForwardStreamToMain);
      });
      port.start();
      port.postMessage({ type: 'ready' } satisfies SshForwardStreamToMain);
    };

    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'echo.internal', remotePort: 7000, localPort: 0,
    });
    const echoed = await new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = connect({ host: '127.0.0.1', port: info.localPort }, () => socket.write('hello'));
      socket.once('data', (data) => {
        resolvePromise(data.toString('utf8'));
        socket.destroy();
      });
      socket.once('error', rejectPromise);
    });
    expect(echoed).toBe('hello');
    expect(opened).toMatchObject({
      connectionId: 'conn-1', sourceHost: '127.0.0.1', remoteHost: 'echo.internal', remotePort: 7000,
    });
    await service.stop('conn-1', info.forwardId);
  });

  it('preserves TCP half-close so a response after local FIN arrives before remote end', async () => {
    const interpreter = new FakeInterpreter();
    const { service } = makeService(interpreter);
    service.markConnectionReady('conn-1');
    let remoteSawEnd = false;
    interpreter.onPost = (message, transfer) => {
      if (message.type !== 'ssh-forward-stream-open') return;
      const port = transfer?.[0] as FakePort;
      let received = '';
      let sentToMain = 0;
      port.on('message', (event) => {
        const frame = event.data as MainToSshForwardStream;
        if (frame.type === 'data') {
          received += Buffer.from(frame.data).toString('utf8');
          port.postMessage({ type: 'ack', bytes: frame.bytes } satisfies SshForwardStreamToMain);
          return;
        }
        if (frame.type !== 'end') return;
        remoteSawEnd = true;
        setTimeout(() => {
          const response = Buffer.from(`response:${received}`);
          sentToMain += response.byteLength;
          port.postMessage({
            type: 'data',
            data: new Uint8Array(response),
            bytes: sentToMain,
          } satisfies SshForwardStreamToMain);
          port.postMessage({ type: 'end' } satisfies SshForwardStreamToMain);
        }, 20);
      });
      port.start();
      port.postMessage({ type: 'ready' } satisfies SshForwardStreamToMain);
    };

    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'delayed.internal', remotePort: 7001, localPort: 0,
    });
    const response = await new Promise<string>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      const socket = connect({ host: '127.0.0.1', port: info.localPort }, () => socket.end('request'));
      socket.on('data', (data) => chunks.push(data));
      socket.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
      socket.once('error', rejectPromise);
    });

    expect(remoteSawEnd).toBe(true);
    expect(response).toBe('response:request');
    await service.stop('conn-1', info.forwardId);
  });

  it('keeps the listener open when a normal remote end is immediately followed by stream-port close', async () => {
    const interpreter = new FakeInterpreter();
    const { service } = makeService(interpreter);
    service.markConnectionReady('conn-1');
    let openedStreams = 0;
    let resolveFirstPortClosed: (() => void) | undefined;
    const firstPortClosed = new Promise<void>((resolvePromise) => {
      resolveFirstPortClosed = resolvePromise;
    });
    interpreter.onPost = (message, transfer) => {
      if (message.type !== 'ssh-forward-stream-open') return;
      openedStreams += 1;
      const port = transfer?.[0] as FakePort;
      port.start();
      port.postMessage({ type: 'ready' } satisfies SshForwardStreamToMain);
      if (openedStreams === 1) {
        // The real interpreter bridge closes its MessagePort as part of channel
        // cleanup. That close can reach main before socket.end() emits `close`.
        port.postMessage({ type: 'end' } satisfies SshForwardStreamToMain);
        port.close();
        resolveFirstPortClosed?.();
      }
    };

    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'sequential.internal', remotePort: 7002, localPort: 0,
    });
    const firstSocket = connect({ host: SSH_FORWARD_BIND_HOST, port: info.localPort });
    firstSocket.on('error', () => undefined);
    await firstPortClosed;

    const secondSocket = await new Promise<ReturnType<typeof connect>>((resolvePromise, rejectPromise) => {
      const socket = connect({ host: SSH_FORWARD_BIND_HOST, port: info.localPort });
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error('forward listener did not accept a second connection'));
      }, 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolvePromise(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });

    await vi.waitFor(() => expect(openedStreams).toBe(2));
    expect(service.listAll()).toEqual([info]);
    firstSocket.destroy();
    secondSocket.destroy();
    await service.stop('conn-1', info.forwardId);
  });

  it('stops the listener when a stream port closes without a remote end', async () => {
    const interpreter = new FakeInterpreter();
    const { service } = makeService(interpreter);
    service.markConnectionReady('conn-1');
    interpreter.onPost = (message, transfer) => {
      if (message.type !== 'ssh-forward-stream-open') return;
      const port = transfer?.[0] as FakePort;
      port.start();
      port.postMessage({ type: 'ready' } satisfies SshForwardStreamToMain);
      port.close();
    };

    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'abrupt.internal', remotePort: 7003, localPort: 0,
    });

    await expect(connectUntilClosed(info.localPort)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(service.listAll()).toEqual([]));
    await expect(expectConnectFailure(SSH_FORWARD_BIND_HOST, info.localPort)).resolves.toBeUndefined();
  });

  it('closes listeners and active sockets as soon as the owning SSH connection closes', async () => {
    const { service } = makeService();
    service.markConnectionReady('conn-1');
    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    });
    await service.markConnectionClosed('conn-1');

    await expect(expectConnectFailure('127.0.0.1', info.localPort)).resolves.toBeUndefined();
    expect(() => service.list('conn-1')).toThrow(expect.objectContaining({ code: 'CONNECTION_CLOSED' }));
    await expect(service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    })).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
  });

  it('closes the listener and socket when stream channel creation throws', async () => {
    const interpreter = new FakeInterpreter();
    const service = new SshForwardService({
      interpreter,
      createMessageChannel: () => {
        throw new Error('interpreter exited during channel creation');
      },
      newId: () => 'channel-failure',
    });
    services.push(service);
    service.markConnectionReady('conn-1');
    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    });

    await expect(connectUntilClosed(info.localPort)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(service.listAll()).toEqual([]));
    await expect(expectConnectFailure(SSH_FORWARD_BIND_HOST, info.localPort)).resolves.toBeUndefined();
  });

  it('closes the listener, socket, and channel when interpreter stream-open post throws', async () => {
    const interpreter = new FakeInterpreter();
    let mainPort: FakePort | null = null;
    const service = new SshForwardService({
      interpreter,
      createMessageChannel: () => {
        const created = channel() as { port1: FakePort; port2: FakePort };
        mainPort = created.port1;
        return created;
      },
      newId: () => 'post-failure',
    });
    services.push(service);
    interpreter.onPost = (message) => {
      if (message.type === 'ssh-forward-stream-open') throw new Error('interpreter exited');
    };
    service.markConnectionReady('conn-1');
    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    });

    await expect(connectUntilClosed(info.localPort)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(service.listAll()).toEqual([]));
    expect((mainPort as FakePort | null)?.isClosed).toBe(true);
    await expect(expectConnectFailure(SSH_FORWARD_BIND_HOST, info.localPort)).resolves.toBeUndefined();
  });

  it('contains a stream-port post throw inside the socket event and closes all resources', async () => {
    const interpreter = new FakeInterpreter();
    let mainPort: FakePort | null = null;
    const service = new SshForwardService({
      interpreter,
      createMessageChannel: () => {
        const created = channel() as { port1: FakePort; port2: FakePort };
        mainPort = created.port1;
        created.port1.throwOnPost = true;
        return created;
      },
      newId: () => 'port-failure',
    });
    services.push(service);
    interpreter.onPost = (message, transfer) => {
      if (message.type !== 'ssh-forward-stream-open') return;
      const remotePort = transfer?.[0] as FakePort;
      remotePort.start();
      remotePort.postMessage({ type: 'ready' } satisfies SshForwardStreamToMain);
    };
    service.markConnectionReady('conn-1');
    const info = await service.start({
      connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    });

    await expect(connectUntilClosed(info.localPort, 'trigger')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(service.listAll()).toEqual([]));
    expect((mainPort as FakePort | null)?.isClosed).toBe(true);
    await expect(expectConnectFailure(SSH_FORWARD_BIND_HOST, info.localPort)).resolves.toBeUndefined();
  });

  it('serves start/list/stop RPC with stable results and no credential fields', async () => {
    const { service, interpreter } = makeService();
    interpreter.emit({ type: 'ssh-connection-state', connectionId: 'conn-1', state: 'ready' });
    interpreter.emit({
      type: 'ssh-forward-request', requestId: 'req-1',
      request: { action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0 },
      origin: 'desktop',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const response = interpreter.posted.find(({ message }) => message.type === 'ssh-forward-response')?.message;
    expect(response).toMatchObject({ type: 'ssh-forward-response', requestId: 'req-1', result: { ok: true } });
    expect(JSON.stringify(response)).not.toMatch(/password|passphrase|privateKey|token/i);

    const forward = response?.type === 'ssh-forward-response' && response.result.ok
      ? response.result.forwards[0]
      : undefined;
    expect(forward).toBeDefined();
    if (forward) await service.stop('conn-1', forward.forwardId);
  });

  it('allows mobile inspection but rejects mobile listener mutations in main', async () => {
    const { service, interpreter } = makeService();
    interpreter.emit({ type: 'ssh-connection-state', connectionId: 'conn-1', state: 'ready' });
    interpreter.emit({
      type: 'ssh-forward-request', requestId: 'mobile-list',
      request: { action: 'list', connectionId: 'conn-1' },
      origin: 'mobile',
    });
    interpreter.emit({
      type: 'ssh-forward-request', requestId: 'mobile-start',
      request: { action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0 },
      origin: 'mobile',
    });
    interpreter.emit({
      type: 'ssh-forward-request', requestId: 'missing-origin',
      request: { action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0 },
    } as InterpreterToMain);
    await new Promise((resolve) => setImmediate(resolve));

    const responses = interpreter.posted
      .map(({ message }) => message)
      .filter((message) => message.type === 'ssh-forward-response');
    expect(responses.find((message) => message.requestId === 'mobile-list')?.result).toEqual({
      ok: true,
      forwards: [],
    });
    expect(responses.find((message) => message.requestId === 'mobile-start')?.result).toMatchObject({
      ok: false,
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });
    expect(responses.find((message) => message.requestId === 'missing-origin')?.result).toMatchObject({
      ok: false,
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });
    expect(service.listAll()).toEqual([]);
  });

  it('returns stable validation and missing-connection errors before binding', async () => {
    const { service } = makeService();
    await expect(service.start({
      connectionId: 'missing', remoteHost: 'db.internal', remotePort: 5432, localPort: 0,
    })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    service.markConnectionReady('conn-1');
    await expect(service.start({
      connectionId: 'conn-1', remoteHost: 'bad host', remotePort: 5432, localPort: 0,
    })).rejects.toMatchObject({ code: 'INVALID_REMOTE_HOST' });
  });
});
