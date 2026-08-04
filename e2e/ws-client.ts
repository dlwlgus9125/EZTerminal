import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import {
  REMOTE_PROTOCOL_VERSION,
  type ClientToServerMessage,
  type RemoteClientIdentity,
  type ServerToClientMessage,
} from '../src/shared/remote-protocol';
import type {
  SessionSurfaceBinding,
  SessionSurfaceDisposition,
  SessionSurfaceIntent,
} from '../src/shared/session-surface';

/**
 * Minimal Node-side WS client for the mirroring e2e (session-mirror.spec.ts):
 * drives the real `remote-bridge.ts` the same way a phone would, so the
 * desktop UI's reaction to a WS-originated session/run can be asserted
 * end-to-end — the real `WebSocketServer`, the real interpreter
 * utilityProcess, no fakes (those already live in remote-bridge.test.ts).
 */
interface PendingWaiter {
  readonly predicate: (msg: ServerToClientMessage) => boolean;
  readonly resolve: (msg: ServerToClientMessage) => void;
}

export class TestWsClient {
  private readonly pending: PendingWaiter[] = [];
  private readonly listeners: Array<(msg: ServerToClientMessage) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerToClientMessage;
      // Every-message listeners first (e.g. a per-frame auto-acker,
      // remote-resume-stall.spec.ts) so a waiter chained on a frame can rely
      // on that frame's ack having been sent already.
      for (const listener of [...this.listeners]) listener(msg);
      // Iterate a snapshot: a waiter's resolve may synchronously queue a new
      // waitFor (chained awaits in the test), which must not be visited by
      // this same delivery pass.
      for (const waiter of [...this.pending]) {
        if (!waiter.predicate(msg)) continue;
        const idx = this.pending.indexOf(waiter);
        if (idx >= 0) this.pending.splice(idx, 1);
        waiter.resolve(msg); // clears its own timeout (see waitFor)
      }
    });
  }

  /** Open a socket and complete the auth handshake — the first message any
   * connection must send (see remote-bridge.ts's un-authed guard).
   * `clientIdentity` opts into protocol-v2 install identity, the way the real
   * mobile transport authenticates (required for initiator-owned resume). */
  static async connectAuthed(
    url: string,
    token: string,
    clientIdentity?: RemoteClientIdentity,
  ): Promise<TestWsClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new TestWsClient(ws);
    client.send({
      kind: 'auth',
      token,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      clientVersion: '1.0.0-e2e',
      buildSha: 'e2e',
      clientIdentity: clientIdentity ?? {
        clientId: randomUUID(),
        clientName: 'e2e-phone',
        platform: 'android',
      },
    });
    await client.waitFor((msg) => msg.kind === 'auth-ok', 5_000);
    return client;
  }

  /** Register a listener invoked for EVERY server message (before any
   * `waitFor` waiter). Unlike `waitFor` it never unregisters — use for
   * continuous protocol duties like per-frame `pty-ack`s. */
  onEachMessage(listener: (msg: ServerToClientMessage) => void): void {
    this.listeners.push(listener);
  }

  send(msg: ClientToServerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async openSessionSurface(
    intent: SessionSurfaceIntent,
    surfaceId = randomUUID(),
  ): Promise<SessionSurfaceBinding> {
    const requestId = randomUUID();
    const reply = this.waitFor(
      (message) => (
        message.kind === 'session-surface-open-result'
        && message.requestId === requestId
      ),
    );
    this.send({ kind: 'session-surface-open', requestId, surfaceId, intent });
    const message = await reply;
    if (message.kind !== 'session-surface-open-result' || !message.result.ok) {
      throw new Error('session surface open failed');
    }
    return message.result.binding;
  }

  async closeSessionSurface(
    binding: SessionSurfaceBinding,
    disposition: SessionSurfaceDisposition,
    expectedActiveRunIds: readonly string[] = [],
  ): Promise<void> {
    const prepareRequestId = randomUUID();
    const preparedReply = this.waitFor(
      (message) => (
        message.kind === 'session-surface-prepare-close-result'
        && message.requestId === prepareRequestId
      ),
    );
    this.send({
      kind: 'session-surface-prepare-close',
      requestId: prepareRequestId,
      entries: [{ bindingId: binding.bindingId, expectedActiveRunIds }],
    });
    const prepared = await preparedReply;
    if (prepared.kind !== 'session-surface-prepare-close-result' || !prepared.result.ok) {
      throw new Error('session surface close preparation failed');
    }

    const commitRequestId = randomUUID();
    const committedReply = this.waitFor(
      (message) => (
        message.kind === 'session-surface-commit-close-result'
        && message.requestId === commitRequestId
      ),
    );
    this.send({
      kind: 'session-surface-commit-close',
      requestId: commitRequestId,
      closeToken: prepared.result.prepared.closeToken,
      decisions: binding.role === 'owner'
        ? [{ bindingId: binding.bindingId, disposition }]
        : [],
    });
    const committed = await committedReply;
    if (committed.kind !== 'session-surface-commit-close-result' || !committed.result.ok) {
      throw new Error('session surface close commit failed');
    }
  }

  /** Resolve the next server message matching `predicate` (messages that
   * arrived before this call was made are NOT replayed — call this before
   * triggering the action that produces the awaited message). */
  waitFor(
    predicate: (msg: ServerToClientMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<ServerToClientMessage> {
    return new Promise((resolve, reject) => {
      // `timer` is declared (as `const`) AFTER `waiter`, which references it in
      // a closure — safe: that closure only runs later, once `timer` is bound.
      const waiter: PendingWaiter = {
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(waiter);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`TestWsClient.waitFor timed out after ${timeoutMs}ms waiting for a matching message`));
      }, timeoutMs);
      this.pending.push(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }

  /** Resolve once the underlying socket closes, whether client- or
   * server-initiated (remote-toggle.spec.ts uses this to prove a bridge
   * shutdown actually terminates its existing connections, not just stops
   * accepting new ones). */
  waitForClose(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
    });
  }
}
