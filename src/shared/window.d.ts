import type { EzTerminalApi } from './ipc';

// Augments the renderer's global `window` with the bridge exposed by the
// preload via `contextBridge.exposeInMainWorld`. The property name must match
// `BRIDGE_KEY` in ./ipc.ts.
declare global {
  interface Window {
    readonly ezterminal: EzTerminalApi;
  }
}

export {};
