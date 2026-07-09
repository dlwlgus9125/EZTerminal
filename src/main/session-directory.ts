/**
 * SessionDirectory — the live-session list, owned privately by
 * `InterpreterBroker` (the sole `add`/`remove` caller). Main previously didn't
 * track sessions at all (the interpreter's `SessionRegistry` is the sole owner
 * of session STATE); this is just a thin `{cwd, createdAt}` directory so a
 * client can ask "what sessions exist right now" via `list-sessions`. The broker
 * calls `add` on the interpreter's `session-created` reply and `remove` on
 * `destroySession`.
 *
 * `onSessionAdded`/`onSessionRemoved` (M2 mirroring) let `main.ts` (desktop
 * window fan-out) and `remote-bridge.ts` (per-connection WS fan-out) each
 * observe every change via the shared broker, regardless of which surface caused
 * it. Listeners fire on `setImmediate`, NOT synchronously from `add`/`remove` —
 * the caller that triggered the change (e.g. `createSession`'s own correlated
 * reply) is still in-flight via its own promise-resolution microtask when
 * `add`/`remove` returns, and `setImmediate` runs only after that microtask
 * queue drains. This guarantees a requester always learns "this sessionId is
 * mine" (via its own reply) BEFORE it can see the broadcast echo of its own
 * session — a synchronous notify could otherwise reach the requester first and
 * be mistaken for a session created elsewhere (ADR C6).
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
   * The broker is the sole `add` caller (it owns the single interpreter
   * `session-created` listener), so a duplicate `add` for one sessionId cannot
   * occur. The former idempotency guard — which papered over the AC4
   * double-listener bug (main.ts's handler AND remote-bridge.ts's per-connection
   * listener both calling `add` for a WS-originated create) — is gone now that
   * the seam is structural.
   */
  add(session: SessionInfo): void {
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
