/** Main-owned, loopback-only SSH local forwarding service. */

import { randomUUID } from 'node:crypto';
import { createServer as nodeCreateServer, type Server, type Socket } from 'node:net';

import type { InterpreterToMain, MainToInterpreter } from '../shared/ipc';
import {
  SSH_FORWARD_BIND_HOST,
  SSH_FORWARD_MAX_GLOBAL,
  SSH_FORWARD_MAX_PER_CONNECTION,
  SSH_FORWARD_MAX_STREAMS_GLOBAL,
  SSH_FORWARD_STREAM_HIGH_WATER,
  SSH_FORWARD_STREAM_LOW_WATER,
  SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS,
  SshForwardError,
  sshForwardFailure,
  validateSshForwardAction,
  type MainToSshForwardStream,
  type SshForwardAction,
  type SshForwardInfo,
  type SshForwardResult,
  type SshForwardStartInput,
  type SshForwardStreamToMain,
} from '../shared/ssh-forward';
import type { RemoteInterpreter, RemoteMessageChannel } from './interpreter-broker';

const MAX_STREAM_CHUNK_BYTES = 256 * 1024;

interface ForwardRecord {
  readonly info: SshForwardInfo;
  readonly server: Server;
  readonly sockets: Set<Socket>;
  closing?: Promise<void>;
}

interface PendingRequest {
  readonly request: SshForwardAction;
  readonly controller: AbortController;
}

export interface SshForwardServiceDeps {
  readonly interpreter: RemoteInterpreter;
  readonly createMessageChannel: () => RemoteMessageChannel;
  readonly createServer?: typeof nodeCreateServer;
  readonly newId?: () => string;
  /** Broker exit hook; supplying it makes interpreter death close every
   * listener even when no final state notification can arrive. */
  readonly onInterpreterExited?: (listener: () => void) => () => void;
}

function bindFailure(error: unknown, port: number): SshForwardError {
  const code = (error as NodeJS.ErrnoException)?.code;
  const suffix = code ? ` (${code})` : '';
  return new SshForwardError('BIND_FAILED', `Could not bind ${SSH_FORWARD_BIND_HOST}:${port}${suffix}`);
}

function closeServerQuietly(server: Server): void {
  try {
    server.close();
  } catch {
    // Never reached listening state, or already closed.
  }
}

function destroySocketQuietly(socket: Socket): void {
  try {
    socket.destroy();
  } catch {
    // Already destroyed or no longer backed by a native handle.
  }
}

export class SshForwardService {
  private readonly interpreter: RemoteInterpreter;
  private readonly createMessageChannel: () => RemoteMessageChannel;
  private readonly createServer: typeof nodeCreateServer;
  private readonly newId: () => string;
  private readonly readyConnections = new Set<string>();
  private readonly closedConnections = new Set<string>();
  private readonly forwards = new Map<string, ForwardRecord>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeStreams = new Set<string>();
  private readonly pendingStartsByConnection = new Map<string, number>();
  private pendingStarts = 0;
  private readonly unsubscribeExit?: () => void;
  private disposed = false;

  private readonly onInterpreterMessage = (message: InterpreterToMain): void => {
    if (message.type === 'ssh-connection-state') {
      if (message.state === 'ready') this.markConnectionReady(message.connectionId);
      else void this.markConnectionClosed(message.connectionId);
      return;
    }
    if (message.type === 'ssh-forward-request') {
      // Treat every absent/unknown runtime value as the less-privileged mobile
      // origin. Only the broker-authored literal `desktop` may mutate listeners.
      const origin = message.origin === 'desktop' ? 'desktop' : 'mobile';
      this.handleRequestMessage(message.requestId, message.request, origin);
      return;
    }
    if (message.type === 'ssh-forward-request-cancel') {
      this.pendingRequests.get(message.requestId)?.controller.abort();
    }
  };

  constructor(deps: SshForwardServiceDeps) {
    this.interpreter = deps.interpreter;
    this.createMessageChannel = deps.createMessageChannel;
    this.createServer = deps.createServer ?? nodeCreateServer;
    this.newId = deps.newId ?? randomUUID;
    this.interpreter.on('message', this.onInterpreterMessage);
    this.unsubscribeExit = deps.onInterpreterExited?.(() => { void this.dispose(); });
  }

  markConnectionReady(connectionId: string): void {
    if (this.disposed || this.closedConnections.has(connectionId)) return;
    this.readyConnections.add(connectionId);
  }

