import type { IpcMainInvokeEvent } from 'electron';
import { ProjectArchiveRequestSchema, type ProjectArchiveInventory, type ProjectArchiveResult } from '../shared/project-archive';
import type { ProjectArchiveService } from './project-archive-service';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { LocalMutationIngress } from './local-mutation-ingress';

export function installProjectArchiveIpc(options: {
  readonly ipc: FeatureIpc; readonly service: ProjectArchiveService; readonly ready: Promise<unknown>; readonly ingress: LocalMutationIngress;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
  readonly chooseExportPath: (event: IpcMainInvokeEvent, projectId: string) => Promise<string | null>;
  readonly chooseArchivePath: (event: IpcMainInvokeEvent) => Promise<string | null>;
  readonly chooseRestoreParent: (event: IpcMainInvokeEvent) => Promise<string | null>;
  readonly confirmCleanup: (event: IpcMainInvokeEvent, inventory: ProjectArchiveInventory, sessionIds: readonly string[]) => Promise<boolean>;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const forbidden: ProjectArchiveResult = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' };
  const cancelled: ProjectArchiveResult = { ok: false, error: 'cancelled', message: 'The archive operation was cancelled.' };
  try {
    ipc.handle('project-archive:execute', async (event, clientId: unknown, value: unknown): Promise<ProjectArchiveResult> => {
      const principal = options.resolvePrincipal(event, clientId); if (!principal) return forbidden;
      const parsed = ProjectArchiveRequestSchema.safeParse(value);
      if (!parsed.success) return { ok: false, error: 'invalid-request', message: 'The project archive request is invalid.' };
      try {
        return await options.ingress.run(async signal => {
          await options.ready; signal.throwIfAborted();
          const authorized = () => !signal.aborted && options.resolvePrincipal(event, clientId) === principal;
          if (!authorized()) return forbidden;
          const request = parsed.data;
          if (request.type === 'inventory') return { ok: true, kind: 'inventory', inventory: await options.service.inventory(request.projectId) };
          if (request.type === 'history') return { ok: true, kind: 'history', history: await options.service.history(request.projectId) };
          if (request.type === 'prepare-import') return { ok: true, kind: 'prepare-import', directoryPath: await options.service.prepareImport(request.projectId) };
          if (request.type === 'export') {
            const destination = await options.chooseExportPath(event, request.projectId); if (!destination) return cancelled; if (!authorized()) return forbidden;
            return { ok: true, kind: 'export', path: destination, manifest: await options.service.exportProject(request.projectId, destination, request.commandId) };
          }
          if (request.type === 'inspect') {
            if (request.uploadedPath) {
              if (!request.projectId) return { ok: false, error: 'invalid-request', message: 'Uploaded archives require their owning project.' };
              return { ok: true, kind: 'inspect', ...await options.service.inspectUploaded(request.projectId, request.uploadedPath) };
            }
            const selected = await options.chooseArchivePath(event); if (!selected) return cancelled; if (!authorized()) return forbidden;
            return { ok: true, kind: 'inspect', ...await options.service.inspectArchive(selected) };
          }
          if (request.type === 'restore') {
            const parent = await options.chooseRestoreParent(event); if (!parent) return cancelled; if (!authorized()) return forbidden;
            return { ok: true, kind: 'restore', ...await options.service.restoreArchive(request.archiveId, request.name, parent, request.commandId) };
          }
          const inventory = await options.service.inventory(request.projectId);
          if (inventory.token !== request.inventoryToken) return { ok: false, error: 'invalid-request', message: 'Refresh the cleanup preview before deleting records.' };
          if (!await options.confirmCleanup(event, inventory, request.sessionIds)) return cancelled; if (!authorized()) return forbidden;
          return { ok: true, kind: 'cleanup', removedItems: await options.service.cleanup(request.projectId, request.inventoryToken, request.sessionIds) };
        });
      } catch (error) { return { ok: false, error: 'unavailable', message: error instanceof Error ? error.message : 'Archive operation failed; existing records were preserved.' }; }
    });
  } catch (error) { ipc.dispose(); throw error; }
  return ipc.dispose;
}
