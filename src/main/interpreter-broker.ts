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
 * rejects); `runCommand` returns a terminal error port when one can be made;
 * `attachRun` returns `null`; `destroySession`'s post becomes a no-op;
 * `listSessions` is unaffected.
 *
 * Ordering contract (ADR C6). On `session-created` the broker resolves the
 * caller's promise FIRST, then calls `directory.add` (whose `onSessionAdded`
 * fan-out is `setImmediate`-deferred). A requester therefore always learns
 * "this sessionId is mine" via its own reply BEFORE it can see the broadcast
 * echo of its own session.
 */
import { randomUUID } from 'node:crypto';

import { MAX_GUARDED_DESTROY_SESSIONS } from '../shared/ipc';

import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
  InterpreterToMain,
  MainToInterpreter,
  RunAttachRejectReason,
  RunStartedInfo,
  SessionInfo,
} from '../shared/ipc';
import type { WorktreeRequestOrigin } from '../shared/worktree';
import { AsyncMutationGate, type MutationGate } from './async-mutation-gate';
import { SessionDirectory } from './session-directory';
import {
  SessionWorktreeGuard,
  type SessionRunIdentity,
} from './session-worktree-guard';

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
export type CheckedAttachRunResult =
  | { readonly accepted: true; readonly port: RemotePort }
  | { readonly accepted: false; readonly reason: RunAttachRejectReason };
export type RunCommandDispatchResult =
  | { readonly posted: true; readonly port: RemotePort }
  | { readonly posted: false; readonly port: RemotePort | null };
type PendingAttach = {
  readonly port: RemotePort;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve: (result: CheckedAttachRunResult) => void;
};
type PendingDestroy = {
  readonly sessionIds: readonly string[];
  readonly timer: ReturnType<typeof setTimeout>;
  tombstoneTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  resolve: (result: DestroySessionGuardResult) => void;
};
type PendingShutdown = {
  readonly requestId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

const DEFAULT_ATTACH_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_DESTROY_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_DESTROY_TOMBSTONE_TTL_MS = 60_000;
const MAX_PENDING_DESTROYS = 128;

function hasExactSessionIds(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length) return false;
  return actual.every((sessionId) => expectedSet.delete(sessionId)) && expectedSet.size === 0;
}

export class InterpreterBroker {
  private interpreter: BrokerInterpreter;
  private readonly createMessageChannel: () => RemoteMessageChannel;
  private readonly newId: () => string;
  private readonly sessionEnvironment?: (
    sessionId: string,
  ) => Readonly<Record<string, string>>;
  private readonly validateSessionCwd?: (cwd: string) => boolean | Promise<boolean>;
  private readonly mutationGate: MutationGate;
  private readonly runGuard: SessionWorktreeGuard;
  private readonly attachAckTimeoutMs: number;
  private readonly destroyAckTimeoutMs: number;
  private readonly destroyTombstoneTtlMs: number;
  private readonly directory = new SessionDirectory();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly pendingRunLists = new Map<string, PendingRunList>();
  private readonly pendingAttaches = new Map<string, PendingAttach>();
  private readonly pendingDestroys = new Map<string, PendingDestroy>();
  private readonly runStartedListeners = new Set<
    (info: RunStartedInfo) => void
  >();
  private readonly runSettledListeners = new Set<
    (identity: SessionRunIdentity) => void
  >();
  private readonly interpreterExitListeners = new Set<
    (code?: number) => void
  >();
  private readonly wireInterpreter: (interpreter: BrokerInterpreter) => void;
  private alive = true;
  private shuttingDown = false;
  private pendingShutdown: PendingShutdown | null = null;

