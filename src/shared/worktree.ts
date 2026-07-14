export type WorktreeAction = 'list' | 'create' | 'open' | 'remove';
export type WorktreeRequestOrigin = 'desktop' | 'mobile';

export type WorktreeErrorCode =
  | 'NOT_A_GIT_REPOSITORY'
  | 'INVALID_REQUEST'
  | 'INVALID_BRANCH'
  | 'INVALID_BASE'
  | 'BASE_DIRTY'
  | 'UNSAFE_ROOT'
  | 'TARGET_EXISTS'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_UNMANAGED'
  | 'WORKTREE_DIRTY'
  | 'WORKTREE_IN_USE'
  | 'WORKTREE_LOCKED'
  | 'MAIN_WORKTREE'
  | 'MOBILE_READ_ONLY'
  | 'REGISTRY_WRITE_FAILED'
  | 'GIT_FAILED'
  | 'IO_ERROR';

export interface WorktreeInfo {
  readonly worktreeId: string;
  readonly repoId: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly main: boolean;
  readonly locked: boolean;
  readonly managed: boolean;
  readonly prunable: boolean;
}

export interface WorktreeListRequest {
  readonly action: 'list';
  readonly cwd: string;
}

export interface WorktreeCreateRequest {
  readonly action: 'create';
  readonly cwd: string;
  readonly branch: string;
  readonly base?: string;
  /** Safe parent directory. The generated worktree remains a child of it. */
  readonly root?: string;
  readonly allowDirtyBase?: boolean;
}

export interface WorktreeOpenRequest {
  readonly action: 'open';
  readonly cwd: string;
  readonly worktreeId: string;
}

export interface WorktreeRemoveRequest {
  readonly action: 'remove';
  readonly cwd: string;
  readonly worktreeId: string;
}

export type WorktreeRequest =
  | WorktreeListRequest
  | WorktreeCreateRequest
  | WorktreeOpenRequest
  | WorktreeRemoveRequest;

export interface WorktreeSuccess {
  readonly ok: true;
  readonly action: WorktreeAction;
  readonly worktrees: readonly WorktreeInfo[];
  /** Set by open and by a successful create for direct UI integration. */
  readonly opened?: WorktreeInfo;
}

export interface WorktreeFailure {
  readonly ok: false;
  readonly action: WorktreeAction;
  readonly error: WorktreeErrorCode;
  readonly message: string;
  /** A create may succeed in Git but fail to persist EZTerminal ownership. */
  readonly worktree?: WorktreeInfo;
}

export type WorktreeResult = WorktreeSuccess | WorktreeFailure;

export function isWorktreeRequest(value: unknown): value is WorktreeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.action !== 'string' || typeof request.cwd !== 'string' || request.cwd.length === 0) return false;
  switch (request.action) {
    case 'list':
      return true;
    case 'open':
    case 'remove':
      return typeof request.worktreeId === 'string' && request.worktreeId.length > 0;
    case 'create':
      return (
        typeof request.branch === 'string' && request.branch.length > 0 &&
        (request.base === undefined || typeof request.base === 'string') &&
        (request.root === undefined || typeof request.root === 'string') &&
        (request.allowDirtyBase === undefined || typeof request.allowDirtyBase === 'boolean')
      );
    default:
      return false;
  }
}
