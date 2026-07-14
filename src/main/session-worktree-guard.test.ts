import { describe, expect, it } from 'vitest';

import { SessionWorktreeGuard } from './session-worktree-guard';

describe('SessionWorktreeGuard', () => {
  it('atomically blocks new runs for the whole removal boundary', async () => {
    const guard = new SessionWorktreeGuard();
    let release: (() => void) | undefined;
    const removal = guard.withRemovalBarrier(async () => {
      expect(guard.tryBeginRun({ sessionId: 'session-late', runId: 'run-late' })).toBe(false);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await Promise.resolve();
    expect(guard.tryBeginRun({ sessionId: 'session-racing', runId: 'run-racing' })).toBe(false);
    release?.();
    await removal;
    expect(guard.tryBeginRun({ sessionId: 'session-after', runId: 'run-after' })).toBe(true);
  });

  it('exempts only the exact initiating run and clears settled leases', () => {
    const guard = new SessionWorktreeGuard();
    const initiating = { sessionId: 'session-1', runId: 'run-1' };
    expect(guard.tryBeginRun(initiating)).toBe(true);
    expect(guard.hasConflictingActiveRun(initiating)).toBe(false);
    expect(guard.hasConflictingActiveRun({ sessionId: 'other-session', runId: 'run-1' })).toBe(true);
    expect(guard.tryBeginRun({ sessionId: 'session-2', runId: 'run-2' })).toBe(true);
    expect(guard.hasConflictingActiveRun(initiating)).toBe(true);
    guard.finishRun({ sessionId: 'wrong-owner', runId: 'run-2' });
    expect(guard.hasConflictingActiveRun(initiating)).toBe(true);
    guard.finishRun({ sessionId: 'session-2', runId: 'run-2' });
    expect(guard.hasConflictingActiveRun(initiating)).toBe(false);
    guard.finishSession('session-1');
    expect(guard.hasConflictingActiveRun()).toBe(false);
  });
});
