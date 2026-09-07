import { normalizeExternalHttpUrl } from '../shared/external-url';
import type { WorkspaceFileSearchRequest } from '../shared/workspace-search';
import { FileService } from './file-service';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { QuickCommandStore } from './quick-command-store';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
import { WorkspaceFileSearchService } from './workspace-file-search-service';

interface InstallFileToolsIpcOptions {
  readonly ipc: FeatureIpc;
  readonly fileService: FileService;
  readonly terminalCapabilitiesFor: (sender: object) => TerminalFileCapabilityStore;
  readonly openPathForUser: (filePath: string) => Promise<string>;
  readonly revealPathForUser: (filePath: string) => Promise<void>;
  readonly openExternalForUser: (url: string) => Promise<void>;
  readonly quickCommandsReady: Promise<void>;
  readonly quickCommandStore: QuickCommandStore;
  readonly workspaceFileSearch: WorkspaceFileSearchService;
}

export function installFileToolsIpc(dependencies: InstallFileToolsIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('files:list', (_event, path: string) => dependencies.fileService.listDirectory(path));
    ipcMain.handle('files:roots', () => dependencies.fileService.listRoots());
    ipcMain.handle('files:read-text', (_event, path: string) => dependencies.fileService.readTextFile(path));
    ipcMain.handle('files:read-preview', async (event, path: string, capability?: unknown) => {
      if (capability === undefined) return dependencies.fileService.readFilePreview(path);
      const authorized = await dependencies.terminalCapabilitiesFor(event.sender).consumeAndOpen(capability, path);
      if (!authorized.ok) return { ok: false as const, error: 'Terminal preview authorization expired or the file changed.' };
      return dependencies.fileService.readFilePreview(path, authorized.handle);
    });
    ipcMain.handle('files:mkdir', (_event, dirPath: string, name: string) =>
      dependencies.fileService.createFolder(dirPath, name),
    );
    ipcMain.handle('files:rename', (_event, path: string, newName: string) =>
      dependencies.fileService.renameEntry(path, newName),
    );
    ipcMain.handle('files:trash', (_event, path: string) => dependencies.fileService.trashEntry(path));
    ipcMain.handle('files:open-path', async (_event, path: string) => {
      const err = await dependencies.openPathForUser(path);
      if (err) console.error('[main] shell.openPath failed:', err);
    });
    ipcMain.handle('files:reveal', async (_event, path: string) => {
      await dependencies.revealPathForUser(path);
    });
    ipcMain.handle('external:open-http-url', async (_event, value: unknown): Promise<boolean> => {
      if (typeof value !== 'string') return false;
      const url = normalizeExternalHttpUrl(value);
      if (!url) return false;
      try {
        await dependencies.openExternalForUser(url);
        return true;
      } catch {
        return false;
      }
    });

    ipcMain.handle('quick-commands:list', async () => {
      await dependencies.quickCommandsReady;
      return dependencies.quickCommandStore.list();
    });
    ipcMain.handle('quick-commands:create', async (_event, input: unknown) => {
      await dependencies.quickCommandsReady;
      return dependencies.quickCommandStore.create(input);
    });
    ipcMain.handle('quick-commands:update', async (_event, id: unknown, input: unknown) => {
      await dependencies.quickCommandsReady;
      return typeof id === 'string'
        ? dependencies.quickCommandStore.update(id, input)
        : { ok: false, error: 'not-found', message: 'quick command not found' } as const;
    });
    ipcMain.handle('quick-commands:delete', async (_event, id: unknown) => {
      await dependencies.quickCommandsReady;
      return typeof id === 'string'
        ? dependencies.quickCommandStore.delete(id)
        : { ok: false, error: 'not-found', message: 'quick command not found' } as const;
    });
    ipcMain.handle('workspace-files:search', (_event, request: WorkspaceFileSearchRequest) =>
      dependencies.workspaceFileSearch.search(request),
    );
    ipcMain.on('workspace-files:cancel', (_event, requestId: unknown) => {
      if (typeof requestId === 'string') dependencies.workspaceFileSearch.cancel(requestId);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