  constructor(deps: {
    interpreter: BrokerInterpreter;
    createMessageChannel: () => RemoteMessageChannel;
    newId?: () => string;
    sessionEnvironment?: (
      sessionId: string,
    ) => Readonly<Record<string, string>>;
    validateSessionCwd?: (cwd: string) => boolean | Promise<boolean>;
    mutationGate?: MutationGate;
    runGuard?: SessionWorktreeGuard;
    attachAckTimeoutMs?: number;
    destroyAckTimeoutMs?: number;
    destroyTombstoneTtlMs?: number;
  }) {
    this.interpreter = deps.interpreter;
    this.createMessageChannel = deps.createMessageChannel;
    this.newId = deps.newId ?? randomUUID;
    this.sessionEnvironment = deps.sessionEnvironment;
    this.validateSessionCwd = deps.validateSessionCwd;
    this.mutationGate = deps.mutationGate ?? new AsyncMutationGate();
    this.runGuard = deps.runGuard ?? new SessionWorktreeGuard();
    this.attachAckTimeoutMs =
      deps.attachAckTimeoutMs ?? DEFAULT_ATTACH_ACK_TIMEOUT_MS;
    this.destroyAckTimeoutMs =
      deps.destroyAckTimeoutMs ?? DEFAULT_DESTROY_ACK_TIMEOUT_MS;
    this.destroyTombstoneTtlMs =
      deps.destroyTombstoneTtlMs ?? DEFAULT_DESTROY_TOMBSTONE_TTL_MS;

    // Listener #1: session/run dispatch ONLY. Script-host + known-host messages
    // are handled by main's own (separate) listener — this arm ignores them, so
    // the two disjoint-by-type listeners never double-process a message.
    this.wireInterpreter = (candidate): void => {
      candidate.on('message', (msg) => {
        if (candidate !== this.interpreter) return;
        if (msg.type === 'session-created') {
          const pending = this.pendingCreates.get(msg.requestId);
          if (pending === undefined) return; // unmatched requestId — ignore
          this.pendingCreates.delete(msg.requestId);
          const session: SessionInfo = { sessionId: msg.sessionId, cwd: msg.cwd };
          const environment = this.sessionEnvironment?.(msg.sessionId);
          if (environment && Object.keys(environment).length > 0) {
            // ParentPort preserves order. Injection is posted before the
            // createSession promise resolves, so an immediately following run
            // cannot start without the hook-correlation environment.
            this.interpreter.postMessage({
              type: 'set-session-environment',
              sessionId: msg.sessionId,
              environment,
            });
          }
          // ADR C6: resolve the caller FIRST, THEN add to the directory (whose
          // onSessionAdded fan-out is setImmediate-deferred). Load-bearing order.
          pending.resolve(session);
          this.directory.add(session);
        } else if (msg.type === 'session-run-settled') {
          const identity = { sessionId: msg.sessionId, runId: msg.runId };
          const exactOwner = this.runGuard.finishRun(identity);
          if (exactOwner) {
            if (msg.cwd !== undefined)
              this.directory.updateCwd(msg.sessionId, msg.cwd);
            for (const listener of this.runSettledListeners) listener(identity);
          }
        } else if (msg.type === 'run-started') {
          const info: RunStartedInfo = {
            sessionId: msg.sessionId,
            runId: msg.runId,
            commandText: msg.commandText,
            executionKind: msg.executionKind,
          };
          for (const listener of this.runStartedListeners) listener(info);
        } else if (msg.type === 'run-list') {
          const pending = this.pendingRunLists.get(msg.requestId);
          if (pending === undefined) return; // unmatched requestId — ignore
          this.pendingRunLists.delete(msg.requestId);
          pending.resolve(msg.runs);
        } else if (msg.type === 'run-attach-result') {
          const pending = this.pendingAttaches.get(msg.requestId);
          if (pending === undefined) return;
          this.pendingAttaches.delete(msg.requestId);
          clearTimeout(pending.timer);
          if (msg.accepted) {
            pending.resolve({ accepted: true, port: pending.port });
          } else {
            pending.port.close();
            pending.resolve({ accepted: false, reason: msg.reason });
          }
        } else if (msg.type === 'session-destroy-result') {
          const pending = this.pendingDestroys.get(msg.requestId);
          if (pending !== undefined && !hasExactSessionIds(pending.sessionIds, msg.sessionIds)) {
            // A known correlation id is not sufficient: the interpreter must
            // echo the exact requested identity set. Never let a malformed ACK
            // delete an unrelated directory entry or resolve success.
            this.pendingDestroys.delete(msg.requestId);
            clearTimeout(pending.timer);
            if (pending.tombstoneTimer !== null) clearTimeout(pending.tombstoneTimer);
            if (!pending.settled) {
              pending.settled = true;
              pending.resolve({ ok: false, reason: 'unavailable' });
            }
            return;
          }
          // Reconcile even after the caller timed out or its bounded tombstone
          // expired. The interpreter is authoritative and echoes the affected
          // identities specifically for this late-ACK path.
          if (msg.destroyed) {
            for (const sessionId of pending?.sessionIds ?? msg.sessionIds) {
              this.directory.remove(sessionId);
              this.runGuard.finishSession(sessionId);
            }
          }
          if (pending === undefined) return;
          this.pendingDestroys.delete(msg.requestId);
          clearTimeout(pending.timer);
          if (pending.tombstoneTimer !== null)
            clearTimeout(pending.tombstoneTimer);
          if (!pending.settled) {
            pending.settled = true;
            pending.resolve(
              msg.destroyed
                ? { ok: true }
                : { ok: false, reason: 'state-changed' },
            );
          }
        } else if (msg.type === 'interpreter-shutdown-complete') {
          const pending = this.pendingShutdown;
          if (!pending || pending.requestId !== msg.requestId) return;
          this.pendingShutdown = null;
          clearTimeout(pending.timer);
          pending.resolve();
        }
      });

      // On interpreter death: flip alive, then reject + clear every in-flight
      // pending (parity with main's former exit cleanup). Reason string is the
      // in-flight-death signal callers (WS adapters) `.catch`-swallow.
      candidate.on('exit', (code) => {
        if (candidate !== this.interpreter) return;
        this.alive = false;
        const err = new Error('interpreter exited');
        for (const pending of this.pendingCreates.values()) pending.reject(err);
        for (const pending of this.pendingRunLists.values()) pending.reject(err);
        for (const pending of this.pendingAttaches.values()) {
          clearTimeout(pending.timer);
          pending.port.close();
          pending.resolve({ accepted: false, reason: 'transport-failed' });
        }
        for (const pending of this.pendingDestroys.values()) {
          clearTimeout(pending.timer);
          if (pending.tombstoneTimer !== null)
            clearTimeout(pending.tombstoneTimer);
          if (!pending.settled)
            pending.resolve({ ok: false, reason: 'unavailable' });
        }
        this.pendingCreates.clear();
        this.pendingRunLists.clear();
        this.pendingAttaches.clear();
        this.pendingDestroys.clear();
        const shutdown = this.pendingShutdown;
        this.pendingShutdown = null;
        if (shutdown) {
          clearTimeout(shutdown.timer);
          shutdown.resolve();
        }
        this.runGuard.clearRuns();
        for (const listener of this.interpreterExitListeners) listener(code);
      });
    };
    this.wireInterpreter(this.interpreter);
  }

