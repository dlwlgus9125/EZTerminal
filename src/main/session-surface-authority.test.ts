import { describe, expect, it, vi } from 'vitest';

import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
  SessionInfo,
} from '../shared/ipc';
import { SessionSurfaceAuthority, type SessionSurfaceBroker } from './session-surface-authority';

class FakeBroker implements SessionSurfaceBroker {
  readonly sessions = new Map<string, SessionInfo>();
  readonly removed = new Set<(sessionId: string) => void>();
  readonly createSession = vi.fn(async (cwd?: string): Promise<SessionInfo> => {
    const session = { sessionId: `session-${this.sessions.size + 1}`, cwd: cwd ?? '/home' };
    this.sessions.set(session.sessionId, session);
    return session;
  });
  readonly destroySessionsGuarded = vi.fn(
    async (requests: readonly GuardedSessionDestroyRequest[]): Promise<DestroySessionGuardResult> => {
      for (const request of requests) this.remove(request.sessionId);
      return { ok: true };
    },
  );
  readonly destroySessionGuarded = vi.fn(
    async (sessionId: string): Promise<DestroySessionGuardResult> => {
      this.remove(sessionId);
      return { ok: true };
    },
  );

  listSessions(): readonly SessionInfo[] {
    return [...this.sessions.values()];
  }

  onSessionRemoved(listener: (sessionId: string) => void): () => void {
    this.removed.add(listener);
    return () => this.removed.delete(listener);
  }

  add(session: SessionInfo): void {
    this.sessions.set(session.sessionId, session);
  }

  remove(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    for (const listener of this.removed) listener(sessionId);
  }
}

