import type { IpcMain } from 'electron';

import { isSafeLocalBranch } from '../shared/agent-coordination';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { isRunOwnedWorkspace, type WorkspaceWorktreeIpcResult } from '../shared/workspace-worktree';
import type { WorkspaceWorktreeService, WorkspaceWorktreeTarget } from './workspace-worktree-service';
import type { WorktreeService } from './worktree-service';

const samePath = (left: string, right: string): boolean => (
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
);

/**
 * Desktop-only worktree workspaces: create one for a project, read where each
 * stands, commit its changes and merge it into the main checkout's branch.
 */
export function installWorkspaceWorktreeIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly worktrees: Pick<WorktreeService, 'execute'>;
  readonly service: WorkspaceWorktreeService;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  /** Registers new worktrees with the daemon so they become workspaces. */
  readonly syncProjects: () => Promise<void>;
}): () => void {
  const { ipc, worktrees, service, getSnapshot, syncProjects } = input;
  const mainRootOf = (snapshot: DaemonSnapshot, projectId: string): string | undefined => {
    const project = snapshot.projects.find((entry) => entry.id === projectId);
    return project?.rootPath;
  };
  const targetOf = (workspaceId: unknown): WorkspaceWorktreeTarget | undefined => {
    if (typeof workspaceId !== 'string' || workspaceId.length > 200) return undefined;
    const snapshot = getSnapshot();
    const workspace = snapshot?.workspaces.find((entry) => entry.id === workspaceId && entry.kind === 'worktree' && !entry.archivedAt && !isRunOwnedWorkspace(entry.id));
    const mainRoot = workspace && snapshot ? mainRootOf(snapshot, workspace.projectId) : undefined;
    return workspace && mainRoot ? { workspaceId: workspace.id, rootPath: workspace.rootPath, mainRoot } : undefined;
  };
  const missing: WorkspaceWorktreeIpcResult<never> = { ok: false, reason: 'not-found', message: 'This worktree workspace is no longer available.' };

  ipc.handle('workspace-worktrees:create', async (_event, projectId: unknown, branch: unknown): Promise<WorkspaceWorktreeIpcResult<{ readonly workspaceId: string }>> => {
    const snapshot = getSnapshot();
    const mainRoot = snapshot && typeof projectId === 'string' ? mainRootOf(snapshot, projectId) : undefined;
    if (!mainRoot) return { ok: false, reason: 'not-found', message: 'This project is no longer available.' };
    if (!isSafeLocalBranch(branch)) return { ok: false, reason: 'invalid', message: 'Use letters, numbers and . _ / - for the branch name.' };
    // The worktree starts from the main checkout's commit; its uncommitted changes stay where they are.
    const created = await worktrees.execute({ action: 'create', cwd: mainRoot, branch, allowDirtyBase: true }, 'desktop');
    if (!created.ok || !created.opened) {
      return { ok: false, reason: 'git-failed', message: created.ok ? 'The worktree was not created.' : created.message };
    }
    await syncProjects();
    const workspace = getSnapshot()?.workspaces.find((entry) => entry.kind === 'worktree' && samePath(entry.rootPath, created.opened!.path));
    return workspace
      ? { ok: true, value: { workspaceId: workspace.id } }
      : { ok: false, reason: 'not-found', message: `The worktree was created at ${created.opened.path} but is not listed yet.` };
  });

  ipc.handle('workspace-worktrees:status', async (_event, projectId: unknown) => {
    const snapshot = getSnapshot();
    if (!snapshot || typeof projectId !== 'string') return { ok: true, value: [] };
    const mainRoot = mainRootOf(snapshot, projectId);
    if (!mainRoot) return { ok: true, value: [] };
    const targets = snapshot.workspaces.filter((entry) => entry.projectId === projectId && entry.kind === 'worktree' && !entry.archivedAt && !isRunOwnedWorkspace(entry.id));
    const statuses = await Promise.all(targets.map((workspace) => service
      .status({ workspaceId: workspace.id, rootPath: workspace.rootPath, mainRoot })
      .catch(() => undefined)));
    return { ok: true, value: statuses.filter((status) => status !== undefined) };
  });

  ipc.handle('workspace-worktrees:commit', async (_event, workspaceId: unknown, message: unknown) => {
    const target = targetOf(workspaceId);
    if (!target) return missing;
    if (typeof message !== 'string') return { ok: false, reason: 'invalid', message: 'Write a commit message.' };
    return service.commit(target, message);
  });

  ipc.handle('workspace-worktrees:merge', async (_event, workspaceId: unknown) => {
    const target = targetOf(workspaceId);
    return target ? service.merge(target) : missing;
  });

  return () => {
    for (const channel of ['create', 'status', 'commit', 'merge']) ipc.removeHandler(`workspace-worktrees:${channel}`);
  };
}
