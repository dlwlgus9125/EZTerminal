import type { IpcMain } from 'electron';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { isRunOwnedWorkspace, type WorkspaceWorktreeIpcResult } from '../shared/workspace-worktree';
import type { WorkspaceWorktreeService, WorkspaceWorktreeTarget } from './workspace-worktree-service';
import type { WorktreeService } from './worktree-service';
import { createWorkspaceWorktree, removeWorkspaceWorktree } from './workspace-worktree-actions';

/**
 * Desktop-only worktree workspaces: create one for a project, read where each
 * stands, commit its changes, merge it into the main checkout's branch and
 * clean it up once merged.
 */
export function installWorkspaceWorktreeIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly worktrees: Pick<WorktreeService, 'execute'>;
  readonly service: Pick<WorkspaceWorktreeService, 'status' | 'commit' | 'merge' | 'deleteMergedBranch'>;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  /** Registers new worktrees with the daemon so they become workspaces. */
  readonly syncProjects: () => Promise<void>;
  /** Archives the chats of a worktree being cleaned up. */
  readonly executeCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  /** Waits (bounded) for archived chats to let go of their provider processes. */
  readonly releaseProviders: () => Promise<void>;
}): () => void {
  const { ipc, worktrees, service, getSnapshot, syncProjects, executeCommand, releaseProviders } = input;
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

  ipc.handle('workspace-worktrees:create', (_event, projectId: unknown, branch: unknown) => (
    createWorkspaceWorktree({ worktrees, getSnapshot, syncProjects }, projectId, branch)
  ));

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

  const removing = new Set<string>();
  ipc.handle('workspace-worktrees:remove', async (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || workspaceId.length > 200) return missing;
    if (removing.has(workspaceId)) return { ok: false, reason: 'in-use', message: 'This worktree is already being cleaned up.' };
    removing.add(workspaceId);
    try {
      return await removeWorkspaceWorktree({ worktrees, service, getSnapshot, syncProjects, executeCommand, releaseProviders }, workspaceId);
    } finally {
      removing.delete(workspaceId);
    }
  });

  return () => {
    for (const channel of ['create', 'status', 'commit', 'merge', 'remove']) ipc.removeHandler(`workspace-worktrees:${channel}`);
  };
}