function ids(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function authority(broker = new FakeBroker()): {
  readonly broker: FakeBroker;
  readonly authority: SessionSurfaceAuthority;
} {
  return {
    broker,
    authority: new SessionSurfaceAuthority(broker, { newId: ids(), preparedCloseTtlMs: 10_000 }),
  };
}

async function openOwner(
  value: SessionSurfaceAuthority,
  principalId = 'client-1',
  surfaceId = 'surface-1',
) {
  value.connectClient(principalId);
  const result = await value.openSessionSurface(principalId, surfaceId, { kind: 'create' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected owner binding');
  return result.binding;
}

describe('SessionSurfaceAuthority open/bind lifecycle', () => {
  it('creates exactly once for an idempotent surface request', async () => {
    const h = authority();
    h.authority.connectClient('client-1');

    const first = h.authority.openSessionSurface('client-1', 'surface-1', { kind: 'create', cwd: '/repo' });
    const second = h.authority.openSessionSurface('client-1', 'surface-1', { kind: 'create', cwd: '/repo' });

    await expect(first).resolves.toMatchObject({ ok: true, binding: { role: 'owner' } });
    await expect(second).resolves.toEqual(await first);
    expect(h.broker.createSession).toHaveBeenCalledOnce();
  });

  it('resolves project locations in the host immediately before creating the shell', async () => {
    const broker = new FakeBroker();
    const resolveProjectTarget = vi.fn(async () => ({ ok: true as const, cwd: '/approved/worktree' }));
    const value = new SessionSurfaceAuthority(broker, {
      newId: ids(),
      resolveProjectTarget,
    });
    value.connectClient('client-1');

    await expect(value.openSessionSurface('client-1', 'project-surface', {
      kind: 'create-project',
      target: { projectId: 'project-1', rootId: 'root-1', workspaceId: 'worktree-1' },
    })).resolves.toMatchObject({
      ok: true,
      binding: { role: 'owner', session: { cwd: '/approved/worktree' } },
    });
    expect(resolveProjectTarget).toHaveBeenCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'worktree-1',
    });
    expect(broker.createSession).toHaveBeenCalledWith('/approved/worktree');
  });

  it('fails a revoked project location without falling back to the default cwd', async () => {
    const broker = new FakeBroker();
    const value = new SessionSurfaceAuthority(broker, {
      newId: ids(),
      resolveProjectTarget: vi.fn(async () => ({
        ok: false as const,
        error: 'authorization-required' as const,
      })),
    });
    value.connectClient('client-1');

    await expect(value.openSessionSurface('client-1', 'project-surface', {
      kind: 'create-project',
      target: { projectId: 'project-1', rootId: 'root-1', workspaceId: 'external-1' },
    })).resolves.toEqual({ ok: false, reason: 'forbidden' });
    expect(broker.createSession).not.toHaveBeenCalled();
  });

  it('rejects a conflicting intent for the same exact surface', async () => {
    const h = authority();
    h.authority.connectClient('client-1');
    const pending = h.authority.openSessionSurface('client-1', 'surface-1', { kind: 'create' });

    await expect(h.authority.openSessionSurface('client-1', 'surface-1', {
      kind: 'adopt', sessionId: 'other',
    })).resolves.toEqual({ ok: false, reason: 'state-changed' });
    await pending;
  });

  it('adopts an existing session, rejects a missing adopt, and creates only for restore', async () => {
    const h = authority();
    h.broker.add({ sessionId: 'existing', cwd: '/existing' });
    h.authority.connectClient('client-1');

    await expect(h.authority.openSessionSurface('client-1', 'adopted', {
      kind: 'adopt', sessionId: 'existing',
    })).resolves.toMatchObject({ ok: true, binding: { role: 'adopted' } });
    await expect(h.authority.openSessionSurface('client-1', 'missing', {
      kind: 'adopt', sessionId: 'missing',
    })).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(h.authority.openSessionSurface('client-1', 'restored', {
      kind: 'restore', sessionId: 'missing', cwd: '/restored',
    })).resolves.toMatchObject({
      ok: true,
      binding: { role: 'owner', session: { cwd: '/restored' } },
    });
    expect(h.broker.createSession).toHaveBeenCalledOnce();
  });

  it('leaves an in-flight creation in the background when its client disconnects', async () => {
    const h = authority();
    let resolveCreate!: (session: SessionInfo) => void;
    h.broker.createSession.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = (session) => {
        h.broker.add(session);
        resolve(session);
      };
    }));
    h.authority.connectClient('old', 'android:install-1');
    const opening = h.authority.openSessionSurface('old', 'surface-1', { kind: 'create' });
    await Promise.resolve();

    h.authority.disconnectClient('old');
    resolveCreate({ sessionId: 'late', cwd: '/late' });

    await expect(opening).resolves.toEqual({ ok: false, reason: 'state-changed' });
    expect(h.broker.sessions.has('late')).toBe(true);
    h.authority.connectClient('new', 'android:install-1');
    await expect(h.authority.openSessionSurface('new', 'surface-2', {
      kind: 'adopt', sessionId: 'late',
    })).resolves.toMatchObject({ ok: true, binding: { role: 'adopted' } });
  });

  it('a newer continuity generation releases the older binding without destroying it', async () => {
    const h = authority();
    h.authority.connectClient('old', 'desktop:1');
    const opened = await h.authority.openSessionSurface('old', 'surface-1', { kind: 'create' });
    if (!opened.ok) throw new Error('expected owner');

    h.authority.connectClient('new', 'desktop:1');

    expect(h.broker.destroySessionsGuarded).not.toHaveBeenCalled();
    expect(h.authority.releaseSessionSurface('old', opened.binding.bindingId)).toEqual({
      ok: false, reason: 'state-changed',
    });
  });
});

