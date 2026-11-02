import { isBrowserSurfaceSnapshot, parseBrowserSettings, type BrowserProjectSites, type BrowserSettings, type BrowserSurfaceSnapshot, type BrowserViewState } from '../shared/browser';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface BrowserIpcView {
  updateSurface(conversationId: string, surface: { readonly mounted: boolean; readonly bounds: BrowserSurfaceSnapshot['bounds']; readonly visible: boolean }): void;
  state(conversationId: string): BrowserViewState;
}

/** Settings › 에이전트 › 내장 브라우저. */
export interface BrowserSettingsHost {
  load(): Promise<{ readonly settings: BrowserSettings; readonly sites: readonly BrowserProjectSites[] }>;
  save(settings: BrowserSettings): Promise<BrowserSettings>;
  revokeSite(projectId: string, origin: string): Promise<readonly BrowserProjectSites[]>;
  clearData(): Promise<void>;
}

export interface InstallBrowserIpcOptions {
  readonly ipc: FeatureIpc;
  readonly view: () => BrowserIpcView | null;
  /** Only the app's own window speaks here: a page in a view has no preload and no channel. */
  readonly mainWebContents: () => unknown;
  readonly settings?: BrowserSettingsHost;
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
    const person = (event: { readonly sender: unknown }): BrowserSettingsHost => {
      if (event.sender !== options.mainWebContents() || !options.settings) throw new Error('Browser settings belong to the app\'s own window.');
      return options.settings;
    };
    ipcMain.handle('browser:settings', async (event) => person(event).load());
    ipcMain.handle('browser:set-settings', async (event, value: unknown) => {
      const host = person(event);
      const settings = parseBrowserSettings(value);
      if (!settings) throw new Error('Those are not browser settings.');
      return host.save(settings);
    });
    ipcMain.handle('browser:revoke-site', async (event, projectId: unknown, origin: unknown) => {
      const host = person(event);
      if (typeof projectId !== 'string' || typeof origin !== 'string') throw new Error('That is not a site of a project.');
      return host.revokeSite(projectId, origin);
    });
    ipcMain.handle('browser:clear-data', async (event) => person(event).clearData());
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
