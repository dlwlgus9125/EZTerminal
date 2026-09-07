import { gateLocalMutation, gateAbortableLocalMutation } from './local-mutation-ipc';

import { ProjectWorkspaceService } from './project-workspace-service';

import { ProjectDocumentService } from './project-document-service';

import { LocalMutationIngress, raceLocalOperationWithAbort } from './local-mutation-ingress';

import {
  type ProjectSessionPanelMetadata,
  type ProjectWorkspaceDescriptor,
  type ProjectWorkspaceError,
  type ProjectWorkspaceLocationDescriptor,
} from '../shared/project-workspace';

import { type DaemonProjectSyncOptions } from './daemon-project-sync';

import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface InstallProjectWorkspaceIpcOptions {
  readonly ipc: FeatureIpc;
  readonly desktopAgentMutationIngress: LocalMutationIngress;
  readonly projectWorkspaceReady: Promise<[void, void]>;
  readonly projectWorkspaceService: ProjectWorkspaceService;
  readonly requestDaemonProjectSync: (resolvedProject?: ProjectWorkspaceDescriptor, options?: DaemonProjectSyncOptions) => Promise<void>;
  readonly resolveProjectTerminalDirectory: (request: unknown, signal?: AbortSignal) => Promise<{ readonly ok: false; readonly error: ProjectWorkspaceError | "not-workspace-root"; } | { readonly ok: true; readonly projectSession: ProjectSessionPanelMetadata; }>;
  readonly projectDocumentService: ProjectDocumentService;
  readonly projectWorkspaceSearches: Map<string, AbortController>;
  readonly requestProjectWorkspaceApproval: (request: unknown) => Promise<{ readonly ok: false; readonly error: ProjectWorkspaceError; } | { readonly ok: true; readonly workspace: ProjectWorkspaceLocationDescriptor; }>;
  readonly requestDaemonWorkspaceRevocation: (request: unknown) => Promise<boolean>;
}

export function installProjectWorkspaceIpc(dependencies: InstallProjectWorkspaceIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('project-workspace:describe', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, async (signal, _event, projectId: unknown) => {
      await raceLocalOperationWithAbort(dependencies.projectWorkspaceReady, signal);
      signal.throwIfAborted();
      const described = await dependencies.projectWorkspaceService.describeProjectWorkspaces(projectId, signal);
      if (described.ok) {
        await dependencies.requestDaemonProjectSync().catch((error) => {
          console.error('[main] described Agent Project daemon sync failed:', error);
        });
      }
      return described;
    }));
    ipcMain.handle('project-workspace:resolve-terminal-directory', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, async (signal, _event, request: unknown) => {
      try {
        signal.throwIfAborted();
        // Resolution and its exact daemon commit share one FIFO operation with
        // revocation, so neither can publish a stale external-worktree grant.
        return await dependencies.resolveProjectTerminalDirectory(request, signal);
      } catch (error) {
        console.error('[main] project terminal daemon sync failed:', error);
        return { ok: false, error: 'io-error' } as const;
      }
    }));
    ipcMain.handle('project-documents:resolve', async (_event, request: unknown) => {
      await dependencies.projectWorkspaceReady;
      return dependencies.projectDocumentService.resolveTarget(request);
    });
    ipcMain.handle('project-documents:list-directory', async (_event, request: unknown) => {
      await dependencies.projectWorkspaceReady;
      return dependencies.projectDocumentService.listDirectory(request);
    });
    ipcMain.handle('project-documents:read', async (_event, request: unknown) => {
      await dependencies.projectWorkspaceReady;
      return dependencies.projectDocumentService.readDocument(request);
    });
    ipcMain.handle('project-workspace:search', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, async (signal, event, request: unknown) => {
      await raceLocalOperationWithAbort(dependencies.projectWorkspaceReady, signal);
      signal.throwIfAborted();
      const requestId = typeof request === 'object' && request !== null && !Array.isArray(request)
        ? (request as { readonly requestId?: unknown; }).requestId
        : undefined;
      if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) {
        return dependencies.projectWorkspaceService.search(request, signal);
      }
      const key = `${String(event.sender.id)}:${requestId}`;
      dependencies.projectWorkspaceSearches.get(key)?.abort();
      const controller = new AbortController();
      dependencies.projectWorkspaceSearches.set(key, controller);
      const abortSearch = (): void => controller.abort(signal.reason);
      signal.addEventListener('abort', abortSearch, { once: true });
      if (signal.aborted) abortSearch();
      try {
        return await dependencies.projectWorkspaceService.search(request, controller.signal);
      } finally {
        signal.removeEventListener('abort', abortSearch);
        if (dependencies.projectWorkspaceSearches.get(key) === controller) dependencies.projectWorkspaceSearches.delete(key);
      }
    }));
    ipcMain.on('project-workspace:cancel-search', (event, requestId: unknown) => {
      if (typeof requestId !== 'string') return;
      const key = `${String(event.sender.id)}:${requestId}`;
      dependencies.projectWorkspaceSearches.get(key)?.abort();
      dependencies.projectWorkspaceSearches.delete(key);
    });
    ipcMain.handle('project-workspace:approve', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, request: unknown) => {
      try {
        return await dependencies.requestProjectWorkspaceApproval(request);
      } catch (error) {
        console.error('[main] project workspace daemon approval sync failed:', error);
        return { ok: false, error: 'io-error' } as const;
      }
    }));
    ipcMain.handle('project-workspace:revoke', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, request: unknown) => {
      try {
        // Archive the launch capability and remove persisted consent in the same
        // FIFO operation used by Project discovery and terminal preparation.
        return await dependencies.requestDaemonWorkspaceRevocation(request);
      } catch (error) {
        console.error('[main] project workspace daemon revocation failed:', error);
        return false;
      }
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