describe('SessionSurfaceAuthority close transactions', () => {
  it('guard-destroys an owner and consumes the close token once', async () => {
    const h = authority();
    const binding = await openOwner(h.authority);
    const prepared = h.authority.prepareSessionSurfaceClose('client-1', [{
      bindingId: binding.bindingId,
      expectedActiveRunIds: ['run-b', 'run-a', 'run-a'],
    }]);
    if (!prepared.ok) throw new Error('expected close preparation');

    await expect(h.authority.commitSessionSurfaceClose('client-1', prepared.prepared.closeToken, [{
      bindingId: binding.bindingId,
      disposition: 'terminate',
    }])).resolves.toEqual({ ok: true, keptSessionIds: [] });
    expect(h.broker.destroySessionsGuarded).toHaveBeenCalledWith([{
      sessionId: binding.session.sessionId,
      expectedActiveRunIds: ['run-a', 'run-b'],
    }]);
    await expect(h.authority.commitSessionSurfaceClose('client-1', prepared.prepared.closeToken, [{
      bindingId: binding.bindingId,
      disposition: 'terminate',
    }])).resolves.toEqual({ ok: false, reason: 'state-changed' });
  });

  it('keeps an owner without contacting the interpreter', async () => {
    const h = authority();
    const binding = await openOwner(h.authority);
    const prepared = h.authority.prepareSessionSurfaceClose('client-1', [{
      bindingId: binding.bindingId,
      expectedActiveRunIds: ['run-1'],
    }]);
    if (!prepared.ok) throw new Error('expected close preparation');

    await expect(h.authority.commitSessionSurfaceClose('client-1', prepared.prepared.closeToken, [{
      bindingId: binding.bindingId,
      disposition: 'keep',
    }])).resolves.toEqual({ ok: true, keptSessionIds: [binding.session.sessionId] });
    expect(h.broker.destroySessionsGuarded).not.toHaveBeenCalled();
  });

  it('detaches adopted views without owner decisions', async () => {
    const h = authority();
    h.broker.add({ sessionId: 'existing', cwd: '/repo' });
    h.authority.connectClient('client-1');
    const opened = await h.authority.openSessionSurface('client-1', 'surface-1', {
      kind: 'adopt', sessionId: 'existing',
    });
    if (!opened.ok) throw new Error('expected adopted binding');
    const prepared = h.authority.prepareSessionSurfaceClose('client-1', [{
      bindingId: opened.binding.bindingId,
      expectedActiveRunIds: [],
    }]);
    if (!prepared.ok) throw new Error('expected close preparation');

    await expect(h.authority.commitSessionSurfaceClose(
      'client-1', prepared.prepared.closeToken, [],
    )).resolves.toEqual({ ok: true, keptSessionIds: [] });
    expect(h.broker.sessions.has('existing')).toBe(true);
  });

  it('fails atomically when the broker reports a changed run set', async () => {
    const h = authority();
    const first = await openOwner(h.authority, 'client-1', 'surface-1');
    const second = await openOwner(h.authority, 'client-1', 'surface-2');
    h.broker.destroySessionsGuarded.mockResolvedValueOnce({ ok: false, reason: 'state-changed' });
    const prepared = h.authority.prepareSessionSurfaceClose('client-1', [first, second].map((binding) => ({
      bindingId: binding.bindingId,
      expectedActiveRunIds: [],
    })));
    if (!prepared.ok) throw new Error('expected close preparation');

    await expect(h.authority.commitSessionSurfaceClose('client-1', prepared.prepared.closeToken, [
      { bindingId: first.bindingId, disposition: 'terminate' },
      { bindingId: second.bindingId, disposition: 'terminate' },
    ])).resolves.toEqual({ ok: false, reason: 'state-changed' });
    expect(h.broker.sessions.size).toBe(2);
  });

  it('rejects cross-principal close capabilities', async () => {
    const h = authority();
    const binding = await openOwner(h.authority);
    h.authority.connectClient('client-2');

    expect(h.authority.prepareSessionSurfaceClose('client-2', [{
      bindingId: binding.bindingId,
      expectedActiveRunIds: [],
    }])).toEqual({ ok: false, reason: 'forbidden' });
    expect(h.authority.releaseSessionSurface('client-2', binding.bindingId)).toEqual({
      ok: false, reason: 'forbidden',
    });
  });

  it('keeps explicit session-manager termination independent of ownership', async () => {
    const h = authority();
    const binding = await openOwner(h.authority);

    await expect(h.authority.terminateSessionGuarded(
      binding.session.sessionId, ['run-1'],
    )).resolves.toEqual({ ok: true });
    expect(h.broker.destroySessionGuarded).toHaveBeenCalledWith(
      binding.session.sessionId, ['run-1'],
    );
  });
});
