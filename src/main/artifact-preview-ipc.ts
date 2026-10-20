import type { ArtifactPreviewRegistry } from './artifact-preview';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

/**
 * Desktop-only: the Results tab asks for an isolated preview of one file and
 * gives it back when the preview closes. Android has no such bridge.
 */
export function installArtifactPreviewIpc(ipc: FeatureIpc, registry: ArtifactPreviewRegistry): () => void {
  const ipcMain = new IpcRegistration(ipc);
  try {
    ipcMain.handle('artifact-preview:grant', (_event, filePath: unknown, kind: unknown) => registry.grant(filePath, kind));
    ipcMain.handle('artifact-preview:revoke', (_event, token: unknown) => { registry.revoke(token); });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
