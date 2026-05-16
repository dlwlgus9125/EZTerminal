import { contextBridge, ipcRenderer } from "electron";
import type { IpcResult } from "../shared/ipc-types";
import type { MetricsData } from "../shared/metrics-types";
import type { TrafficData } from "../shared/network-types";
import type { UserSettings } from "../shared/settings-types";

// Typed API surface exposed to renderer
// Renderer accesses this via window.electronAPI
export interface ElectronAPI {
  // PTY channels
  pty: {
    create: (opts: { cols: number; rows: number; shell?: string }) => Promise<IpcResult<string>>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => Promise<void>;
    onData: (id: string, callback: (data: string) => void) => () => void;
    onExit: (id: string, callback: (code: number) => void) => () => void;
  };
  // Settings channels
  settings: {
    load: () => Promise<IpcResult<UserSettings>>;
    save: (settings: UserSettings) => Promise<IpcResult<void>>;
  };
  // Metrics channels
  metrics: {
    start: () => void;
    stop: () => void;
    onUpdate: (callback: (data: MetricsData) => void) => () => void;
  };
  // Network channels
  network: {
    startCapture: () => void;
    stopCapture: () => void;
    onTraffic: (callback: (data: TrafficData) => void) => () => void;
  };
  // Window control
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
  };
}

const electronAPI: ElectronAPI = {
  pty: {
    create: (opts) => ipcRenderer.invoke("pty:create", opts),
    write: (id, data) => ipcRenderer.send("pty:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("pty:kill", id),
    onData: (id, callback) => {
      const channel = `pty:data:${id}`;
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (id, callback) => {
      const channel = `pty:exit:${id}`;
      const handler = (_event: Electron.IpcRendererEvent, code: number) => callback(code);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  settings: {
    load: () => ipcRenderer.invoke("settings:load") as Promise<IpcResult<UserSettings>>,
    save: (settings) => ipcRenderer.invoke("settings:save", settings) as Promise<IpcResult<void>>,
  },
  metrics: {
    start: () => ipcRenderer.send("metrics:start"),
    stop: () => ipcRenderer.send("metrics:stop"),
    onUpdate: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MetricsData) => callback(data);
      ipcRenderer.on("metrics:update", handler);
      return () => ipcRenderer.removeListener("metrics:update", handler);
    },
  },
  network: {
    startCapture: () => ipcRenderer.send("network:start"),
    stopCapture: () => ipcRenderer.send("network:stop"),
    onTraffic: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TrafficData) => callback(data);
      ipcRenderer.on("network:traffic", handler);
      return () => ipcRenderer.removeListener("network:traffic", handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
