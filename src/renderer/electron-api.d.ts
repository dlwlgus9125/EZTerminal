/**
 * Type declaration for window.electronAPI exposed by preload via contextBridge.
 * Mirrors the ElectronAPI interface in src/preload/index.ts.
 */

import type { DirEntry } from "../main/filesystem";
import type { IpcResult } from "../shared/ipc-types";
import type { MetricsData } from "../shared/metrics-types";
import type { TrafficData } from "../shared/network-types";
import type { UserSettings } from "../shared/settings-types";

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
        load: () => Promise<IpcResult<UserSettings>>;
        save: (settings: UserSettings) => Promise<IpcResult<void>>;
      };
      metrics: {
        start: () => void;
        stop: () => void;
        onUpdate: (callback: (data: MetricsData) => void) => () => void;
      };
      network: {
        startCapture: () => void;
        stopCapture: () => void;
        onTraffic: (callback: (data: TrafficData) => void) => () => void;
      };
      fs: {
        readDir: (dirPath: string) => Promise<IpcResult<DirEntry[]>>;
        watch: (dirPath: string) => void;
        stopWatch: () => void;
        onChanged: (callback: (dirPath: string) => void) => () => void;
      };
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
      };
      scrollback: {
        save: (content: string) => Promise<{ ok: boolean; error?: string }>;
      };
      float: {
        popout: (panelId: string) => void;
        dock: (panelId: string) => void;
        onDocked: (callback: (panelId: string) => void) => () => void;
      };
    };
  }
}
