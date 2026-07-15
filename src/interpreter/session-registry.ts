/**
 * SessionRegistry — the interpreter's owner of independent shell sessions
 * (Track A multi-session backend). ONE utilityProcess hosts N sessions; each has its
 * own {@link ShellSession} (cwd/env/variables/history), so tabs/panes are isolated.
 *
 * Sessions are created ONLY via {@link create} (never lazily on `run`), so a `run`
 * for an unknown or destroyed session is rejected — not silently resurrected
 * (Codex B1). {@link destroy} owns the session's in-flight runs: it aborts + disposes
 * every open execution before dropping the record (Codex B2/B6). {@link canRun}
 * serializes foreground runs within a session (Codex B4) — parallelism is across
 * sessions (tabs), never within one, so a streaming command can't observe another
 * run mutating the shared cwd/env/variables mid-iteration.
 *
 * This module is IPC-agnostic: it knows nothing about MessagePorts or frames. The
 * interpreter bootstrap owns port wiring and calls {@link canRun}/{@link track};
 * the registry only bookkeeps sessions + their executions, which keeps it unit
 * testable with a fake {@link Execution}.
 */

import { ShellSession } from './shell-session';
import type { SessionInfo } from '../shared/ipc';

/** The registry's minimal view of a running command: enough to tear it down. */
export interface Execution {
  /** Signal cancellation (AbortController) — stops streams, kills external procs. */
  abort(): void;
  /** Release resources (ResultStore / PTY child) and close the port. Idempotent. */
  dispose(): void;
}

export interface SessionRecord {
  readonly shell: ShellSession;
  state: 'live' | 'destroying';
  /** Open executions (running or paging a completed result) — teardown targets. */
  readonly executions: Set<Execution>;
  /** The session's current foreground run, or null when idle (mutual exclusion). */
  activeRun: Execution | null;
}

export type RunGate =
  | { readonly ok: true; readonly record: SessionRecord }
  | { readonly ok: false; readonly reason: string };

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly mainOwnedEnvironmentNames = new Set([
    'EZTERMINAL_SESSION_ID',
    'EZTERMINAL_AGENT_HOOK_DESCRIPTOR',
  ]);

  /**
   * @param newId       mints a fresh, unique session id (production: crypto.randomUUID).
   * @param defaultCwd  the cwd a session starts at when `create(cwd?)` omits one.
   */
  constructor(
    private readonly newId: () => string,
    private readonly defaultCwd: () => string = () => process.cwd(),
  ) {}

  /** Create a new session with its own durable state; returns the authoritative id + cwd (B5). */
  create(cwd?: string): SessionInfo {
    return this.createWithId(this.newId(), cwd ?? this.defaultCwd());
  }

  /** Recreate one broker-owned identity after a utility-process restart. Only
   * durable location survives: active executions and mutable shell state died
   * with the old process and intentionally start clean. */
  restore(sessionId: string, cwd: string): SessionInfo {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`);
    }
    return this.createWithId(sessionId, cwd);
  }

  private createWithId(sessionId: string, cwd: string): SessionInfo {
    const shell = new ShellSession(cwd);
    for (const name of this.mainOwnedEnvironmentNames) shell.maskEnv(name);
    this.sessions.set(sessionId, {
      shell,
      state: 'live',
      executions: new Set(),
      activeRun: null,
    });
    return { sessionId, cwd: shell.cwd };
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** Apply main-owned environment values before the first run in a newly
   * created session. Unknown or already-destroyed sessions are ignored. */
  setEnvironment(sessionId: string, environment: Readonly<Record<string, string>>): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.state !== 'live') return;
    for (const [name, value] of Object.entries(environment)) {
      this.mainOwnedEnvironmentNames.add(name);
      for (const [candidateId, candidate] of this.sessions) {
        if (candidateId !== sessionId) candidate.shell.maskEnv(name);
      }
      record.shell.setEnv(name, value);
    }
  }

  /** Idempotent teardown: abort + dispose every in-flight run, then drop the record (B2/B6). */
  destroy(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.state = 'destroying';
    for (const execution of record.executions) {
      execution.abort();
      execution.dispose();
    }
    record.executions.clear();
    record.activeRun = null;
    this.sessions.delete(sessionId);
  }

  /** Gate a run: reject an unknown/destroyed session (B1) or one already busy (B4). */
  canRun(sessionId: string): RunGate {
    const record = this.sessions.get(sessionId);
    if (!record || record.state !== 'live') {
      return { ok: false, reason: `session ${sessionId} does not exist` };
    }
    if (record.activeRun) {
      return { ok: false, reason: 'a command is already running in this session' };
    }
    return { ok: true, record };
  }

  /** Mark `execution` as the session's active foreground run + track it for teardown. */
  begin(record: SessionRecord, execution: Execution): void {
    record.executions.add(execution);
    record.activeRun = execution;
  }

  /**
   * The run reached its terminal frame: free the session's foreground slot so the next
   * command can start (B4), but KEEP the execution tracked — its port stays open for
   * paging and must still be torn down by {@link destroy} if the pane closes (B6).
   */
  settle(record: SessionRecord, execution: Execution): void {
    if (record.activeRun === execution) record.activeRun = null;
  }

  /** The execution was disposed (port closed): drop it from teardown tracking. */
  remove(record: SessionRecord, execution: Execution): void {
    record.executions.delete(execution);
    if (record.activeRun === execution) record.activeRun = null;
  }

  /** Number of live sessions (introspection / tests). */
  get size(): number {
    return this.sessions.size;
  }
}
