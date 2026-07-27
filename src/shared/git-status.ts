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

export interface GitDirectoryStatus {
  /** False when the directory is not inside a work tree at all. */
  readonly tracked: boolean;
  /** Branch name, or absent when detached or untracked. */
  readonly branch?: string;
  readonly changes: readonly GitFileChange[];
  /** True when the change list hit its cap and is therefore partial. */
  readonly truncated: boolean;
}

export const EMPTY_GIT_DIRECTORY_STATUS: GitDirectoryStatus = Object.freeze({
  tracked: false,
  changes: Object.freeze([]),
  truncated: false,
});

export type GitDiffError = 'not-a-repository' | 'invalid-path' | 'git-failed';

export type GitDiffResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: GitDiffError };
