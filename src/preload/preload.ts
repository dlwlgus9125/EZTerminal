import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, type EzTerminalApi, type SystemStatsSnapshot } from '../shared/ipc';

// Preload runs with context isolation ON (architecture §1).
// We expose a NARROW, explicit API — never the raw ipcRenderer.
//
// MessagePort transfer through contextBridge:
//   contextBridge CANNOT transfer a MessagePort through a Promise resolution
//   value — it uses structured clone which produces a plain Object instead of
//   a live MessagePort (portCtor: "Object" confirmed in diagnostics).
//
//   The correct path: once the port arrives from main via ipcRenderer.once,
//   forward it to the renderer world using window.postMessage with a transfer
//   list. The renderer listens with window.addEventListener('message', ...)
//   and receives a real MessagePort in event.ports[0].
//
//   runCommand() resolves void once the port has been forwarded; the renderer
//   receives the port asynchronously via the window message event.

// One PERSISTENT cmd-port listener (not a per-run `once`). Main echoes the run's
// `runId` in the payload, so we forward each brokered port tagged with its runId —
// concurrent runs (across panes) can no longer grab each other's ports (Codex B3).
// Transfer to the renderer (main world) via window.postMessage: both isolated
// contexts share the same DOM window, so this crosses the boundary and delivers a
// LIVE MessagePort. targetOrigin '/' restricts delivery to our OWN origin (never
// '*', so a port can't leak to a foreign frame) and — unlike window.location.origin
// — also works under file://, whose opaque origin a string targetOrigin can't match
// (SEC-LOW-5).
ipcRenderer.on('cmd-port', (event, payload: { runId: string }) => {
  const port = event.ports[0];
  if (!port) return;
  window.postMessage({ _ezPort: payload?.runId }, '/', [port]);
});

// Same relay for the packet-capture sub-view's port (status-panel-v2 Phase 2B).
// Only one capture subscription is ever live, so a boolean marker replaces the
// per-run `runId` correlation cmd-port needs. Main never reads this port's
// traffic — packet batches AND capture status both flow renderer-ward over it.
ipcRenderer.on('packet-port', (event) => {
  const port = event.ports[0];
  if (!port) return;
  window.postMessage({ _ezPacketPort: true }, '/', [port]);
});

const api: EzTerminalApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },

  createSession: (cwd?: string): Promise<import('../shared/ipc').SessionInfo> =>
    ipcRenderer.invoke('create-session', cwd),

  destroySession: (sessionId: string): void => {
    ipcRenderer.send('destroy-session', sessionId);
  },

  runCommand: (commandText: string, runId: string, sessionId: string): Promise<void> => {
    // The port arrives asynchronously via the persistent 'cmd-port' listener above,
    // keyed by runId; the renderer registers its own window 'message' listener before
    // calling this, so resolving as soon as the request is sent is safe.
    ipcRenderer.send('run-command', { commandText, runId, sessionId });
    return Promise.resolve();
  },

  onSessionDead: (listener: (info?: { logPath?: string | null }) => void): (() => void) => {
    const handler = (_event: unknown, info?: { logPath?: string | null }): void => listener(info);
    ipcRenderer.on('session-dead', handler);
    return () => ipcRenderer.removeListener('session-dead', handler);
  },

  // Layout persistence (Track A ③): thin invoke wrappers — main validates all.
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: (rawLayout: unknown) => ipcRenderer.invoke('layout:save', rawLayout),
  flushLayout: () => ipcRenderer.invoke('layout:flush'),
  quarantineLayout: () => ipcRenderer.invoke('layout:quarantine'),
  listPresets: () => ipcRenderer.invoke('presets:list'),
  getPreset: (name: string) => ipcRenderer.invoke('presets:get', name),
  savePreset: (name: string, rawLayout: unknown) =>
    ipcRenderer.invoke('presets:save', name, rawLayout),
  deletePreset: (name: string) => ipcRenderer.invoke('presets:delete', name),
  getStartup: () => ipcRenderer.invoke('settings:get-startup'),
  setStartup: (pref: import('../shared/layout-schema').StartupPref) =>
    ipcRenderer.invoke('settings:set-startup', pref),

  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  setTheme: (theme: import('../shared/layout-schema').ThemeName) =>
    ipcRenderer.invoke('settings:set-theme', theme),

  // Status overlay panel stats (status-overlay-panel): push, invoke, send —
  // same shapes as onSessionDead/loadLayout/destroySession above.
  onStatsUpdate: (listener: (snapshot: SystemStatsSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, snapshot: SystemStatsSnapshot): void => listener(snapshot);
    ipcRenderer.on('stats:update', handler);
    return () => ipcRenderer.removeListener('stats:update', handler);
  },
  getStatsHistory: (): Promise<SystemStatsSnapshot[]> => ipcRenderer.invoke('stats:history'),
  setStatsPanelVisible: (visible: boolean): void => {
    ipcRenderer.send('stats:panel-visible', visible);
  },

  // Packet capture (status-panel-v2 Phase 2B): fire-and-forget sends, same
  // shape as destroySession/setStatsPanelVisible above. The port itself
  // arrives via the persistent 'packet-port' listener, not through these.
  subscribePackets: (): void => {
    ipcRenderer.send('packets:subscribe');
  },
  unsubscribePackets: (): void => {
    ipcRenderer.send('packets:unsubscribe');
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, api);