  async markConnectionClosed(connectionId: string): Promise<void> {
    this.readyConnections.delete(connectionId);
    this.closedConnections.add(connectionId);
    for (const pending of this.pendingRequests.values()) {
      if (pending.request.connectionId === connectionId) pending.controller.abort();
    }
    const owned = [...this.forwards.values()].filter((record) => record.info.connectionId === connectionId);
    await Promise.all(owned.map((record) => this.stopRecord(record)));
  }

  async start(input: SshForwardStartInput, signal?: AbortSignal): Promise<SshForwardInfo> {
    validateSshForwardAction({ action: 'start', ...input });
    this.ensureUsableConnection(input.connectionId);
    if (this.forwards.size + this.pendingStarts >= SSH_FORWARD_MAX_GLOBAL
      || this.countForConnection(input.connectionId) + (this.pendingStartsByConnection.get(input.connectionId) ?? 0)
        >= SSH_FORWARD_MAX_PER_CONNECTION) {
      throw new SshForwardError('FORWARD_LIMIT_REACHED', 'SSH forward limit reached');
    }
    if (signal?.aborted) throw new SshForwardError('CANCELLED', 'SSH forward request was cancelled');
    this.pendingStarts += 1;
    this.pendingStartsByConnection.set(
      input.connectionId,
      (this.pendingStartsByConnection.get(input.connectionId) ?? 0) + 1,
    );

    try {
    const forwardId = this.newId();
    const sockets = new Set<Socket>();
    let record: ForwardRecord | null = null;
    // A TCP forward must preserve half-close semantics. A local client may
    // finish its request with FIN and still expect a response; Node's default
    // `allowHalfOpen:false` would automatically close this socket's writable
    // side on that FIN, making a later SSH response fail with EPIPE.
    const server = this.createServer({ allowHalfOpen: true }, (socket) => {
      if (!record) {
        destroySocketQuietly(socket);
        return;
      }
      try {
        this.acceptSocket(record, socket);
      } catch {
        // A net.Server connection callback must never leak a setup race into
        // Electron's event loop.
        destroySocketQuietly(socket);
        void this.stopRecord(record).catch(() => undefined);
      }
    });

    const localPort = await new Promise<number>((resolvePromise, rejectPromise) => {
      let done = false;
      const finish = (action: () => void): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        server.off('error', onError);
        action();
      };
      const onError = (error: Error): void => finish(() => rejectPromise(bindFailure(error, input.localPort)));
      const onAbort = (): void => finish(() => {
        closeServerQuietly(server);
        rejectPromise(new SshForwardError('CANCELLED', 'SSH forward request was cancelled'));
      });
      server.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      server.listen({ host: SSH_FORWARD_BIND_HOST, port: input.localPort, exclusive: true }, () => finish(() => {
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== SSH_FORWARD_BIND_HOST) {
          closeServerQuietly(server);
          rejectPromise(new SshForwardError('BIND_FAILED', 'SSH forward listener did not bind the required loopback address'));
          return;
        }
        resolvePromise(address.port);
      }));
    });

    if (signal?.aborted) {
      closeServerQuietly(server);
      throw new SshForwardError('CANCELLED', 'SSH forward request was cancelled');
    }
    if (!this.readyConnections.has(input.connectionId)) {
      closeServerQuietly(server);
      throw new SshForwardError('CONNECTION_CLOSED', `SSH connection ${input.connectionId} closed before forwarding started`);
    }

