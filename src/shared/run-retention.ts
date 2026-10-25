/** 작업 폴더 정리 (I2-7): what the desktop flow screen asks the host for. */

/** One work folder of a run, as the person's cleanup sees it. */
export interface RunFolderPlan {
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: 'attempt' | 'validation';
  readonly path: string;
  /** removable: nothing of a person's is there; kept: why it stays; removed: already gone (an earlier cleanup). */
  readonly state: 'removable' | 'kept' | 'removed';
  readonly reason?: string;
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
  /** Runs whose work folders this host has removed (their stage conversations stay readable as history). */
  readonly cleanedRunIds: readonly string[];
}

export interface RunCleanupOutcome {
  readonly removed: number;
  readonly kept: readonly { readonly path: string; readonly reason: string }[];
}

export type RunRetentionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface RunRetentionAccess {
  plan(projectId: string): Promise<RunRetentionResult<RunCleanupPlan>>;
  cleanup(projectId: string, runIds: readonly string[]): Promise<RunRetentionResult<RunCleanupOutcome>>;
}
