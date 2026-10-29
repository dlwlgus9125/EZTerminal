import { useCallback, useState } from 'react';

import type { FilePreviewResult } from '../../shared/file-preview';
import type { GitDiffError, GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import type { CleanedFolderState } from '../../shared/run-retention';
import { readSessionViewState, saveSessionViewState } from '../session-view-state';

/**
 * A worktree's change since it left its base branch: from the merge base, commits, uncommitted and
 * untracked files together (what a base-branch review reads). `ahead` counts the branch's own commits.
 */
export type WorktreeBaseDiffResult =
  | (Extract<GitDiffResult, { readonly ok: true }> & { readonly baseRef: string; readonly ahead: number })
  | { readonly ok: false; readonly error: GitDiffError | 'no-base' };

/** What the Results tab asks the host for; every member is optional so stories and Android can omit it. */
export interface ResultsServices {
  readonly getGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  readonly getGitDiff?: (directory: string) => Promise<GitDiffResult>;
  /** 기준 브랜치와 비교: the worktree's change since `baseRef` (worktree conversations only). */
  readonly getWorktreeBaseDiff?: (directory: string, baseRef: string) => Promise<WorktreeBaseDiffResult>;
  readonly readFilePreview?: (path: string) => Promise<FilePreviewResult>;
  readonly openFileInApp?: (path: string) => Promise<void>;
  readonly openExternalHttpUrl?: (url: string) => void;
  /** Whether the conversation's work folder was cleaned up (작업 폴더 정리, desktop); rejects when the host cannot tell. */
  readonly cleanedFolder?: (root: string) => Promise<CleanedFolderState>;
  /** A cleaned-up folder's file, from the run's kept result. */
  readonly readCleanedFile?: (path: string) => Promise<FilePreviewResult>;
  /** Called when the host's cleanup record changes; returns the unsubscribe. */
  readonly onFolderChanged?: (listener: () => void) => () => void;
}

/**
 * What the Results tab may do with the conversation's work folder: read it (live), nothing while the host is asked or
 * removes it (checking), nothing when the host could not tell (error), or read its files from the run's kept result
 * (cleaned).
 */
export type ResultsFolderAccess =
  | { readonly kind: 'live' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'error'; readonly retry: () => void }
  | { readonly kind: 'cleaned'; readonly root: string; readonly result: boolean };

/** Results tab presentation state that survives switching sections and pop-out moves (memory only). */
export function useResultsViewState<T>(key: string, initial: T): [T, (update: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readSessionViewState<T>(key) ?? initial);
  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      saveSessionViewState(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, update];
}
