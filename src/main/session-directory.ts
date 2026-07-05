/**
 * SessionDirectory — main's list of live shell sessions (mobile remote-
 * control M0). Main previously didn't track sessions at all (the interpreter's
 * `SessionRegistry` is the sole owner of session STATE); this is just a thin
 * `{cwd, createdAt}` directory so a remote client can ask "what sessions exist
 * right now" via `list-sessions`. Hooked from `main.ts` at the same two points
 * that already exist for the renderer: the interpreter's `session-created`
 * reply (`add`) and the `destroy-session` handler (`remove`).
 *
 * `onSessionAdded`/`onSessionRemoved` (M2 mirroring) let `main.ts` (desktop
 * window fan-out) and `remote-bridge.ts` (per-connection WS fan-out) each
 * observe every change, regardless of which surface caused it. Listeners fire
 * on `setImmediate`, NOT synchronously from `add`/`remove` — the caller that
 * triggered the change (e.g. `create-session`'s own correlated reply) is still
 * in-flight via its own promise-resolution microtask when `add`/`remove`
 * returns, and `setImmediate` runs only after that microtask queue drains.
 * This guarantees a requester always learns "this sessionId is mine" (via its
 * own reply) BEFORE it can see the broadcast echo of its own session — a
 * synchronous notify could otherwise reach the requester first and be
 * mistaken for a session created elsewhere (ADR C6).
 */
import type { SessionInfo } from '../shared/ipc';

interface SessionRecord {
  readonly cwd: string;
  readonly createdAt: number;
}

export class SessionDirectory {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly addListeners = new Set<(session: SessionInfo) => void>();
  private readonly removeListeners = new Set<(sessionId: string) => void>();

  /**
   * Idempotent: a sessionId already tracked is a no-op (no data change, no
   * event). Necessary because the SAME `session-created` interpreter message
   * can reach `add()` twice for one session — main.ts's own handler AND
   * remote-bridge.ts's per-connection `onInterpreterMessage` are separate
   * listeners on the same `interpreter.on('message', ...)` emitter, and both
   * call `add()` for a WS-originated create (AC4 bug: without this guard,
   * `onSessionAdded` broadcasts twice and the desktop opens two duplicate panes).
   */
  add(session: SessionInfo): void {
    if (this.sessions.has(session.sessionId)) return;
    this.sessions.set(session.sessionId, { cwd: session.cwd, createdAt: Date.now() });
    for (const listener of this.addListeners) setImmediate(() => listener(session));
  }

  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      for (const listener of this.removeListeners) setImmediate(() => listener(sessionId));
    }
  }

  /** Oldest-created first. */
  list(): SessionInfo[] {
    return [...this.sessions.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([sessionId, record]) => ({ sessionId, cwd: record.cwd }));
  }

  /** A session now exists, any origin. Returns an unsubscribe. */
  onSessionAdded(listener: (session: SessionInfo) => void): () => void {
    this.addListeners.add(listener);
    return () => this.addListeners.delete(listener);
  }

  /** A session is gone, any origin. Returns an unsubscribe. */
  onSessionRemoved(listener: (sessionId: string) => void): () => void {
    this.removeListeners.add(listener);
    return () => this.removeListeners.delete(listener);
  }
}
