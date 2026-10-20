import { useCallback, useState } from 'react';

import type { FilePreviewResult } from '../../shared/file-preview';
import type { GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import { readSessionViewState, saveSessionViewState } from '../session-view-state';

/** What the Results tab asks the host for; every member is optional so stories and Android can omit it. */
export interface ResultsServices {
  readonly getGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  readonly getGitDiff?: (directory: string) => Promise<GitDiffResult>;
  readonly readFilePreview?: (path: string) => Promise<FilePreviewResult>;
  readonly openFileInApp?: (path: string) => Promise<void>;
  readonly openExternalHttpUrl?: (url: string) => void;
}

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
