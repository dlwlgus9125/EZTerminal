export const APP_RENDERER_HOST = 'ezterminal.invalid';
export const APP_RENDERER_ORIGIN = `https://${APP_RENDERER_HOST}`;
export const APP_RENDERER_ENTRY_PATH = '/index.html';
export const AUXILIARY_WINDOW_QUERY = 'ez-popout=1';

export type DesktopWindowKind = 'main' | 'auxiliary';

export interface DesktopWindowState {
  readonly kind: DesktopWindowKind;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
}

export type DesktopWindowAction = 'minimize' | 'toggle-maximize' | 'close';

export interface AuxiliaryCloseRequest {
  readonly requestId: string;
  /** Opaque Dockview window name. It is not an Electron BrowserWindow id. */
  readonly windowName: string;
}

export type AuxiliaryCloseResolution = 'allow' | 'cancel';

export function isDesktopWindowAction(value: unknown): value is DesktopWindowAction {
  return value === 'minimize' || value === 'toggle-maximize' || value === 'close';
}

export function isAuxiliaryCloseResolution(value: unknown): value is AuxiliaryCloseResolution {
  return value === 'allow' || value === 'cancel';
}

export function packagedRendererUrl(auxiliary = false): string {
  return auxiliary
    ? `${APP_RENDERER_ORIGIN}${APP_RENDERER_ENTRY_PATH}?${AUXILIARY_WINDOW_QUERY}`
    : `${APP_RENDERER_ORIGIN}${APP_RENDERER_ENTRY_PATH}`;
}
