import path from 'node:path';

import { isSafeLocalBranch } from '../shared/agent-coordination';
import type { DaemonSnapshot, DaemonWorkspace } from '../shared/daemon-protocol';
import type { WorkspaceWorktreeIpcResult } from '../shared/workspace-worktree';
import type { WorktreeService } from './worktree-service';

/** What both the desktop and an agent need to create a worktree workspace. */
export interface WorkspaceWorktreeActionDeps {
  readonly worktrees: Pick<WorktreeService, 'execute'>;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  /** Registers new worktrees with the daemon so they become workspaces. */
  readonly syncProjects: () => Promise<void>;
}

export interface CreatedWorkspaceWorktree {
  readonly workspaceId: string;
  readonly path: string;
  readonly branch: string;
}

const normalized = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The folder itself or anything inside it (a project can be a subfolder of its repository). */
export function pathIsWithin(candidate: string, folder: string): boolean {
  const inner = normalized(candidate);
  const outer = normalized(folder);
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);
}

/** The project's worktree workspace that lives in this worktree folder. */
export function workspaceInWorktree(snapshot: DaemonSnapshot, projectId: string, worktreePath: string): DaemonWorkspace | undefined {
  return snapshot.workspaces.find((entry) => entry.projectId === projectId && entry.kind === 'worktree'
    && !entry.archivedAt && pathIsWithin(entry.rootPath, worktreePath));
}

/**
 * A new branch in its own worktree next to the project's checkout, registered with the daemon.
 * It starts from the main checkout's commit; uncommitted changes there stay where they are.
 */
export async function createWorkspaceWorktree(
  deps: WorkspaceWorktreeActionDeps,
  projectId: unknown,
  branch: unknown,
): Promise<WorkspaceWorktreeIpcResult<CreatedWorkspaceWorktree>> {
  const snapshot = deps.getSnapshot();
  const project = snapshot && typeof projectId === 'string'
    ? snapshot.projects.find((entry) => entry.id === projectId && !entry.archivedAt)
    : undefined;
  if (!project?.rootPath) return { ok: false, reason: 'not-found', message: 'This project is no longer available.' };
  if (!isSafeLocalBranch(branch)) return { ok: false, reason: 'invalid', message: 'Use letters, numbers and . _ / - for the branch name.' };
  const created = await deps.worktrees.execute({ action: 'create', cwd: project.rootPath, branch, allowDirtyBase: true }, 'desktop');
  if (!created.ok || !created.opened) {
    return { ok: false, reason: 'git-failed', message: created.ok ? 'The worktree was not created.' : created.message };
  }
  await deps.syncProjects();
  const current = deps.getSnapshot();
  const workspace = current ? workspaceInWorktree(current, project.id, created.opened.path) : undefined;
  return workspace
    ? { ok: true, value: { workspaceId: workspace.id, path: workspace.rootPath, branch } }
    : { ok: false, reason: 'not-found', message: `The worktree was created at ${created.opened.path} but is not listed yet.` };
}
