/**
 * Mock for Electron APIs in test environments.
 * Provides typed stubs for ipcRenderer and contextBridge.
 */

import { vi } from "vitest";

type IpcHandler = (...args: unknown[]) => unknown;

const ipcListeners: Map<string, IpcHandler[]> = new Map();
const ipcInvokeHandlers: Map<string, IpcHandler> = new Map();

export const mockIpcRenderer = {
  send: vi.fn((_channel: string, ..._args: unknown[]) => {
    // noop stub
  }),
  invoke: vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = ipcInvokeHandlers.get(channel);
    if (handler) {
      return handler(...args);
    }
    return undefined;
  }),
  on: vi.fn((channel: string, handler: IpcHandler) => {
    const listeners = ipcListeners.get(channel) ?? [];
    listeners.push(handler);
    ipcListeners.set(channel, listeners);
  }),
  removeListener: vi.fn((channel: string, handler: IpcHandler) => {
    const listeners = ipcListeners.get(channel) ?? [];
    const filtered = listeners.filter((l) => l !== handler);
    ipcListeners.set(channel, filtered);
  }),
  removeAllListeners: vi.fn((channel?: string) => {
    if (channel) {
      ipcListeners.delete(channel);
    } else {
      ipcListeners.clear();
    }
  }),
};

export const mockContextBridge = {
  exposeInMainWorld: vi.fn((key: string, api: unknown) => {
    // Simulate contextBridge by attaching to window
    (window as unknown as Record<string, unknown>)[key] = api;
  }),
};

/**
 * Register a handler for ipcRenderer.invoke mock
 */
export function registerInvokeHandler(channel: string, handler: IpcHandler): void {
  ipcInvokeHandlers.set(channel, handler);
}

/**
 * Emit an IPC event (simulate main→renderer message)
 */
export function emitIpcEvent(channel: string, ...args: unknown[]): void {
  const listeners = ipcListeners.get(channel) ?? [];
  for (const listener of listeners) {
    // ipcRenderer event listeners receive (event, ...args)
    listener({} as Electron.IpcRendererEvent, ...args);
  }
}

/**
 * Reset all mock state between tests
 */
export function resetElectronMocks(): void {
  ipcListeners.clear();
  ipcInvokeHandlers.clear();
  mockIpcRenderer.send.mockClear();
  mockIpcRenderer.invoke.mockClear();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();
  mockIpcRenderer.removeAllListeners.mockClear();
  mockContextBridge.exposeInMainWorld.mockClear();
}
