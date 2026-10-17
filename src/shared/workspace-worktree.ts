/** Desktop worktree workspaces: what the renderer asks the main process for. */
export type WorkspaceWorktreeIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'invalid' | 'dirty-worktree' | 'dirty-main' | 'nothing-to-merge' | 'conflict' | 'not-a-branch' | 'git-failed';
      readonly message: string;
    };

export interface WorkspaceWorktreeStatusView {
  readonly workspaceId: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly merged: boolean;
  readonly status?: 'review' | 'done';
}

export interface WorkspaceWorktreeAccess {
  create(projectId: string, branch: string): Promise<WorkspaceWorktreeIpcResult<{ readonly workspaceId: string }>>;
  status(projectId: string): Promise<WorkspaceWorktreeIpcResult<readonly WorkspaceWorktreeStatusView[]>>;
  commit(workspaceId: string, message: string): Promise<WorkspaceWorktreeIpcResult<{ readonly commit: string }>>;
  merge(workspaceId: string): Promise<WorkspaceWorktreeIpcResult<{ readonly into: string; readonly commit: string }>>;
}
