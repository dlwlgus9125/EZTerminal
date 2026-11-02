import { isBrowserSurfaceSnapshot, type BrowserSurfaceSnapshot, type BrowserViewState } from '../shared/browser';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface BrowserIpcView {
  updateSurface(conversationId: string, surface: { readonly mounted: boolean; readonly bounds: BrowserSurfaceSnapshot['bounds']; readonly visible: boolean }): void;
  state(conversationId: string): BrowserViewState;
}

export interface InstallBrowserIpcOptions {
  readonly ipc: FeatureIpc;
  readonly view: () => BrowserIpcView | null;
  /** Only the app's own window speaks here: a page in a view has no preload and no channel. */
  readonly mainWebContents: () => unknown;
}

/** Monotonic within one renderer realm, one-way across renderer reloads. */
class SurfaceRevisions {
  private instanceId: string | null = null;
  private revision = 0;
  private readonly retired = new Set<string>();

  accept(surface: BrowserSurfaceSnapshot): boolean {
    if (this.retired.has(surface.instanceId)) return false;
    if (surface.instanceId !== this.instanceId) {
      if (this.instanceId) this.retired.add(this.instanceId);
      this.instanceId = surface.instanceId;
      this.revision = 0;
    }
    if (surface.revision <= this.revision) return false;
    this.revision = surface.revision;
    return true;
  }
}

/** The pane's place on screen and its state. What the person does goes through daemon commands, where the principal is checked. */
export function installBrowserIpc(options: InstallBrowserIpcOptions): () => void {
  const ipcMain = new IpcRegistration(options.ipc);
  const revisions = new SurfaceRevisions();
  try {
    ipcMain.on('browser:surface', (event, surface: unknown) => {
      if (event.sender !== options.mainWebContents() || !isBrowserSurfaceSnapshot(surface) || !revisions.accept(surface)) return;
      // The pane is not detachable, and its page lives in the app's window: anywhere else it stays parked.
      options.view()?.updateSurface(surface.conversationId, { mounted: surface.mounted, bounds: surface.bounds, visible: surface.visible && surface.windowName === 'main' });
    });
    ipcMain.handle('browser:state', (event, conversationId: unknown) => {
      if (event.sender !== options.mainWebContents() || typeof conversationId !== 'string') return null;
      return options.view()?.state(conversationId) ?? null;
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
