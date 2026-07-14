/**
 * Synchronous run/removal barrier shared by InterpreterBroker and
 * WorktreeService. JavaScript executes each state transition atomically:
 * a run either acquires its lease before removal starts, or is rejected while
 * the destructive boundary is held.
 */

export interface SessionRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

export class SessionWorktreeGuard {
  private readonly activeRuns = new Map<string, string>();
  private removalInProgress = false;

  tryBeginRun(identity: SessionRunIdentity): boolean {
    if (this.removalInProgress || this.activeRuns.has(identity.runId)) return false;
    this.activeRuns.set(identity.runId, identity.sessionId);
    return true;
  }

  /** Releases only an exact owner and reports whether the identity matched. */
  finishRun(identity: SessionRunIdentity): boolean {
    if (this.activeRuns.get(identity.runId) !== identity.sessionId) return false;
    this.activeRuns.delete(identity.runId);
    return true;
  }

  finishSession(sessionId: string): void {
    for (const [runId, ownerSessionId] of this.activeRuns) {
      if (ownerSessionId === sessionId) this.activeRuns.delete(runId);
    }
  }

  clearRuns(): void {
    this.activeRuns.clear();
  }

  hasConflictingActiveRun(exempt?: SessionRunIdentity): boolean {
    for (const [runId, sessionId] of this.activeRuns) {
      if (exempt && exempt.runId === runId && exempt.sessionId === sessionId) continue;
      return true;
    }
    return false;
  }

  async withRemovalBarrier<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.removalInProgress) {
      throw new Error('a worktree removal is already in progress');
    }
    this.removalInProgress = true;
    try {
      return await operation();
    } finally {
      this.removalInProgress = false;
    }
  }
}
