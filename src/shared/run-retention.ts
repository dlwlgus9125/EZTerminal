import type { FilePreviewResult } from './file-preview';

/** 작업 폴더 정리 (I2-7): what the desktop flow screen asks the host for. */

/** One work folder of a run, as the person's cleanup sees it. */
export interface RunFolderPlan {
  readonly runId: string;
  readonly attemptId: string;
  /** attempt: a stage's work folder; validation: where its result was checked; integration: where the run's results were combined. */
  readonly kind: 'attempt' | 'validation' | 'integration';
  readonly path: string;
  /** removable: nothing of a person's is there; kept: why it stays; removed: already gone (an earlier cleanup). */
  readonly state: 'removable' | 'kept' | 'removed';
  /** Why it stays: a stable code for screens to word, with the host's own English. */
  readonly code?: RunFolderKeepCode;
  readonly reason?: string;
}
export type RunFolderKeepCode = 'head-moved' | 'git-in-progress' | 'sparse' | 'unchecked-entries' | 'submodule' | 'nested-repository' | 'untracked' | 'changed' | 'staged-differs' | 'lfs' | 'unchecked'
  | 'not-ezterminal' | 'locked' | 'project-inside' | 'shared' | 'no-record' | 'result-mismatch' | 'busy' | 'in-use' | 'held' | 'run-changed' | 'failed';

/** A folder this host removed: which run, which attempt, and whether it was the stage's work folder or its validation folder. */
export interface CleanedFolderEntry {
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: RunFolderPlan['kind'];
}

export interface RunCleanupPlan {
  readonly runs: readonly {
    readonly runId: string;
    readonly runNumber: number;
    readonly subprojectId: string;
    /** older: past the flow's newest runs; launch-leftover: a run a refused launch prepared and cancelled. */
    readonly why: 'older' | 'launch-leftover';
    readonly folders: readonly RunFolderPlan[];
  }[];
  /** Folders this host has removed (their stage conversations stay readable as history). */
  readonly cleaned: readonly CleanedFolderEntry[];
}

export interface RunCleanupOutcome {
  readonly removed: number;
  readonly kept: readonly { readonly path: string; readonly code?: RunFolderKeepCode; readonly reason: string }[];
}

/**
 * A conversation's work folder as its Results tab sees it. Cleaned is decided by the host's cleanup record (never by
 * whether the folder exists); result says whether the run's kept result still matches its record, so files can be
 * read from it.
 */
export type CleanedFolderState =
  | { readonly state: 'live' }
  /** A cleanup is removing it now: read nothing from it. */
  | { readonly state: 'retiring'; readonly root: string }
  | { readonly state: 'cleaned'; readonly root: string; readonly result: boolean };

export type RunRetentionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface RunRetentionAccess {
  plan(projectId: string): Promise<RunRetentionResult<RunCleanupPlan>>;
  /** The runs whose work folders were cleaned up (the host's record only: cheap enough to read when a flow opens). */
  cleaned(projectId: string): Promise<RunRetentionResult<readonly CleanedFolderEntry[]>>;
  cleanup(projectId: string, runIds: readonly string[]): Promise<RunRetentionResult<RunCleanupOutcome>>;
  /** Whether this conversation folder was cleaned up. */
  folderState(folderPath: string): Promise<RunRetentionResult<CleanedFolderState>>;
  /** A file of a cleaned-up folder, read from the run's verified result commit in the project checkout. */
  readFile(filePath: string): Promise<RunRetentionResult<FilePreviewResult>>;
}
