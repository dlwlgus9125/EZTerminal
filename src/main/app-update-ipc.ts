import { AppUpdateService } from './app-update-service';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface InstallAppUpdateIpcOptions {
  readonly ipc: FeatureIpc;
  readonly appUpdateService: AppUpdateService;
}

export function installAppUpdateIpc(dependencies: InstallAppUpdateIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('app-update:get-snapshot', () => dependencies.appUpdateService.getSnapshot());
    ipcMain.handle('app-update:check', () => dependencies.appUpdateService.check());
    ipcMain.handle('app-update:download', () => dependencies.appUpdateService.download());
    ipcMain.handle('app-update:cancel-download', () => dependencies.appUpdateService.cancelDownload());
    ipcMain.handle('app-update:open', (_event, options: unknown) => {
      if (
        typeof options !== 'object'
        || options === null
        || Array.isArray(options)
        || Object.keys(options).length !== 1
        || typeof (options as { acknowledgeUnsigned?: unknown; }).acknowledgeUnsigned !== 'boolean'
      ) {
        return { ok: false as const, reason: 'failed' as const };
      }
      return dependencies.appUpdateService.openDownloadedUpdate(
        (options as { acknowledgeUnsigned: boolean; }).acknowledgeUnsigned,
      );
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
