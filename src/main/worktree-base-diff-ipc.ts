import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { GitWorktreeBaseDiffResult, GitWorktreeBaseResult } from '../shared/git-status';
import type { GitStatusService } from './git-status-service';
import { worktreeTargetOf } from './workspace-worktree-ipc';
import type { WorkspaceWorktreeService } from './workspace-worktree-service';

/**
 * 기준 브랜치와 비교 (Results › Changes) for a worktree conversation: the branch it compares with,
 * and its change since it left that branch (commits, uncommitted and untracked files together).
 * The renderer names the workspace only; the host finds its folder and base branch in the daemon's
 * records. Only an EZTerminal window may ask.
 */
export function installWorktreeBaseDiffIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  /** The sender is an EZTerminal window with its session-surface id. */
  readonly authorized: (event: IpcMainInvokeEvent, clientId: unknown) => boolean;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  readonly worktrees: Pick<WorkspaceWorktreeService, 'baseBranch'>;
  readonly git: Pick<GitStatusService, 'getReviewDiff'>;
}): () => void {
  const { ipc, authorized, getSnapshot, worktrees, git } = input;

  ipc.handle('git:worktree-base', async (event, clientId: unknown, workspaceId: unknown): Promise<GitWorktreeBaseResult> => {
    if (!authorized(event, clientId)) return { ok: false, error: 'not-found' };
    const target = worktreeTargetOf(getSnapshot(), workspaceId);
    if (!target) return { ok: false, error: 'not-found' };
    const baseRef = await worktrees.baseBranch(target).catch(() => undefined);
    return baseRef ? { ok: true, baseRef } : { ok: false, error: 'no-base' };
  });

  ipc.handle('git:worktree-base-diff', async (event, clientId: unknown, workspaceId: unknown): Promise<GitWorktreeBaseDiffResult> => {
    if (!authorized(event, clientId)) return { ok: false, error: 'invalid-path' };
    const target = worktreeTargetOf(getSnapshot(), workspaceId);
    if (!target) return { ok: false, error: 'invalid-path' };
    const baseRef = await worktrees.baseBranch(target).catch(() => undefined);
    if (!baseRef) return { ok: false, error: 'no-base' };
    const diff = await git.getReviewDiff(target.rootPath, { kind: 'base-branch', baseRef });
    if (!diff.ok) return diff;
    if (diff.mergeBase === undefined) return { ok: false, error: 'no-base' };
    return {
      ok: true,
      text: diff.text,
      truncated: diff.truncated,
      omissions: diff.omissions,
      baseRef,
      mergeBase: diff.mergeBase,
      ahead: diff.ahead ?? 0,
    };
  });

  return () => {
    ipc.removeHandler('git:worktree-base');
    ipc.removeHandler('git:worktree-base-diff');
  };
}
