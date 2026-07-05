import { WebSocket } from 'ws';

import type { ClientToServerMessage, ServerToClientMessage } from '../src/shared/remote-protocol';

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

  private constructor(private readonly ws: WebSocket) {
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerToClientMessage;
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
   * connection must send (see remote-bridge.ts's un-authed guard). */
  static async connectAuthed(url: string, token: string): Promise<TestWsClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new TestWsClient(ws);
    client.send({ kind: 'auth', token });
    await client.waitFor((msg) => msg.kind === 'auth-ok', 5_000);
    return client;
  }

  send(msg: ClientToServerMessage): void {
    this.ws.send(JSON.stringify(msg));
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
}
