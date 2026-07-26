import type { SessionRunIdentity } from './session-worktree-guard';

export interface RemoteRunLifecycleSource {
  onRunSettled(listener: (identity: SessionRunIdentity) => void): () => void;
  onSessionRemoved(listener: (sessionId: string) => void): () => void;
  onInterpreterExited(listener: (code?: number) => void): () => void;
}

interface InitiatorRecord {
  readonly sessionId: string;
  readonly clientId: string;
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

/**
 * Remembers which authenticated mobile installation initiated an active run.
 *
 * This identity deliberately has the run's lifetime, not the five-minute
 * MessagePort lease lifetime. The lifecycle source provides exact cleanup so
 * a stale client id can never be inherited by a later run reusing an id.
 */
export class RemoteRunInitiatorRegistry {
  private readonly initiators = new Map<string, InitiatorRecord>();
  private readonly unsubscribe: readonly (() => void)[];
  private disposed = false;

  constructor(lifecycle: RemoteRunLifecycleSource) {
    this.unsubscribe = [
      lifecycle.onRunSettled((identity) => this.forget(identity.sessionId, identity.runId)),
      lifecycle.onSessionRemoved((sessionId) => this.forgetSession(sessionId)),
      lifecycle.onInterpreterExited(() => this.clear()),
    ];
  }

  remember(sessionId: string, runId: string, clientId: string): void {
    this.initiators.set(runKey(sessionId, runId), { sessionId, clientId });
  }

  isInitiatedBy(sessionId: string, runId: string, clientId: string): boolean {
    return this.initiators.get(runKey(sessionId, runId))?.clientId === clientId;
  }

  forget(sessionId: string, runId: string): void {
    this.initiators.delete(runKey(sessionId, runId));
  }

  forgetSession(sessionId: string): void {
    for (const [key, record] of this.initiators) {
      if (record.sessionId === sessionId) this.initiators.delete(key);
    }
  }

  forgetClient(clientId: string): void {
    for (const [key, record] of this.initiators) {
      if (record.clientId === clientId) this.initiators.delete(key);
    }
  }

  clear(): void {
    this.initiators.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.clear();
  }

  get size(): number {
    return this.initiators.size;
  }
}
