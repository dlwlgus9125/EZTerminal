import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { createWorkspaceWorktree, pathIsWithin } from './workspace-worktree-actions';

const root = path.resolve('repo');
const tree = path.resolve('repo-worktrees', 'feature');

function deps(projects: Array<{ id: string; rootPath: string }>, after: Array<{ id: string; projectId: string; rootPath: string }>) {
  let snapshot = { projects, workspaces: [] } as unknown as DaemonSnapshot;
  const worktrees = { execute: vi.fn(async () => ({ ok: true, action: 'create', worktrees: [], opened: { path: tree } })) };
  const syncProjects = vi.fn(async () => {
    snapshot = { projects, workspaces: after.map((entry) => ({ ...entry, kind: 'worktree' })) } as unknown as DaemonSnapshot;
  });
  return { worktrees: worktrees as never, getSnapshot: () => snapshot, syncProjects, execute: worktrees.execute };
}

describe('createWorkspaceWorktree', () => {
  it('finds the workspace of a project that is a subfolder of its repository', async () => {
    const d = deps([{ id: 'web', rootPath: path.join(root, 'apps', 'web') }], [{ id: 'web-tree', projectId: 'web', rootPath: path.join(tree, 'apps', 'web') }]);
    expect(await createWorkspaceWorktree(d, 'web', 'feature/login')).toEqual({ ok: true, value: { workspaceId: 'web-tree', path: path.join(tree, 'apps', 'web'), branch: 'feature/login' } });
    expect(d.execute).toHaveBeenCalledWith({ action: 'create', cwd: path.join(root, 'apps', 'web'), branch: 'feature/login', allowDirtyBase: true }, 'desktop');
  });

  it('answers with the asking project’s workspace when two projects share the repository', async () => {
    const d = deps([{ id: 'api', rootPath: path.join(root, 'api') }, { id: 'web', rootPath: path.join(root, 'web') }], [
      { id: 'web-tree', projectId: 'web', rootPath: path.join(tree, 'web') },
      { id: 'api-tree', projectId: 'api', rootPath: path.join(tree, 'api') },
    ]);
    expect(await createWorkspaceWorktree(d, 'api', 'feature/login')).toMatchObject({ ok: true, value: { workspaceId: 'api-tree' } });
  });

  it('refuses unknown projects and unsafe branch names before touching git', async () => {
    const d = deps([{ id: 'p', rootPath: root }], []);
    expect(await createWorkspaceWorktree(d, 'missing', 'feature')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await createWorkspaceWorktree(d, 'p', '--upload-pack=x')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it('treats a folder and what is inside it as the same place, and nothing beside it', () => {
    expect(pathIsWithin(tree, tree)).toBe(true);
    expect(pathIsWithin(path.join(tree, 'web'), tree)).toBe(true);
    expect(pathIsWithin(`${tree}-other`, tree)).toBe(false);
  });
});
