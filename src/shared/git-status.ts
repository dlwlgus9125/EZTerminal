/**
 * Working-tree facts the UI needs but could not previously ask for: which
 * branch a directory is on, which of its files changed, and by how much.
 *
 * Paths are always relative to the directory that was asked about, with
 * forward slashes, so a caller can match them against the names it is already
 * rendering without knowing where the repository root is.
 */

export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileChange {
  /** Relative to the requested directory. `docs/x.md` for a nested file. */
  readonly path: string;
  readonly kind: GitChangeKind;
  /** From `git diff --numstat`. Absent for untracked and for binary files. */
  readonly added?: number;
  readonly removed?: number;
}

export type GitStatusAvailability = 'ready' | 'not-a-repository' | 'unavailable';

export type GitDirectoryStatus =
  | {
      readonly availability: 'ready';
      readonly tracked: true;
      /** Branch name, or absent when detached. */
      readonly branch?: string;
      readonly changes: readonly GitFileChange[];
      /** True when the change list hit its cap and is therefore partial. */
      readonly truncated: boolean;
    }
  | {
      /** `unavailable` distinguishes invalid paths and Git failures from a
       * real directory that simply is not a repository. */
      readonly availability: Exclude<GitStatusAvailability, 'ready'>;
      readonly tracked: false;
      readonly branch?: undefined;
      readonly changes: readonly GitFileChange[];
      readonly truncated: false;
    };

export const EMPTY_GIT_DIRECTORY_STATUS: GitDirectoryStatus = Object.freeze({
  availability: 'not-a-repository',
  tracked: false,
  changes: Object.freeze([]),
  truncated: false,
});

export const UNAVAILABLE_GIT_DIRECTORY_STATUS: GitDirectoryStatus = Object.freeze({
  availability: 'unavailable',
  tracked: false,
  changes: Object.freeze([]),
  truncated: false,
});

export type GitDiffError = 'not-a-repository' | 'invalid-path' | 'git-failed';

export type GitDiffOmissionReason =
  | 'binary'
  | 'symlink'
  | 'too-large'
  | 'unsupported'
  | 'read-failed'
  | 'budget-exhausted';

export interface GitDiffOmission {
  /** Repository-relative path, never an absolute local path. */
  readonly path: string;
  readonly reason: GitDiffOmissionReason;
}

export type GitDiffResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly truncated: boolean;
      readonly omissions: readonly GitDiffOmission[];
    }
  | { readonly ok: false; readonly error: GitDiffError };

/** What a review (or 기준 브랜치와 비교) reads: uncommitted changes, or everything since the branch left its base. */
export type GitReviewScope =
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'base-branch'; readonly baseRef: string };

/**
 * A scope as one plain `git diff`: a `diff --git` section per file, paths relative to the directory
 * asked about, tracked files first, then untracked ones. Whole files only: a file that does not fit
 * the budget is left out and named in `omissions`. `base-branch` covers the commits since the merge
 * base with the base branch plus uncommitted and untracked files. `no-base`: the base branch is
 * missing, shares no history with HEAD, or there is no commit yet.
 */
export type GitReviewDiffResult =
  | (Extract<GitDiffResult, { readonly ok: true }> & {
      readonly baseRef?: string;
      readonly mergeBase?: string;
      /** Commits on HEAD since the merge base. */
      readonly ahead?: number;
    })
  | { readonly ok: false; readonly error: GitDiffError | 'no-base' };

/** A worktree conversation's base branch: the branch the project's main checkout has out. */
export type GitWorktreeBaseResult =
  | { readonly ok: true; readonly baseRef: string }
  | { readonly ok: false; readonly error: 'not-found' | 'no-base' };

/**
 * 기준 브랜치와 비교 for a worktree workspace (the Results tab). A workspace that is gone or is not a
 * worktree answers `invalid-path`, as a directory the host cannot read would.
 */
export type GitWorktreeBaseDiffResult =
  | (Extract<GitDiffResult, { readonly ok: true }> & { readonly baseRef: string; readonly mergeBase: string; readonly ahead: number })
  | { readonly ok: false; readonly error: GitDiffError | 'no-base' };
