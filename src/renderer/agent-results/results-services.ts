import { useCallback, useState } from 'react';

import type { FilePreviewResult } from '../../shared/file-preview';
import type { GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import type { CleanedFolderState } from '../../shared/run-retention';
import { readSessionViewState, saveSessionViewState } from '../session-view-state';

/** What the Results tab asks the host for; every member is optional so stories and Android can omit it. */
export interface ResultsServices {
  readonly getGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  readonly getGitDiff?: (directory: string) => Promise<GitDiffResult>;
  readonly readFilePreview?: (path: string) => Promise<FilePreviewResult>;
  readonly openFileInApp?: (path: string) => Promise<void>;
  readonly openExternalHttpUrl?: (url: string) => void;
  /** Whether the conversation's work folder was cleaned up (작업 폴더 정리, desktop); rejects when the host cannot tell. */
  readonly cleanedFolder?: (root: string) => Promise<CleanedFolderState>;
  /** A cleaned-up folder's file, from the run's kept result. */
  readonly readCleanedFile?: (path: string) => Promise<FilePreviewResult>;
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
