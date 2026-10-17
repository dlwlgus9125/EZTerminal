import { describe, expect, it, vi } from 'vitest';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { installWorkspaceWorktreeIpc } from './workspace-worktree-ipc';
import type { WorkspaceWorktreeService } from './workspace-worktree-service';

const project = { id: 'P', rootPath: 'C:/repo' };
const worktree = { id: 'W', projectId: 'P', kind: 'worktree', rootPath: 'C:/repo-wt/feature' };

function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); }), removeHandler: vi.fn((name: string) => { handlers.delete(name); }) };
  let snapshot = { projects: [project], workspaces: [{ id: 'L', projectId: 'P', kind: 'local', rootPath: 'C:/repo' }] } as unknown as DaemonSnapshot;
  const worktrees = { execute: vi.fn(async () => ({ ok: true, action: 'create', opened: { path: 'C:/repo-wt/feature' } })) };
  const service = {
    status: vi.fn(async (target: { workspaceId: string }) => ({ workspaceId: target.workspaceId, dirty: false, ahead: 1, merged: false, status: 'review' })),
    commit: vi.fn(async () => ({ ok: true, value: { commit: 'abc' } })),
    merge: vi.fn(async () => ({ ok: true, value: { into: 'main', commit: 'def' } })),
  };
  // The new worktree becomes a workspace once the projects are synced.
  const syncProjects = vi.fn(async () => { snapshot = { ...snapshot, workspaces: [...snapshot.workspaces, worktree] } as unknown as DaemonSnapshot; });
  const dispose = installWorkspaceWorktreeIpc({ ipc: ipc as never, worktrees: worktrees as never, service: service as unknown as WorkspaceWorktreeService, getSnapshot: () => snapshot, syncProjects });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(`workspace-worktrees:${channel}`)!({}, ...args);
  const snapshotAdd = (workspace: object) => { snapshot = { ...snapshot, workspaces: [...snapshot.workspaces, workspace] } as unknown as DaemonSnapshot; };
  return { handlers, worktrees, service, syncProjects, dispose, invoke, snapshotAdd };
}

describe('workspace worktree IPC', () => {
  it('creates a worktree from the main checkout and answers with its workspace after the sync', async () => {
    const f = fixture();
    expect(await f.invoke('create', 'P', 'feature/login')).toEqual({ ok: true, value: { workspaceId: 'W' } });
    expect(f.worktrees.execute).toHaveBeenCalledWith({ action: 'create', cwd: 'C:/repo', branch: 'feature/login', allowDirtyBase: true }, 'desktop');
    expect(f.syncProjects).toHaveBeenCalledOnce();
  });

  it('refuses unsafe branch names and unknown projects before touching git', async () => {
    const f = fixture();
    expect(await f.invoke('create', 'P', '--upload-pack=evil')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await f.invoke('create', 'missing', 'feature')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(f.worktrees.execute).not.toHaveBeenCalled();
  });

  it('reads, commits and merges only worktree workspaces', async () => {
    const f = fixture();
    await f.invoke('create', 'P', 'feature/login');
    expect(await f.invoke('status', 'P')).toEqual({ ok: true, value: [expect.objectContaining({ workspaceId: 'W', status: 'review' })] });
    expect(f.service.status).toHaveBeenCalledWith({ workspaceId: 'W', rootPath: 'C:/repo-wt/feature', mainRoot: 'C:/repo' });
    expect(await f.invoke('commit', 'W', 'Tidy copy')).toEqual({ ok: true, value: { commit: 'abc' } });
    expect(await f.invoke('merge', 'W')).toEqual({ ok: true, value: { into: 'main', commit: 'def' } });
    // The local checkout is not something to merge.
    expect(await f.invoke('merge', 'L')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await f.invoke('commit', 'W', 42)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(f.service.merge).toHaveBeenCalledOnce();
  });

  it('leaves the task worktrees of a planning run to the run', async () => {
    const f = fixture();
    await f.invoke('create', 'P', 'feature/login');
    f.snapshotAdd({ id: 'planning-workspace-abc', projectId: 'P', kind: 'worktree', rootPath: 'C:/repo-wt/attempt' });
    expect(await f.invoke('merge', 'planning-workspace-abc')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await f.invoke('commit', 'planning-workspace-abc', 'x')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await f.invoke('status', 'P')).toEqual({ ok: true, value: [expect.objectContaining({ workspaceId: 'W' })] });
    expect(f.service.merge).not.toHaveBeenCalled();
  });

  it('removes its handlers', () => {
    const f = fixture();
    f.dispose();
    expect(f.handlers.size).toBe(0);
  });
});
