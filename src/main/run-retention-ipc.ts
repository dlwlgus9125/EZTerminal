import type { IpcMain } from 'electron';

import type { FilePreviewResult } from '../shared/file-preview';
import type { CleanedFolderEntry, CleanedFolderState, RunCleanupOutcome, RunCleanupPlan, RunRetentionResult } from '../shared/run-retention';
import type { RunWorktreeCleanup } from './run-worktree-cleanup';

/** Desktop-only 작업 폴더 정리: list a project's removable run work folders, and remove the ones the person confirms. */
export function installRunRetentionIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly cleanup: Pick<RunWorktreeCleanup, 'plan' | 'cleanup' | 'cleaned' | 'folderState' | 'readFile'>;
  /** The execution ledger and results are read only once they are ready. */
  readonly ready: Promise<unknown>;
}): () => void {
  const { ipc, cleanup, ready } = input;
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const filePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4_000;
  const answer = async <T>(work: () => Promise<T>): Promise<RunRetentionResult<T>> => {
    try { await ready; return { ok: true, value: await work() }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  };
  ipc.handle('run-retention:plan', (_event, projectId: unknown): Promise<RunRetentionResult<RunCleanupPlan>> => (
    id(projectId) ? answer(() => cleanup.plan(projectId)) : Promise.resolve({ ok: false, message: 'Choose a project.' })
  ));
  ipc.handle('run-retention:cleaned', (_event, projectId: unknown): Promise<RunRetentionResult<readonly CleanedFolderEntry[]>> => (
    id(projectId) ? answer(() => cleanup.cleaned(projectId)) : Promise.resolve({ ok: false, message: 'Choose a project.' })
  ));
  ipc.handle('run-retention:cleanup', (_event, projectId: unknown, runIds: unknown, baselineRunIds: unknown): Promise<RunRetentionResult<RunCleanupOutcome>> => (
    id(projectId) && Array.isArray(runIds) && runIds.length <= 1_000 && runIds.every(id)
      && (baselineRunIds === undefined || (Array.isArray(baselineRunIds) && baselineRunIds.length <= 1_000 && baselineRunIds.every(id)))
      ? answer(() => cleanup.cleanup(projectId, runIds as string[], baselineRunIds as string[] | undefined))
      : Promise.resolve({ ok: false, message: 'Choose the runs to clean up.' })
  ));
  ipc.handle('run-retention:folder-state', (_event, folderPath: unknown): Promise<RunRetentionResult<CleanedFolderState>> => (
    filePath(folderPath) ? answer(() => cleanup.folderState(folderPath)) : Promise.resolve({ ok: false, message: 'Choose a folder.' })
  ));
  ipc.handle('run-retention:read-file', (_event, path: unknown): Promise<RunRetentionResult<FilePreviewResult>> => (
    filePath(path) ? answer(() => cleanup.readFile(path)) : Promise.resolve({ ok: false, message: 'Choose a file.' })
  ));
  return () => {
    ipc.removeHandler('run-retention:folder-state');
    ipc.removeHandler('run-retention:read-file');
    ipc.removeHandler('run-retention:plan');
    ipc.removeHandler('run-retention:cleaned');
    ipc.removeHandler('run-retention:cleanup');
  };
}
