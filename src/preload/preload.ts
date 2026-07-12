import { contextBridge, ipcRenderer } from 'electron';
import {
  BRIDGE_KEY,
  DESKTOP_BRIDGE_KEY,
  type EzTerminalApi,
  type EzTerminalDesktopApi,
  type RunStartedInfo,
  type SessionInfo,
  type SystemStatsSnapshot,
} from '../shared/ipc';
import type { ThemeMod } from '../shared/theme-schema';

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

// Same relay for a mirroring `attachRun`'s port (M2): keyed by `runId` exactly
// like `cmd-port` above (multiple concurrent attaches never mis-correlate).
ipcRenderer.on('attach-port', (event, payload: { runId: string }) => {
  const port = event.ports[0];
  if (!port) return;
  window.postMessage({ _ezAttachPort: payload?.runId }, '/', [port]);
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

  // Session mirroring (M2): full mirroring across desktop tabs + mobile.
  listSessions: (): Promise<readonly SessionInfo[]> => ipcRenderer.invoke('list-sessions'),
  listRuns: (): Promise<readonly RunStartedInfo[]> => ipcRenderer.invoke('list-runs'),
  onSessionAdded: (listener: (session: SessionInfo) => void): (() => void) => {
    const handler = (_event: unknown, session: SessionInfo): void => listener(session);
    ipcRenderer.on('session-added', handler);
    return () => ipcRenderer.removeListener('session-added', handler);
  },
  onSessionRemoved: (listener: (sessionId: string) => void): (() => void) => {
    const handler = (_event: unknown, sessionId: string): void => listener(sessionId);
    ipcRenderer.on('session-removed', handler);
    return () => ipcRenderer.removeListener('session-removed', handler);
  },
  onRunStarted: (listener: (info: RunStartedInfo) => void): (() => void) => {
    const handler = (_event: unknown, info: RunStartedInfo): void => listener(info);
    ipcRenderer.on('run-started', handler);
    return () => ipcRenderer.removeListener('run-started', handler);
  },
  attachRun: (sessionId: string, runId: string): Promise<void> => {
    // The port arrives asynchronously via the persistent 'attach-port' listener
    // above, keyed by runId — same shape as runCommand's cmd-port (see its doc).
    ipcRenderer.send('attach-run', { sessionId, runId });
    return Promise.resolve();
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

  getUiScale: () => ipcRenderer.invoke('settings:get-ui-scale'),
  setUiScale: (uiScale: number) => ipcRenderer.invoke('settings:set-ui-scale', uiScale),

  getScrollback: () => ipcRenderer.invoke('settings:get-scrollback'),
  setScrollback: (scrollback: number) => ipcRenderer.invoke('settings:set-scrollback', scrollback),

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

  // Mobile remote-control pairing (M4): thin invoke wrappers — main computes
  // everything (LAN IPs, token store access).
  getRemoteConnectionInfo: () => ipcRenderer.invoke('remote:get-connection-info'),
  getRemoteToken: () => ipcRenderer.invoke('remote:get-token'),
  rotateRemoteToken: () => ipcRenderer.invoke('remote:rotate-token'),
  getRemoteEnabled: () => ipcRenderer.invoke('remote:get-enabled'),
  setRemoteEnabled: (enabled: boolean) => ipcRenderer.invoke('remote:set-enabled', enabled),

  // File explorer (file-explorer plan, M1): thin invoke wrappers — main's
  // FileService is the sole fs authority.
  listFiles: (path: string) => ipcRenderer.invoke('files:list', path),
  listFileRoots: () => ipcRenderer.invoke('files:roots'),
  readTextFile: (path: string) => ipcRenderer.invoke('files:read-text', path),
  createFolder: (dirPath: string, name: string) => ipcRenderer.invoke('files:mkdir', dirPath, name),
  renameFile: (path: string, newName: string) => ipcRenderer.invoke('files:rename', path, newName),
  trashFile: (path: string) => ipcRenderer.invoke('files:trash', path),
  openFileInApp: (path: string) => ipcRenderer.invoke('files:open-path', path),
  revealFileInExplorer: (path: string) => ipcRenderer.invoke('files:reveal', path),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, api);

// Desktop-only bridge (theme-effects-font M3) — a SEPARATE object from `api`
// above, not merged into it (see EzTerminalDesktopApi's doc in shared/ipc.ts
// for why: mobile has no implementation of these, and folding them into the
// shared EzTerminalApi would force mobile's transport to stub every one).
const desktopApi: EzTerminalDesktopApi = {
  getAvailableThemes: (): Promise<ThemeMod[]> => ipcRenderer.invoke('theme:get-available'),
  importTheme: (json: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('theme:import', json),
  getFont: (): Promise<string | undefined> => ipcRenderer.invoke('settings:get-font'),
  setFont: (id: string): Promise<void> => ipcRenderer.invoke('settings:set-font', id),
  getEffectToggles: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('settings:get-effect-toggles'),
  setEffectToggles: (toggles: Record<string, boolean>): Promise<void> =>
    ipcRenderer.invoke('settings:set-effect-toggles', toggles),
  getRollbar: (): Promise<import('../shared/layout-schema').RollbarSettings> =>
    ipcRenderer.invoke('settings:get-rollbar'),
  setRollbar: (params: import('../shared/layout-schema').RollbarSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set-rollbar', params),
  getEffectParams: (): Promise<import('../shared/layout-schema').EffectParamsSettings> =>
    ipcRenderer.invoke('settings:get-effect-params'),
  setEffectParams: (params: import('../shared/layout-schema').EffectParamsSettings): Promise<void> =>
    ipcRenderer.invoke('settings:set-effect-params', params),

  // OpenClaw management (openclaw-management M1): thin invoke/send wrappers —
  // main's OpenClawService is the sole authority, same shape as the file
  // explorer/settings wrappers above.
  getOpenClawStatus: (force?: boolean): Promise<import('../shared/openclaw').OpenClawStatus> =>
    ipcRenderer.invoke('openclaw:get-status', force),
  runOpenClawLifecycle: (
    action: import('../shared/openclaw').OpenClawLifecycleAction,
  ): Promise<import('../shared/openclaw').OpenClawLifecycleResult> => ipcRenderer.invoke('openclaw:lifecycle', action),
  listOpenClawSessions: (): Promise<readonly import('../shared/openclaw').OpenClawAgentSession[]> =>
    ipcRenderer.invoke('openclaw:list-sessions'),
  getOpenClawConfig: (): Promise<import('../shared/openclaw').OpenClawCoreConfig> =>
    ipcRenderer.invoke('openclaw:get-config'),
  setOpenClawConfig: (key: string, value: string): Promise<import('../shared/openclaw').OpenClawSetConfigResult> =>
    ipcRenderer.invoke('openclaw:set-config', key, value),
  isOpenClawChatAvailable: (): Promise<boolean> => ipcRenderer.invoke('openclaw:chat-available'),
  setOpenClawDrawerOpen: (open: boolean): void => {
    ipcRenderer.send('openclaw:set-drawer-open', open);
  },
  onOpenClawStatus: (listener: (status: import('../shared/openclaw').OpenClawStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: import('../shared/openclaw').OpenClawStatus): void => listener(status);
    ipcRenderer.on('openclaw:status', handler);
    return () => ipcRenderer.removeListener('openclaw:status', handler);
  },
  onOpenClawLog: (listener: (line: import('../shared/openclaw').OpenClawLogLine) => void): (() => void) => {
    const handler = (_event: unknown, line: import('../shared/openclaw').OpenClawLogLine): void => listener(line);
    ipcRenderer.on('openclaw:log', handler);
    return () => ipcRenderer.removeListener('openclaw:log', handler);
  },
  runOpenClawAutostart: (
    action: import('../shared/openclaw').OpenClawAutostartAction,
  ): Promise<import('../shared/openclaw').OpenClawAutostartResult> => ipcRenderer.invoke('openclaw:autostart', action),

  // OpenClaw desktop visibility (openclaw-stabilization M2): thin invoke/send
  // wrappers, same shape as the management wrappers above.
  getOpenClawMode: (): Promise<import('../shared/layout-schema').OpenClawMode> =>
    ipcRenderer.invoke('settings:get-openclaw-mode'),
  setOpenClawMode: (mode: import('../shared/layout-schema').OpenClawMode): Promise<void> =>
    ipcRenderer.invoke('settings:set-openclaw-mode', mode),
  getOpenClawVisibility: (): Promise<import('../shared/openclaw').OpenClawVisibility> =>
    ipcRenderer.invoke('openclaw:get-visibility'),
  onOpenClawVisibilityChanged: (
    listener: (visibility: import('../shared/openclaw').OpenClawVisibility) => void,
  ): (() => void) => {
    const handler = (_event: unknown, visibility: import('../shared/openclaw').OpenClawVisibility): void =>
      listener(visibility);
    ipcRenderer.on('openclaw:visibility-changed', handler);
    return () => ipcRenderer.removeListener('openclaw:visibility-changed', handler);
  },

  // OpenClaw chat panel (openclaw-management M3): fire-and-forget sends into
  // OpenClawChatViewManager, same shape as the drawer wrappers above.
  setOpenClawChatPanelMounted: (mounted: boolean): void => {
    ipcRenderer.send('openclaw:chat-panel-mounted', mounted);
  },
  openOpenClawChatView: (): void => {
    ipcRenderer.send('openclaw:chat-open');
  },
  closeOpenClawChatView: (): void => {
    ipcRenderer.send('openclaw:chat-close');
  },
  setOpenClawChatBounds: (bounds: import('../shared/openclaw').OpenClawChatBounds): void => {
    ipcRenderer.send('openclaw:chat-bounds', bounds);
  },
  setOpenClawChatVisible: (visible: boolean): void => {
    ipcRenderer.send('openclaw:chat-visible', visible);
  },
  reloadOpenClawChatView: (): void => {
    ipcRenderer.send('openclaw:chat-reload');
  },
  onOpenClawChatViewState: (
    listener: (state: import('../shared/openclaw').OpenClawChatViewState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: import('../shared/openclaw').OpenClawChatViewState): void =>
      listener(state);
    ipcRenderer.on('openclaw:chat-view-state', handler);
    return () => ipcRenderer.removeListener('openclaw:chat-view-state', handler);
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, desktopApi);