  /** Replace a dead utility process without changing the broker object observed
   * by desktop IPC, the mobile bridge, or agent activity tracking. Session ids
   * and their latest cwd are replayed before any later command message. */
  restart(interpreter: BrokerInterpreter): boolean {
    const sessions = this.directory.list();
    this.interpreter = interpreter;
    this.alive = true;
    this.shuttingDown = false;
    this.wireInterpreter(interpreter);
    try {
      interpreter.postMessage({ type: 'restore-sessions', sessions });
      for (const session of sessions) {
        const environment = this.sessionEnvironment?.(session.sessionId);
        if (!environment || Object.keys(environment).length === 0) continue;
        interpreter.postMessage({
          type: 'set-session-environment',
          sessionId: session.sessionId,
          environment,
        });
      }
      return true;
    } catch {
      this.alive = false;
      return false;
    }
  }

  createSession(cwd?: string): Promise<SessionInfo> {
    return this.mutationGate.runExclusive(async () => {
      if (!this.alive || this.shuttingDown)
        return Promise.reject(new Error('interpreter not running'));
      if (cwd !== undefined && this.validateSessionCwd) {
        const validation = this.validateSessionCwd(cwd);
        const isValid = typeof validation === 'boolean' ? validation : await validation;
        if (!isValid) throw new Error('session cwd is no longer an existing directory');
      }
      // Validation may cross an async filesystem boundary. The interpreter can
      // exit while it is in flight, after the exit handler has already drained
      // pendingCreates. Never install a new pending entry after that drain.
      if (!this.alive || this.shuttingDown) throw new Error('interpreter not running');
      const requestId = this.newId();
      return new Promise<SessionInfo>((resolve, reject) => {
        this.pendingCreates.set(requestId, { resolve, reject });
        try {
          this.interpreter.postMessage({
            type: 'create-session',
            requestId,
            cwd,
          });
        } catch (error) {
          this.pendingCreates.delete(requestId);
          reject(error instanceof Error ? error : new Error('interpreter unavailable'));
        }
      });
    });
  }

