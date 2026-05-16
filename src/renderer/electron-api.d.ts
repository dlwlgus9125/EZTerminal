/**
 * Type declaration for window.electronAPI exposed by preload via contextBridge.
 * Mirrors the ElectronAPI interface in src/preload/index.ts.
 */

import type { IpcResult } from "../shared/ipc-types";

declare global {
  interface Window {
    electronAPI: {
      pty: {
        create: (opts: { cols: number; rows: number; shell?: string }) => Promise<IpcResult<string>>;
        write: (id: string, data: string) => void;
        resize: (id: string, cols: number, rows: number) => void;
        kill: (id: string) => Promise<void>;
        onData: (id: string, callback: (data: string) => void) => () => void;
        onExit: (id: string, callback: (code: number) => void) => () => void;
      };
      settings: {
        load: () => Promise<unknown>;
        save: (settings: unknown) => Promise<void>;
      };
      metrics: {
        start: () => void;
        stop: () => void;
        onUpdate: (callback: (data: unknown) => void) => () => void;
      };
      network: {
        startCapture: () => void;
        stopCapture: () => void;
        onTraffic: (callback: (data: unknown) => void) => () => void;
      };
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
      };
    };
  }
}
