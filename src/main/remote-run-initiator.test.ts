import { describe, expect, it, vi } from 'vitest';

import {
  RemoteRunInitiatorRegistry,
  type RemoteRunLifecycleSource,
} from './remote-run-initiator';
import type { SessionRunIdentity } from './session-worktree-guard';

class FakeLifecycle implements RemoteRunLifecycleSource {
  private readonly settled = new Set<(identity: SessionRunIdentity) => void>();
  private readonly removed = new Set<(sessionId: string) => void>();
  private readonly exited = new Set<(code?: number) => void>();

  onRunSettled(listener: (identity: SessionRunIdentity) => void): () => void {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }

  onSessionRemoved(listener: (sessionId: string) => void): () => void {
    this.removed.add(listener);
    return () => this.removed.delete(listener);
  }

  onInterpreterExited(listener: (code?: number) => void): () => void {
    this.exited.add(listener);
    return () => this.exited.delete(listener);
  }

  settle(identity: SessionRunIdentity): void {
    for (const listener of this.settled) listener(identity);
  }

  removeSession(sessionId: string): void {
    for (const listener of this.removed) listener(sessionId);
  }

  exit(code?: number): void {
    for (const listener of this.exited) listener(code);
  }
}

describe('RemoteRunInitiatorRegistry', () => {
  it('exposes an active run only to the authenticated installation that initiated it', () => {
    const registry = new RemoteRunInitiatorRegistry(new FakeLifecycle());
    registry.remember('session-1', 'run-1', 'client-a');

    expect(registry.isInitiatedBy('session-1', 'run-1', 'client-a')).toBe(true);
    expect(registry.isInitiatedBy('session-1', 'run-1', 'client-b')).toBe(false);
    expect(registry.isInitiatedBy('other-session', 'run-1', 'client-a')).toBe(false);
  });

  it('forgets only the exact settled run identity', () => {
    const lifecycle = new FakeLifecycle();
    const registry = new RemoteRunInitiatorRegistry(lifecycle);
    registry.remember('session-1', 'run-1', 'client-a');
    registry.remember('session-2', 'run-2', 'client-b');

    lifecycle.settle({ sessionId: 'other-session', runId: 'run-1' });
    expect(registry.isInitiatedBy('session-1', 'run-1', 'client-a')).toBe(true);

    lifecycle.settle({ sessionId: 'session-1', runId: 'run-1' });
    expect(registry.isInitiatedBy('session-1', 'run-1', 'client-a')).toBe(false);
    expect(registry.isInitiatedBy('session-2', 'run-2', 'client-b')).toBe(true);
  });

  it('cleans session and interpreter lifecycles and can explicitly relinquish one run', () => {
    const lifecycle = new FakeLifecycle();
    const registry = new RemoteRunInitiatorRegistry(lifecycle);
    registry.remember('session-1', 'run-1', 'client-a');
    registry.remember('session-1', 'run-2', 'client-a');
    registry.remember('session-2', 'run-3', 'client-b');

    registry.forget('session-1', 'run-1');
    registry.forgetClient('client-a');
    lifecycle.removeSession('session-1');
    expect(registry.isInitiatedBy('session-1', 'run-1', 'client-a')).toBe(false);
    expect(registry.isInitiatedBy('session-1', 'run-2', 'client-a')).toBe(false);
    expect(registry.isInitiatedBy('session-2', 'run-3', 'client-b')).toBe(true);

    lifecycle.exit(1);
    expect(registry.size).toBe(0);
  });

  it('unsubscribes and clears idempotently on disposal', () => {
    const lifecycle = new FakeLifecycle();
    const registry = new RemoteRunInitiatorRegistry(lifecycle);
    const clear = vi.spyOn(registry, 'clear');
    registry.remember('session-1', 'run-1', 'client-a');

    registry.dispose();
    registry.dispose();
    lifecycle.exit(1);

    expect(registry.size).toBe(0);
    expect(clear).toHaveBeenCalledOnce();
  });
});
