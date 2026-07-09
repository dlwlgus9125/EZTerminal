/**
 * InterpreterBroker — the single main-side owner of the interpreter
 * utilityProcess handle, the create-session/list-runs correlation state, the
 * run-command/attach-run port brokering, and the session-created/run-started/
 * run-list dispatch. `main.ts` (local IPC) and `remote-bridge.ts` (WS remote)
 * are thin adapters over ONE shared broker instance, so there is exactly one
 * `SessionDirectory.add` caller (the AC4 double-add bug is eliminated
 * structurally) and exactly one interpreter `message` listener for
 * session/run traffic.
 *
 * Transport-agnostic: `runCommand`/`attachRun` return `port1` and let the
 * adapter decide transfer-to-renderer vs frame-relay-over-WS. Everything the
 * broker touches (the interpreter, the MessageChannel factory, the id mint)
 * is constructor-injected so the whole surface is unit-testable through the
 * interface (see interpreter-broker.test.ts).
 *
 * Dead-interpreter contract (the correctness spine). `alive` starts `true` and
 * flips `false` inside the broker's own `exit` listener, which also rejects
 * every in-flight `createSession`/`listRuns` pending. Per method when `!alive`:
 * `createSession` rejects; `listRuns` resolves `[]` at entry (an in-flight one
 * rejects); `runCommand`/`attachRun` return `null` (caller MUST null-guard
 * before transfer); `destroySession`'s post becomes a no-op; `listSessions`
 * is unaffected.
 *
 * Ordering contract (ADR C6). On `session-created` the broker resolves the
 * caller's promise FIRST, then calls `directory.add` (whose `onSessionAdded`
 * fan-out is `setImmediate`-deferred). A requester therefore always learns
 * "this sessionId is mine" via its own reply BEFORE it can see the broadcast
 * echo of its own session.
 */
import { randomUUID } from 'node:crypto';

import type { InterpreterToMain, MainToInterpreter, RunStartedInfo, SessionInfo } from '../shared/ipc';
import { SessionDirectory } from './session-directory';

// ── DI seams (narrow slices of Electron's MessagePortMain / UtilityProcess —
//    real instances satisfy these structurally, fakes in tests need implement
//    nothing more). Relocated here from remote-bridge.ts and re-exported there
//    so the broker owns them; remote-bridge keeps importing them unchanged. ──

export interface RemotePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

export interface RemoteMessageChannel {
  readonly port1: RemotePort;
  readonly port2: RemotePort;
}

export interface RemoteInterpreter {
  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void;
  on(event: 'message', listener: (message: InterpreterToMain) => void): void;
  off(event: 'message', listener: (message: InterpreterToMain) => void): void;
}

/**
 * The interpreter handle the broker drives: the transport-agnostic
 * `RemoteInterpreter` seam PLUS the `exit` event the real `UtilityProcess`
 * emits (the broker needs it to flip `alive` and reject in-flight pendings).
 * Kept as a SEPARATE interface rather than widening `RemoteInterpreter` so the
 * existing `remote-bridge.test.ts` fakes — which implement only `on('message')`
 * — keep type-checking; a real `UtilityProcess` satisfies both structurally.
 */
export interface BrokerInterpreter extends RemoteInterpreter {
  on(event: 'message', listener: (message: InterpreterToMain) => void): void;
  on(event: 'exit', listener: (code?: number) => void): void;
}

type PendingCreate = { resolve: (info: SessionInfo) => void; reject: (err: Error) => void };
type PendingRunList = { resolve: (runs: readonly RunStartedInfo[]) => void; reject: (err: Error) => void };

export class InterpreterBroker {
  private readonly interpreter: BrokerInterpreter;
  private readonly createMessageChannel: () => RemoteMessageChannel;
  private readonly newId: () => string;
  private readonly directory = new SessionDirectory();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly pendingRunLists = new Map<string, PendingRunList>();
  private readonly runStartedListeners = new Set<(info: RunStartedInfo) => void>();
  private alive = true;