    const info: SshForwardInfo = {
      forwardId,
      connectionId: input.connectionId,
      bindHost: SSH_FORWARD_BIND_HOST,
      localPort,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      state: 'listening',
    };
    record = { info, server, sockets };
    this.forwards.set(forwardId, record);
    server.on('error', () => { void this.stopRecord(record as ForwardRecord); });
    return info;
    } finally {
      this.pendingStarts -= 1;
      const remaining = (this.pendingStartsByConnection.get(input.connectionId) ?? 1) - 1;
      if (remaining <= 0) this.pendingStartsByConnection.delete(input.connectionId);
      else this.pendingStartsByConnection.set(input.connectionId, remaining);
    }
  }

  list(connectionId: string): SshForwardInfo[] {
    validateSshForwardAction({ action: 'list', connectionId });
    this.ensureUsableConnection(connectionId);
    return [...this.forwards.values()]
      .filter((record) => record.info.connectionId === connectionId)
      .map((record) => record.info)
      .sort((a, b) => a.localPort - b.localPort || a.forwardId.localeCompare(b.forwardId));
  }

  /** Desktop settings summary. This intentionally returns only the bounded,
   * non-secret listener metadata already shown by the terminal list command. */
  listAll(): SshForwardInfo[] {
    if (this.disposed) return [];
    return [...this.forwards.values()]
      .map((record) => record.info)
      .sort((a, b) => a.connectionId.localeCompare(b.connectionId)
        || a.localPort - b.localPort
        || a.forwardId.localeCompare(b.forwardId));
  }

  async stop(connectionId: string, forwardId: string): Promise<SshForwardInfo> {
    validateSshForwardAction({ action: 'stop', connectionId, forwardId });
    const record = this.forwards.get(forwardId);
    if (!record) throw new SshForwardError('FORWARD_NOT_FOUND', `SSH forward ${forwardId} does not exist`);
    if (record.info.connectionId !== connectionId) {
      throw new SshForwardError('FORWARD_NOT_OWNED', `SSH forward ${forwardId} does not belong to connection ${connectionId}`);
    }
    await this.stopRecord(record);
    return record.info;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.interpreter.off('message', this.onInterpreterMessage);
    this.unsubscribeExit?.();
    for (const pending of this.pendingRequests.values()) pending.controller.abort();
    this.pendingRequests.clear();
    await Promise.all([...this.forwards.values()].map((record) => this.stopRecord(record)));
    this.readyConnections.clear();
  }

  private ensureUsableConnection(connectionId: string): void {
    if (this.disposed) throw new SshForwardError('INTERPRETER_UNAVAILABLE', 'SSH forwarding service is unavailable');
    if (this.closedConnections.has(connectionId)) {
      throw new SshForwardError('CONNECTION_CLOSED', `SSH connection ${connectionId} is closed`);
    }
    if (!this.readyConnections.has(connectionId)) {
      throw new SshForwardError('CONNECTION_NOT_FOUND', `SSH connection ${connectionId} is not active`);
    }
  }

  private countForConnection(connectionId: string): number {
    let count = 0;
    for (const record of this.forwards.values()) if (record.info.connectionId === connectionId) count += 1;
    return count;
  }

  private handleRequestMessage(
    requestId: string,
    request: SshForwardAction,
    origin: 'desktop' | 'mobile',
  ): void {
    if (this.pendingRequests.has(requestId)) {
      this.postResult(requestId, sshForwardFailure(new SshForwardError('INTERNAL', 'duplicate SSH forward request id')));
      return;
    }
    const controller = new AbortController();
    this.pendingRequests.set(requestId, { request, controller });
    void this.execute(request, controller.signal, origin).then(
      (result) => this.postResult(requestId, result),
      (error) => this.postResult(requestId, sshForwardFailure(error)),
    ).finally(() => {
      this.pendingRequests.delete(requestId);
    });
  }

  private async execute(
    request: SshForwardAction,
    signal: AbortSignal,
    origin: 'desktop' | 'mobile',
  ): Promise<SshForwardResult> {
    validateSshForwardAction(request);
    if (origin === 'mobile' && request.action !== 'list') {
      throw new SshForwardError(
        'ORIGIN_NOT_ALLOWED',
        'Mobile clients may list SSH forwards but cannot start or stop listeners',
      );
    }
    if (request.action === 'start') {
      return { ok: true, forwards: [await this.start(request, signal)] };
    }
    if (request.action === 'list') return { ok: true, forwards: this.list(request.connectionId) };
    return { ok: true, forwards: [await this.stop(request.connectionId, request.forwardId)] };
  }

  private postResult(requestId: string, result: SshForwardResult): void {
    if (this.disposed || (this.pendingRequests.get(requestId)?.controller.signal.aborted && result.ok)) return;
    try {
      this.interpreter.postMessage({ type: 'ssh-forward-response', requestId, result } satisfies MainToInterpreter);
    } catch {
      // A response racing interpreter exit is undeliverable. Tear down every
      // listener instead of surfacing an unhandled rejection from the RPC
      // continuation.
      void this.dispose().catch(() => undefined);
    }
  }

  private async stopRecord(record: ForwardRecord): Promise<void> {
    if (record.closing) return record.closing;
    this.forwards.delete(record.info.forwardId);
    record.closing = (async (): Promise<void> => {
      for (const socket of record.sockets) destroySocketQuietly(socket);
      record.sockets.clear();
      await new Promise<void>((resolvePromise) => {
        if (!record.server.listening) {
          resolvePromise();
          return;
        }
        record.server.close(() => resolvePromise());
      });
    })();
    return record.closing;
  }

  private acceptSocket(record: ForwardRecord, socket: Socket): void {
    if (this.disposed || !this.readyConnections.has(record.info.connectionId)) {
      destroySocketQuietly(socket);
      return;
    }
    if (this.activeStreams.size >= SSH_FORWARD_MAX_STREAMS_GLOBAL) {
      destroySocketQuietly(socket);
      return;
    }
    const sourcePort = socket.remotePort;
    if (!sourcePort || socket.remoteAddress !== SSH_FORWARD_BIND_HOST) {
      destroySocketQuietly(socket);
      return;
    }

    const streamId = this.newId();
    let channel: RemoteMessageChannel;
    try {
      channel = this.createMessageChannel();
    } catch {
      destroySocketQuietly(socket);
      void this.stopRecord(record).catch(() => undefined);
      return;
    }
    const { port1, port2 } = channel;
    record.sockets.add(socket);
    this.activeStreams.add(streamId);

    let closed = false;
    let ready = false;
    let remoteEnded = false;
    let streamPortClosed = false;
    let sentToInterpreter = 0;
    let ackedByInterpreter = 0;
    let receivedFromInterpreter = 0;
    let socketPaused = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (destroySocket: boolean): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      record.sockets.delete(socket);
      this.activeStreams.delete(streamId);
      if (destroySocket) destroySocketQuietly(socket);
      try {
        port1.close();
      } catch {
        // Already closed.
      }
      try {
        port2.close();
      } catch {
        // Already transferred or closed by its peer.
      }
    };

    const failStream = (): void => {
      const wasOpen = !closed;
      cleanup(true);
      if (wasOpen) void this.stopRecord(record).catch(() => undefined);
    };
    const postToInterpreter = (message: MainToSshForwardStream): boolean => {
      try {
        port1.postMessage(message);
        return true;
      } catch {
        failStream();
        return false;
      }
    };

    try {
      socket.pause();
      timer = setTimeout(() => {
        if (!ready) failStream();
      }, SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS);

      socket.on('data', (chunk: Buffer) => {
        if (closed || !ready) return;
        if (streamPortClosed) {
          cleanup(true);
          return;
        }
        try {
          const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          sentToInterpreter += data.byteLength;
          if (!postToInterpreter({ type: 'data', data, bytes: sentToInterpreter })) return;
          if (!socketPaused && sentToInterpreter - ackedByInterpreter > SSH_FORWARD_STREAM_HIGH_WATER) {
            socketPaused = true;
            socket.pause();
          }
        } catch {
          failStream();
        }
      });
      socket.on('end', () => {
        if (!closed && !streamPortClosed) postToInterpreter({ type: 'end' });
      });
      socket.on('error', () => cleanup(true));
      socket.on('close', () => cleanup(false));

      port1.on('message', (event) => {
        if (closed) return;
        try {
          const message = event.data as SshForwardStreamToMain;
          if (message?.type === 'ready') {
            if (ready) return;
            ready = true;
            if (timer) clearTimeout(timer);
            socketPaused = false;
            socket.resume();
            return;
          }
          if (message?.type === 'data') {
            if (!(message.data instanceof Uint8Array)
              || message.data.byteLength > MAX_STREAM_CHUNK_BYTES
              || message.bytes !== receivedFromInterpreter + message.data.byteLength) {
              cleanup(true);
              return;
            }
            receivedFromInterpreter = message.bytes;
            const ackBytes = receivedFromInterpreter;
            socket.write(Buffer.from(message.data), () => {
              if (!closed && !streamPortClosed) postToInterpreter({ type: 'ack', bytes: ackBytes });
            });
            return;
          }
          if (message?.type === 'ack') {
            if (!Number.isFinite(message.bytes) || message.bytes < ackedByInterpreter) return;
            ackedByInterpreter = Math.min(message.bytes, sentToInterpreter);
            if (socketPaused && ready && sentToInterpreter - ackedByInterpreter <= SSH_FORWARD_STREAM_LOW_WATER) {
              socketPaused = false;
              socket.resume();
            }
            return;
          }
          if (message?.type === 'end') {
            if (remoteEnded) return;
            remoteEnded = true;
            socket.end();
            return;
          }
          if (message?.type === 'error') cleanup(true);
        } catch {
          failStream();
        }
      });
      port1.on('close', () => {
        if (closed) return;
        streamPortClosed = true;
        if (!remoteEnded) {
          failStream();
          return;
        }
        if (socket.destroyed) cleanup(false);
      });
      port1.start();

      this.interpreter.postMessage({
        type: 'ssh-forward-stream-open',
        streamId,
        connectionId: record.info.connectionId,
        sourceHost: SSH_FORWARD_BIND_HOST,
        sourcePort,
        remoteHost: record.info.remoteHost,
        remotePort: record.info.remotePort,
      } satisfies MainToInterpreter, [port2]);
    } catch {
      failStream();
    }
  }
}