  destroySession(sessionId: string): void {
    if (!this.alive || this.shuttingDown) {
      this.directory.remove(sessionId);
      return;
    }
    try {
      this.interpreter.postMessage({ type: 'destroy-session', sessionId });
      this.directory.remove(sessionId);
    } catch {
      // Legacy callers have no ACK. If delivery itself fails, retain the
      // authoritative directory entry rather than creating a ghost session.
    }
  }

  listSessions(): SessionInfo[] {
    return this.directory.list();
  }

  runCommand(
    sessionId: string,
    runId: string,
    commandText: string,
    requestOrigin?: WorktreeRequestOrigin,
  ): RemotePort | null {
    return this.tryRunCommand(sessionId, runId, commandText, requestOrigin).port;
  }

  /** Main-only command dispatch with a redacted renderer/history label. */
  runPrivateCommand(
    sessionId: string,
    runId: string,
    commandText: string,
    displayCommandText: string,
    requestOrigin?: WorktreeRequestOrigin,
  ): RemotePort | null {
    return this.tryRunCommand(
      sessionId,
      runId,
      commandText,
      requestOrigin,
      displayCommandText,
    ).port;
  }

  /**
   * Distinguishes a command posted to the interpreter from a broker-local
   * rejection while preserving the same terminal error port for adapters.
   * Remote transport metadata may only be attached to the `posted` branch.
   */
  tryRunCommand(
    sessionId: string,
    runId: string,
    commandText: string,
    requestOrigin?: WorktreeRequestOrigin,
    displayCommandText?: string,
  ): RunCommandDispatchResult {
    if (!this.alive || this.shuttingDown) {
      return {
        posted: false,
        port: this.createRejectedRunPort('The interpreter is not running'),
      };
    }
    if (!this.runGuard.tryBeginRun({ sessionId, runId })) {
      return {
        posted: false,
        port: this.createRejectedRunPort(
          'Run could not start while a worktree mutation is in progress',
        ),
      };
    }
    let channel: RemoteMessageChannel | undefined;
    try {
      channel = this.createMessageChannel();
      const { port1, port2 } = channel;
      this.interpreter.postMessage(
        {
          type: 'run',
          commandText,
          ...(displayCommandText ? { displayCommandText } : {}),
          sessionId,
          runId,
          ...(requestOrigin ? { requestOrigin } : {}),
        },
        [port2],
      );
      // Returned UN-started; the caller starts or transfers it.
      return { posted: true, port: port1 };
    } catch {
      this.runGuard.finishRun({ sessionId, runId });
      try {
        channel?.port1.close();
        channel?.port2.close();
      } catch {
        // Channel creation/transfer already tore down one side.
      }
      return {
        posted: false,
        port: this.createRejectedRunPort(
          'The interpreter could not start this run',
        ),
      };
    }
  }

