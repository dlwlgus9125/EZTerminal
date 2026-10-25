import type { IpcMain } from 'electron';

import type { RunCleanupOutcome, RunCleanupPlan, RunRetentionResult } from '../shared/run-retention';
import type { RunWorktreeCleanup } from './run-worktree-cleanup';

/** Desktop-only 작업 폴더 정리: list a project's removable run work folders, and remove the ones the person confirms. */
export function installRunRetentionIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly cleanup: Pick<RunWorktreeCleanup, 'plan' | 'cleanup'>;
  /** The execution ledger and results are read only once they are ready. */
  readonly ready: Promise<unknown>;
}): () => void {
  const { ipc, cleanup, ready } = input;
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const answer = async <T>(work: () => Promise<T>): Promise<RunRetentionResult<T>> => {
    try { await ready; return { ok: true, value: await work() }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  };
  ipc.handle('run-retention:plan', (_event, projectId: unknown): Promise<RunRetentionResult<RunCleanupPlan>> => (
    id(projectId) ? answer(() => cleanup.plan(projectId)) : Promise.resolve({ ok: false, message: 'Choose a project.' })
  ));
  ipc.handle('run-retention:cleanup', (_event, projectId: unknown, runIds: unknown): Promise<RunRetentionResult<RunCleanupOutcome>> => (
    id(projectId) && Array.isArray(runIds) && runIds.length <= 1_000 && runIds.every(id)
      ? answer(() => cleanup.cleanup(projectId, runIds as string[]))
      : Promise.resolve({ ok: false, message: 'Choose the runs to clean up.' })
  ));
  return () => {
    ipc.removeHandler('run-retention:plan');
    ipc.removeHandler('run-retention:cleanup');
  };
}
