import type { EzTerminalApi, EzTerminalDesktopApi } from './ipc';

// Augments the renderer's global `window` with the bridge exposed by the
// preload via `contextBridge.exposeInMainWorld`. The property name must match
// `BRIDGE_KEY` in ./ipc.ts.
declare global {
  interface Window {
    readonly ezterminal: EzTerminalApi;
    /** Desktop-only (theme-effects-font M3) — optional since mobile never
     * exposes it; every call site guards with `?.`. */
    readonly ezterminalDesktop?: EzTerminalDesktopApi;
  }
}

export {};