  /** Uses the same queued-error-then-close contract as interpreter rejectRun,
   * so every existing desktop/WS/mobile port consumer reaches a terminal
   * BlockController state without a new protocol branch. */
  private createRejectedRunPort(message: string): RemotePort | null {
    let channel: RemoteMessageChannel | undefined;
    try {
      channel = this.createMessageChannel();
      queueMicrotask(() => {
        try {
          channel?.port2.postMessage({ type: 'error', message });
        } catch {
          // The consumer disappeared before the terminal frame was delivered.
        } finally {
          try {
            channel?.port2.close();
          } catch {
            // The peer already won the close race.
          }
        }
      });
      return channel.port1;
    } catch {
      try {
        channel?.port1.close();
        channel?.port2.close();
      } catch {
        // Channel construction or local delivery already tore down one side.
      }
      return null;
    }
  }

  attachRun(sessionId: string, runId: string): RemotePort | null {
    if (!this.alive || this.shuttingDown) return null;
    const { port1, port2 } = this.createMessageChannel();
    this.interpreter.postMessage({ type: 'attach-run', sessionId, runId }, [
      port2,
    ]);
    return port1;
  }

  /** Atomically compare the renderer/mobile run snapshot inside the
   * interpreter before teardown. The directory is removed only after the
   * authoritative acknowledgement, never optimistically. */
  destroySessionGuarded(
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ): Promise<DestroySessionGuardResult> {
    return this.requestGuardedDestroy([sessionId], (requestId, deadlineAt) => ({
      type: 'destroy-session',
      sessionId,
      requestId,
      expectedActiveRunIds: [...new Set(expectedActiveRunIds)].sort(),
      deadlineAt,
    }));
  }

  /** One interpreter turn validates every snapshot before mutating any
   * session, so applying a preset cannot partially tear down the workspace. */
  destroySessionsGuarded(
    sessions: readonly GuardedSessionDestroyRequest[],
  ): Promise<DestroySessionGuardResult> {
    if (sessions.length === 0) return Promise.resolve({ ok: true });
    if (sessions.length > MAX_GUARDED_DESTROY_SESSIONS) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const normalized = sessions.map((entry) => ({
      sessionId: entry.sessionId,
      expectedActiveRunIds: [...new Set(entry.expectedActiveRunIds)].sort(),
    }));
    if (
      new Set(normalized.map((entry) => entry.sessionId)).size !==
      normalized.length
    ) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    return this.requestGuardedDestroy(
      normalized.map((entry) => entry.sessionId),
      (requestId, deadlineAt) => ({
        type: 'destroy-sessions-guarded',
        requestId,
        sessions: normalized,
        deadlineAt,
      }),
    );
  }

