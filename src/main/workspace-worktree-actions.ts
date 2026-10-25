import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { isSafeLocalBranch } from '../shared/agent-coordination';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
  type DaemonWorkspace,
} from '../shared/daemon-protocol';
import {
  isRunOwnedWorkspace,
  worktreeCleanupScope,
  type RemovedWorkspaceWorktree,
  type WorkspaceWorktreeIpcResult,
} from '../shared/workspace-worktree';
import { gitMessage, type WorkspaceWorktreeService, type WorkspaceWorktreeStatus } from './workspace-worktree-service';
import type { WorktreeService } from './worktree-service';
import { folderHeld, onlyEmptyFolders, removeEmptyFolders } from './folder-cleanup';

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

/** What the desktop needs on top of creation to clean a worktree up. */
export interface WorkspaceWorktreeCleanupDeps extends WorkspaceWorktreeActionDeps {
  readonly service: Pick<WorkspaceWorktreeService, 'status' | 'deleteMergedBranch'>;
  /** Runs a daemon command; cleanup is the person's own action. */
  readonly executeCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  /** Resolves once archived chats have let go of their provider processes (bounded by the caller). */
  readonly releaseProviders: () => Promise<void>;
  /** The terminals whose process still runs (a terminal's record outlives it). */
  readonly liveTerminalIds: () => ReadonlySet<string>;
  readonly createId?: () => string;
  /** How long archived chats' processes (and the tools they started) get to let go of the folder. */
  readonly folderReleaseMs?: number;
}

/**
 * Removes a merged worktree. Its chats are archived first: they cannot go on without the folder,
 * and on Windows their provider processes keep it open. The folder is then removed through git
 * without force, the merged branch deleted, and the daemon forgets the workspace. Nothing is
 * touched unless the work is merged and clean and nothing runs there; a refusal leaves the
 * worktree as it was, so cleaning up again is safe. A worktree git already forgot (an earlier
 * cleanup was cut short) is finished off if nothing but empty folders is left of it.
 */
