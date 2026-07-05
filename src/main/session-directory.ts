/**
 * SessionDirectory — main's list of live shell sessions (mobile remote-
 * control M0). Main previously didn't track sessions at all (the interpreter's
 * `SessionRegistry` is the sole owner of session STATE); this is just a thin
 * `{cwd, createdAt}` directory so a remote client can ask "what sessions exist
 * right now" via `list-sessions`. Hooked from `main.ts` at the same two points
 * that already exist for the renderer: the interpreter's `session-created`
 * reply (`add`) and the `destroy-session` handler (`remove`).
 */
import type { SessionInfo } from '../shared/ipc';

interface SessionRecord {
  readonly cwd: string;
  readonly createdAt: number;
}

export class SessionDirectory {
  private readonly sessions = new Map<string, SessionRecord>();

  add(session: SessionInfo): void {
    this.sessions.set(session.sessionId, { cwd: session.cwd, createdAt: Date.now() });
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Oldest-created first. */
  list(): SessionInfo[] {
    return [...this.sessions.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([sessionId, record]) => ({ sessionId, cwd: record.cwd }));
  }
}