  private requestGuardedDestroy(
    sessionIds: readonly string[],
    makeMessage: (requestId: string, deadlineAt: number) => MainToInterpreter,
  ): Promise<DestroySessionGuardResult> {
    if (!this.alive || this.shuttingDown) {
      // Utility-process exit is authoritative shared-fate: no backend shell
      // can still exist. Requests that begin after that signal may reconcile
      // locally; in-flight requests are still failed unavailable by the exit
      // handler because their ordering was ambiguous when death occurred.
      for (const sessionId of sessionIds) {
        this.directory.remove(sessionId);
        this.runGuard.finishSession(sessionId);
      }
      return Promise.resolve({ ok: true });
    }
    if (this.pendingDestroys.size >= MAX_PENDING_DESTROYS) {
      const oldestTombstone = [...this.pendingDestroys.entries()].find(
        ([, pending]) => pending.settled,
      );
      if (!oldestTombstone)
        return Promise.resolve({ ok: false, reason: 'unavailable' });
      const [oldRequestId, oldPending] = oldestTombstone;
      if (oldPending.tombstoneTimer !== null)
        clearTimeout(oldPending.tombstoneTimer);
      this.pendingDestroys.delete(oldRequestId);
    }
    const requestId = this.newId();
    const deadlineAt = Date.now() + this.destroyAckTimeoutMs;
    return new Promise<DestroySessionGuardResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingDestroys.get(requestId);
        if (pending?.timer !== timer) return;
        pending.settled = true;
        pending.resolve({ ok: false, reason: 'unavailable' });
        pending.tombstoneTimer = setTimeout(() => {
          if (this.pendingDestroys.get(requestId) === pending) {
            this.pendingDestroys.delete(requestId);
          }
        }, this.destroyTombstoneTtlMs);
        pending.tombstoneTimer.unref?.();
      }, this.destroyAckTimeoutMs);
      timer.unref?.();
      this.pendingDestroys.set(requestId, {
        sessionIds: Object.freeze([...sessionIds]),
        timer,
        tombstoneTimer: null,
        settled: false,
        resolve,
      });
      try {
        this.interpreter.postMessage(makeMessage(requestId, deadlineAt));
      } catch {
        this.pendingDestroys.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, reason: 'unavailable' });
      }
    });
  }

  /** Reconnect-only attach that waits for the interpreter's authoritative
   * acceptance before a caller releases an existing liveness-holding port. */
  attachRunChecked(
    sessionId: string,
    runId: string,
  ): Promise<CheckedAttachRunResult> {
    if (!this.alive || this.shuttingDown)
      return Promise.resolve({ accepted: false, reason: 'transport-failed' });
    const requestId = this.newId();
    const { port1, port2 } = this.createMessageChannel();
    return new Promise<CheckedAttachRunResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingAttaches.get(requestId);
        if (pending?.timer !== timer) return;
        this.pendingAttaches.delete(requestId);
        pending.port.close();
        pending.resolve({ accepted: false, reason: 'transport-failed' });
      }, this.attachAckTimeoutMs);
      timer.unref?.();
      this.pendingAttaches.set(requestId, { port: port1, timer, resolve });
      try {
        this.interpreter.postMessage(
          { type: 'attach-run', requestId, sessionId, runId },
          [port2],
        );
      } catch {
        this.pendingAttaches.delete(requestId);
        clearTimeout(timer);
        port1.close();
        resolve({ accepted: false, reason: 'transport-failed' });
      }
    });
  }

  listRuns(): Promise<readonly RunStartedInfo[]> {
    if (!this.alive || this.shuttingDown) return Promise.resolve([]);
    const requestId = this.newId();
    return new Promise<readonly RunStartedInfo[]>((resolve, reject) => {
      this.pendingRunLists.set(requestId, { resolve, reject });
      this.interpreter.postMessage({ type: 'list-runs', requestId });
    });
  }

  /** Freeze new broker work and ask the current utility-process generation to
   * drain every execution. Interpreter exit is also a successful terminal
   * outcome because the native process group owns any surviving descendants. */
  shutdown(timeoutMs = 3_000): Promise<void> {
    if (this.pendingShutdown) return this.pendingShutdown.promise;
    if (this.shuttingDown) return Promise.resolve();
    this.shuttingDown = true;
    if (!this.alive) return Promise.resolve();

    const requestId = this.newId();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      if (this.pendingShutdown?.requestId !== requestId) return;
      this.pendingShutdown = null;
      reject(new Error(`interpreter shutdown exceeded ${String(timeoutMs)}ms`));
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    this.pendingShutdown = { requestId, timer, promise, resolve, reject };
    try {
      this.interpreter.postMessage({ type: 'interpreter-shutdown', requestId });
    } catch (error) {
      this.pendingShutdown = null;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error('interpreter shutdown failed'));
    }
    return promise;
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

  onRunSettled(fn: (identity: SessionRunIdentity) => void): () => void {
    this.runSettledListeners.add(fn);
    return () => this.runSettledListeners.delete(fn);
  }

  onInterpreterExited(fn: (code?: number) => void): () => void {
    this.interpreterExitListeners.add(fn);
    return () => this.interpreterExitListeners.delete(fn);
  }
}