  constructor(deps: {
    interpreter: BrokerInterpreter;
    createMessageChannel: () => RemoteMessageChannel;
    newId?: () => string;
  }) {
    this.interpreter = deps.interpreter;
    this.createMessageChannel = deps.createMessageChannel;
    this.newId = deps.newId ?? randomUUID;

    // Listener #1: session/run dispatch ONLY. Script-host + known-host messages
    // are handled by main's own (separate) listener — this arm ignores them, so
    // the two disjoint-by-type listeners never double-process a message.
    this.interpreter.on('message', (msg) => {
      if (msg.type === 'session-created') {
        const pending = this.pendingCreates.get(msg.requestId);
        if (pending === undefined) return; // unmatched requestId — ignore
        this.pendingCreates.delete(msg.requestId);
        const session: SessionInfo = { sessionId: msg.sessionId, cwd: msg.cwd };
        // ADR C6: resolve the caller FIRST, THEN add to the directory (whose
        // onSessionAdded fan-out is setImmediate-deferred). Load-bearing order.
        pending.resolve(session);
        this.directory.add(session);
      } else if (msg.type === 'run-started') {
        const info: RunStartedInfo = { sessionId: msg.sessionId, runId: msg.runId, commandText: msg.commandText };
        for (const listener of this.runStartedListeners) listener(info);
      } else if (msg.type === 'run-list') {
        const pending = this.pendingRunLists.get(msg.requestId);
        if (pending === undefined) return; // unmatched requestId — ignore
        this.pendingRunLists.delete(msg.requestId);
        pending.resolve(msg.runs);
      }
    });

    // On interpreter death: flip alive, then reject + clear every in-flight
    // pending (parity with main's former exit cleanup). Reason string is the
    // in-flight-death signal callers (WS adapters) `.catch`-swallow.
    this.interpreter.on('exit', () => {
      this.alive = false;
      const err = new Error('interpreter exited');
      for (const pending of this.pendingCreates.values()) pending.reject(err);
      for (const pending of this.pendingRunLists.values()) pending.reject(err);
      this.pendingCreates.clear();
      this.pendingRunLists.clear();
    });
  }

  createSession(cwd?: string): Promise<SessionInfo> {
    if (!this.alive) return Promise.reject(new Error('interpreter not running'));
    const requestId = this.newId();
    return new Promise<SessionInfo>((resolve, reject) => {
      this.pendingCreates.set(requestId, { resolve, reject });
      this.interpreter.postMessage({ type: 'create-session', requestId, cwd });
    });
  }

  destroySession(sessionId: string): void {
    this.directory.remove(sessionId);
    if (this.alive) this.interpreter.postMessage({ type: 'destroy-session', sessionId });
  }

  listSessions(): SessionInfo[] {
    return this.directory.list();
  }

  runCommand(sessionId: string, runId: string, commandText: string): RemotePort | null {
    if (!this.alive) return null;
    const { port1, port2 } = this.createMessageChannel();
    this.interpreter.postMessage({ type: 'run', commandText, sessionId, runId }, [port2]);
    return port1; // returned UN-started — the caller starts/transfers it.
  }

  attachRun(runId: string): RemotePort | null {
    if (!this.alive) return null;
    const { port1, port2 } = this.createMessageChannel();
    this.interpreter.postMessage({ type: 'attach-run', runId }, [port2]);
    return port1;
  }

  listRuns(): Promise<readonly RunStartedInfo[]> {
    if (!this.alive) return Promise.resolve([]);
    const requestId = this.newId();
    return new Promise<readonly RunStartedInfo[]>((resolve, reject) => {
      this.pendingRunLists.set(requestId, { resolve, reject });
      this.interpreter.postMessage({ type: 'list-runs', requestId });
    });
  }

  onSessionAdded(fn: (s: SessionInfo) => void): () => void {
    return this.directory.onSessionAdded(fn);
  }

  onSessionRemoved(fn: (id: string) => void): () => void {
    return this.directory.onSessionRemoved(fn);
  }

  onRunStarted(fn: (info: RunStartedInfo) => void): () => void {
    this.runStartedListeners.add(fn);
    return () => this.runStartedListeners.delete(fn);
  }
}