export async function removeWorkspaceWorktree(
  deps: WorkspaceWorktreeCleanupDeps,
  workspaceId: unknown,
): Promise<WorkspaceWorktreeIpcResult<RemovedWorkspaceWorktree>> {
  const snapshot = deps.getSnapshot();
  const workspace = typeof workspaceId === 'string'
    ? snapshot?.workspaces.find((entry) => entry.id === workspaceId && entry.kind === 'worktree' && !entry.archivedAt && !isRunOwnedWorkspace(entry.id))
    : undefined;
  const mainRoot = workspace ? snapshot?.projects.find((entry) => entry.id === workspace.projectId)?.rootPath : undefined;
  if (!snapshot || !workspace || !mainRoot) return { ok: false, reason: 'not-found', message: 'This worktree workspace is no longer available.' };
  const listed = await deps.worktrees.execute({ action: 'list', cwd: mainRoot }, 'desktop');
  if (!listed.ok) return { ok: false, reason: 'git-failed', message: listed.message };
  const worktree = listed.worktrees.find((entry) => !entry.main && pathIsWithin(workspace.rootPath, entry.path));
  const notes: string[] = [];
  let status: WorkspaceWorktreeStatus | undefined;
  if (worktree) {
    if (!worktree.managed || worktree.locked) return { ok: false, reason: 'invalid', message: 'Only unlocked worktrees EZTerminal created can be cleaned up here.' };
    // What the dialog showed is only a hint: ask git again.
    try {
      status = await deps.service.status({ workspaceId: workspace.id, rootPath: workspace.rootPath, mainRoot });
    } catch (error) {
      return { ok: false, reason: 'git-failed', message: gitMessage(error) };
    }
    if (status.dirty) return { ok: false, reason: 'dirty-worktree', message: 'The worktree has uncommitted changes. Commit and merge them first.' };
    if (!status.branch || status.ahead > 0 || !status.merged) {
      return { ok: false, reason: 'not-merged', message: `Merge ${status.branch ?? 'this worktree'} first; only merged work is cleaned up.` };
    }
  } else if (!(await onlyEmptyFolders(workspace.rootPath))) {
    return { ok: false, reason: 'invalid', message: 'Git does not know this folder as a worktree and it still has files, so it is left alone.' };
  } else {
    notes.push('Git had already removed this worktree, so its branch was not touched.');
  }
  // One folder can hold the workspaces of several projects (subfolders of one repository).
  const folder = worktree?.path ?? workspace.rootPath;
  const affected = new Set(snapshot.workspaces.filter((entry) => !entry.archivedAt && pathIsWithin(entry.rootPath, folder)).map((entry) => entry.id));
  const scope = worktreeCleanupScope(snapshot, affected, deps.liveTerminalIds());
  if (scope.busy) return { ok: false, reason: 'in-use', message: 'Something is still running in this worktree. Stop its chats, terminals and services first.' };

  const createId = deps.createId ?? randomUUID;
  const partly = (archived: number) => (archived ? ` ${archived} chat(s) were already archived; cleaning up again is safe.` : '');
  let archivedChats = 0;
  for (const sessionId of scope.chats) {
    const receipt = await executeAsPerson(deps, createId, 'agent.archive', { sessionId });
    if (!receipt.ok) return { ok: false, reason: 'in-use', message: `${receipt.error.message}${partly(archivedChats)}` };
    archivedChats += 1;
  }
  await deps.releaseProviders();
  if (worktree && status?.branch) {
    try {
      // Archived chats' provider processes and the tools they started exit a little after the
      // archive; only then is a folder still held by something else.
      const deadline = Date.now() + (archivedChats ? deps.folderReleaseMs ?? 30_000 : 0);
      let held = await folderHeld(worktree.path);
      while (held && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        held = await folderHeld(worktree.path);
      }
      if (held) {
        return { ok: false, reason: 'in-use', message: `A program is still using ${worktree.path} (a terminal or editor opened there). Close it first.${partly(archivedChats)}` };
      }
    } catch (error) {
      return { ok: false, reason: 'git-failed', message: error instanceof Error ? error.message : String(error) };
    }
    const removed = await deps.worktrees.execute({ action: 'remove', cwd: mainRoot, worktreeId: worktree.worktreeId }, 'desktop');
    if (!removed.ok) {
      // Git may still have deleted the files and forgotten the worktree; then finish the job.
      const after = await deps.worktrees.execute({ action: 'list', cwd: mainRoot }, 'desktop');
      if (!after.ok || after.worktrees.some((entry) => entry.worktreeId === worktree.worktreeId)) {
        const reason = removed.error === 'WORKTREE_IN_USE' ? 'in-use' : removed.error === 'WORKTREE_DIRTY' ? 'dirty-worktree' : 'git-failed';
        return { ok: false, reason, message: `${removed.message}${partly(archivedChats)}` };
      }
    }
    const branch = await deps.service.deleteMergedBranch(mainRoot, status.branch);
    if (!branch.deleted) notes.push(`The branch ${status.branch} was kept: ${branch.message ?? 'git did not delete it.'}`);
    // The workspace stays until its folder is gone, so cleaning up again can finish.
    if (!removed.ok && !(await removeEmptyFolders(worktree.path))) {
      return { ok: false, reason: 'in-use', message: `Git removed the worktree, but a program still holds ${worktree.path}. Close it and clean up again to finish.` };
    }
    await forgetWorkspaces(deps, createId, affected, notes);
    return { ok: true, value: { branch: status.branch, branchDeleted: branch.deleted, archivedChats, notes } };
  }
  if (!(await removeEmptyFolders(workspace.rootPath))) {
    return { ok: false, reason: 'in-use', message: `A program is still using ${workspace.rootPath}. Close it and clean up again to finish.${partly(archivedChats)}` };
  }
  await forgetWorkspaces(deps, createId, affected, notes);
  return { ok: true, value: { branchDeleted: false, archivedChats, notes } };
}

/** Sync archives a worktree whose folder is gone; make sure no workspace still points at it. */
async function forgetWorkspaces(deps: WorkspaceWorktreeCleanupDeps, createId: () => string, affected: ReadonlySet<string>, notes: string[]): Promise<void> {
  await deps.syncProjects();
  for (const id of affected) {
    const left = deps.getSnapshot()?.workspaces.find((entry) => entry.id === id && !entry.archivedAt);
    if (!left) continue;
    const receipt = await executeAsPerson(deps, createId, 'workspace.archive', { workspaceId: id });
    if (!receipt.ok) notes.push(`${left.name} is still listed: ${receipt.error.message}`);
  }
}

/** Archives a chat or a workspace as the person who asked for the cleanup (a revision conflict is retried twice). */
export async function executeAsPerson<T extends 'agent.archive' | 'workspace.archive'>(
  deps: Pick<WorkspaceWorktreeCleanupDeps, 'getSnapshot' | 'executeCommand'>,
  createId: () => string,
  type: T,
  payload: DaemonCommandPayloads[T],
): Promise<DaemonCommandReceipt> {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = deps.getSnapshot();
    const commandId = `worktree-cleanup-${createId()}`;
    if (!snapshot) {
      return { ok: false, status: 'rejected', commandId, revision: 0, error: { code: 'invalid-state', message: 'The daemon is not running.', retryable: true } };
    }
    const receipt = await deps.executeCommand(createDaemonCommand({
      commandId, idempotencyKey: commandId, expectedRevision: snapshot.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'worktree-cleanup' }, type, payload,
    } as Parameters<typeof createDaemonCommand>[0]) as DaemonCommand);
    if (receipt.ok || receipt.error.code !== 'revision-conflict' || attempt >= 2) return receipt;
  }
}
