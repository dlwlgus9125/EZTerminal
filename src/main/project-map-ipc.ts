import { gateLocalMutation, gateAbortableLocalMutation } from './local-mutation-ipc';
import { BrowserWindow, dialog, nativeTheme } from 'electron';
import {
  isProjectMapApprovalRequest,
  isProjectMapBindingRequest,
  isProjectMapCollectionRequest,
  isProjectMapExportRequest,
  isProjectMapJobRequest,
  isProjectMapReadRequest,
  isProjectMapStartJobRequest,
} from '../shared/project-map';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { LocalMutationIngress, raceLocalOperationWithAbort } from './local-mutation-ingress';
import { exportProjectMap } from './project-map-exporter';
import { ProjectMapService } from './project-map-service';

interface InstallProjectMapIpcOptions {
  readonly ipc: FeatureIpc;
  readonly desktopProjectMapMutationIngress: LocalMutationIngress;
  readonly projectWorkspaceReady: Promise<[void, void]>;
  readonly projectMapReady: Promise<void>;
  readonly projectMapService: ProjectMapService;
  readonly mainWindowRef: BrowserWindow | null;
}

export function installProjectMapIpc(dependencies: InstallProjectMapIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('project-map:describe', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapCollectionRequest(request)) {
        return {
          ok: false,
          error: 'invalid-request',
          collection: {
            projectId: '',
            state: 'invalid',
            roots: [],
            bindings: [],
            maps: [],
            diagnostics: [{
              severity: 'error',
              code: 'request.invalid',
              subject: '$',
              message: 'Invalid Project Map collection request.',
            }],
          },
        };
      }
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.describe(request);
    }));
    ipcMain.handle('project-map:set-bindings', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapBindingRequest(request)) {
        return {
          ok: false,
          error: 'invalid-request',
          collection: {
            projectId: '',
            state: 'binding-required',
            roots: [],
            bindings: [],
            maps: [],
            diagnostics: [{
              severity: 'error',
              code: 'request.invalid',
              subject: '$',
              message: 'Invalid Project Map root binding request.',
            }],
          },
        };
      }
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.setBindings(request);
    }));
    const readProjectMap = async (request: unknown) => {
      if (!isProjectMapReadRequest(request)) {
        return {
          ok: false,
          error: 'invalid-request',
          state: 'invalid',
          diagnostics: [{
            severity: 'error',
            code: 'request.invalid',
            subject: '$',
            message: 'Invalid Project Map read request.',
          }],
        };
      }
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.read(request);
    };
    ipcMain.handle('project-map:read', gateLocalMutation(
      dependencies.desktopProjectMapMutationIngress,
      (_event, request: unknown) => readProjectMap(request),
    ));
    ipcMain.handle('project-map:refresh', gateLocalMutation(
      dependencies.desktopProjectMapMutationIngress,
      (_event, request: unknown) => readProjectMap(request),
    ));
    const invalidProjectMapOpen = () => ({
      ok: false as const,
      error: 'invalid-request',
      snapshot: {
        collection: {
          projectId: '',
          state: 'invalid' as const,
          roots: [],
          bindings: [],
          maps: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'request.invalid',
            subject: '$',
            message: 'Invalid Project Map request.',
          }],
        },
        freshness: 'verified' as const,
        verificationPending: false,
      },
    });
    ipcMain.handle('project-map:open', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapReadRequest(request)) return invalidProjectMapOpen();
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.open(request);
    }));
    ipcMain.handle('project-map:refresh-v2', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapReadRequest(request)) return invalidProjectMapOpen();
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.open(request, true);
    }));
    ipcMain.handle('project-map:approve', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapApprovalRequest(request)) return invalidProjectMapOpen();
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      return dependencies.projectMapService.approve(request);
    }));
    ipcMain.handle('project-map:start-job', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapStartJobRequest(request)) return { ok: false, error: 'invalid-request' };
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      try {
        return { ok: true, job: await dependencies.projectMapService.startJob(request) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'job-start-failed' };
      }
    }));
    ipcMain.handle('project-map:cancel-job', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapJobRequest(request)) return { ok: false, error: 'invalid-request' };
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      const job = await dependencies.projectMapService.cancelJob(request);
      return job ? { ok: true, job } : { ok: false, error: 'job-not-found' };
    }));
    ipcMain.handle('project-map:select-export-directory', gateAbortableLocalMutation(dependencies.desktopProjectMapMutationIngress, async (signal, event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? dependencies.mainWindowRef ?? undefined;
      const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
      let result: Electron.OpenDialogReturnValue;
      try {
        result = await raceLocalOperationWithAbort(
          owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
          signal,
        );
      } catch (error) {
        if (signal.aborted) return { ok: false, error: 'canceled' } as const;
        throw error;
      }
      return result.canceled || !result.filePaths[0]
        ? { ok: false as const, error: 'canceled' }
        : { ok: true as const, directory: result.filePaths[0] };
    }));
    ipcMain.handle('project-map:export', gateLocalMutation(dependencies.desktopProjectMapMutationIngress, async (_event, request: unknown) => {
      if (!isProjectMapExportRequest(request) || !request.mapId) {
        return { ok: false, error: 'invalid-request' };
      }
      await Promise.all([dependencies.projectWorkspaceReady, dependencies.projectMapReady]);
      const document = await dependencies.projectMapService.approvedDocument(request);
      if (!document) return { ok: false, error: 'approved-map-not-found' };
      return exportProjectMap(request, document, nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
import type { OpenDialogOptions } from 'electron';
