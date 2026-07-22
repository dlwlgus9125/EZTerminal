import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type { UtilityProcess, MessagePortMain, Rectangle } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import started from 'electron-squirrel-startup';

import { isAppUrl } from './url-guard';
import { buildMenuTemplate } from './app-menu';
import { FileService } from './file-service';
import { LayoutStore } from './layout-store';
import { getAvailableThemes, importTheme } from './theme-store';
import { ScriptHostRegistry } from './script-host-registry';
import { PacketCaptureRegistry } from './packet-capture-registry';
import { PacketMirror } from './packet-mirror';
import { KnownHostsStore } from './known-hosts-store';
import { LogFile, pruneCrashDumps } from './diagnostics';
import { SystemStatsService } from './system-stats-service';
import { StatsVisibility } from './stats-visibility';
import { RemoteTokenStore } from './remote-token-store';
import { OpenClawService } from './openclaw-service';
import { OpenClawChatViewManager } from './openclaw-chat-view';
import { startOpenClawProxy, DEFAULT_OPENCLAW_PROXY_PORT, type OpenClawProxyHandle } from './openclaw-proxy';
import { InterpreterBroker, type BrokerInterpreter } from './interpreter-broker';
import { SshForwardService } from './ssh-forward-service';
import { sshForwardFailure, type SshForwardResult } from '../shared/ssh-forward';
import { AgentActivityService, type AgentActivityTransition } from './agent-activity-service';
import { AgentHookRelay, isAgentIntegrationProvider } from './agent-hook-relay';
import { AgentHookInstaller } from './agent-hook-installer';
import { AgentSettingsStore } from './agent-settings-store';
import { QuickCommandStore } from './quick-command-store';
import { WorkspaceFileSearchService } from './workspace-file-search-service';
import { WorktreeService } from './worktree-service';
import { AsyncMutationGate } from './async-mutation-gate';
import { SessionWorktreeGuard } from './session-worktree-guard';
import {
  startRemoteBridge,
  DEFAULT_REMOTE_BRIDGE_PORT,
  type RemoteFileSource,
  type RemoteOpenClawSource,
  type RemotePacketSource,
  type RemoteQuickCommandSource,
  type RemoteStatsSource,
} from './remote-bridge';
import { RemoteRuntimeController, RemoteRuntimeStartError } from './remote-runtime';
import { formatConnectionInfo } from './remote-connection-info';
import {
  TerminalRendererPreferenceSchema,
  type EffectParamsSettings,
  type OpenClawMode,
  type RollbarSettings,
  type StartupPref,
  type ThemeName,
} from '../shared/layout-schema';
import {
  MAX_GUARDED_DESTROY_RUN_IDS,
  MAX_GUARDED_DESTROY_SESSIONS,
} from '../shared/ipc';
import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
  InterpreterToMain,
  MainToInterpreter,
  RunStartedInfo,
  RemoteRuntimeStatus,
  SessionInfo,
  SystemStatsSnapshot,
} from '../shared/ipc';
import type { OpenClawAutostartAction, OpenClawLifecycleAction, OpenClawVisibility } from '../shared/openclaw';
import type { AgentFollowupResult } from '../shared/agent';
import { normalizeExternalHttpUrl } from '../shared/external-url';
import { classifyRecentPanelInput } from './recent-panel-input';
import type { WorkspaceFileSearchRequest } from '../shared/workspace-search';
import { isWorktreeRequest, type WorktreeInfo, type WorktreeResult } from '../shared/worktree';
import type { TerminalFileLocationRequest } from '../shared/terminal-file-location';
import { resolveTerminalFileLocation } from './terminal-path-resolver';
import { readTerminalClipboardSnapshot } from './terminal-clipboard';
import { isTerminalPastePreferences } from '../shared/terminal-clipboard';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
import {
  UiPreferencesPatchSchema,
  resolveUiLocale,
  type UiLocalePreference,
} from '../shared/ui-preferences';

const osc52LastWrite = new WeakMap<object, number>();
const OSC52_MAIN_MAX_BYTES = 64 * 1024;
const OSC52_MAIN_MIN_INTERVAL_MS = 1_000;

// The main process owns the interpreter utilityProcess lifetime (architecture
// §1). Per-command MessagePort brokering + session/run correlation live in the
// extracted InterpreterBroker (interpreter-broker.ts); main (local IPC) and
// remote-bridge (WS) are thin adapters over one shared instance, so bulk frame
// data never routes through main.

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Test seam (Track A ③): e2e/packaged smoke isolate persistence in a temp dir.
// Must run BEFORE 'ready' so every userData consumer sees the override. Set only
// by test harnesses; production never defines it.
if (process.env.EZTERMINAL_USER_DATA_DIR) {
  app.setPath('userData', process.env.EZTERMINAL_USER_DATA_DIR);
}

// Production is single-instance so a second desktop cannot silently steal the
// fixed remote/proxy ports or present a different pairing token. Test harnesses
// that intentionally launch isolated instances must opt out explicitly.
const allowMultipleInstances = process.env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES === '1';
if (!started && !allowMultipleInstances) {
  const primaryInstance = app.requestSingleInstanceLock();
  if (!primaryInstance) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const mainWindow = mainWindowRef ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
}

// ── Local-only crash capture (B-M5) ──────────────────────────────────────────
// Minidumps land in app.getPath('crashDumps') and NOTHING is uploaded — no
// submitURL, uploadToServer:false. External crash reporting (e.g. Sentry) is a
// documented opt-in decision, deliberately not implemented. Must start before
// 'ready' to cover early renderer/GPU crashes.
crashReporter.start({ uploadToServer: false });

// Append-only error log with size-cap rotation (userData/logs/main.log). The
// LogFile itself never throws — diagnostics must not crash what they diagnose.
let mainLog: LogFile | null = null;
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
  mainLog?.line(`uncaughtException: ${err?.stack ?? String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
  mainLog?.line(`unhandledRejection: ${String(reason)}`);
});

// Interpreter utilityProcess — created once on 'ready', lives for the app lifetime.
let interpreter: UtilityProcess | null = null;
let appIsQuitting = false;

// The single main-side broker over the interpreter — created once on 'ready'
// right after the fork. main (local IPC) and remote-bridge (WS) are thin
// adapters over this ONE instance; it owns the create-session/list-runs
// correlation state, the run/attach port brokering, and the session/run dispatch.
let broker: InterpreterBroker | null = null;

// Loopback-only local forwarding over existing authenticated SSH sessions.
// The service owns listener/socket lifetimes and is disposed with the app or
// immediately when the interpreter exits.
let sshForwardService: SshForwardService | null = null;

// Status overlay panel stats collector — created once on 'ready' (status-overlay-panel).
let systemStatsService: SystemStatsService | null = null;

// Packet-capture host registry (Phase 2B) — created once on 'ready'; referenced
// from createWindow()'s lifecycle hooks below, so (like systemStatsService) it
// must be a module-level `let`, not a local const inside the 'ready' handler.
let packetCaptureRegistry: PacketCaptureRegistry | null = null;

// Desired setting + observed mobile remote-control listener lifecycle.
let remoteRuntimeController: RemoteRuntimeController | null = null;

// OpenClaw reverse proxy (openclaw-management M4) — started lazily by the
// first authenticated chat-ticket request, independently of the core bridge.
let openClawProxyHandle: OpenClawProxyHandle | null = null;

// OpenClaw management service (openclaw-management M1) — created once on
// 'ready'; referenced only for before-quit dispose() below (all its IPC
// handlers close over a local const, see the 'ready' handler).
let openClawService: OpenClawService | null = null;

// OpenClaw chat WebContentsView manager (openclaw-management M3) — created
// once on 'ready', attached to the main window in createWindow() (needs a
// module-level ref, mirrors mainWindowRef below), torn down on window
// reload/close (packetCaptureRegistry teardown hygiene precedent) and quit.
let openClawChatView: OpenClawChatViewManager | null = null;

// The main BrowserWindow — module-level (like the refs above) because
// createWindow() itself is defined outside 'ready', and openClawChatView's
// attach() needs a handle to the window it should embed into.
let mainWindowRef: BrowserWindow | null = null;

/**
 * OpenClaw desktop visibility (openclaw-stabilization M2): resolves the
 * tri-state `openclawMode` setting into an effective on/off. 'auto' defers to
 * `isInstalled` (OpenClawService.isInstalled(), TTL'd negative-cache); 'on'/
 * 'off' are unconditional. A standalone function (not a closure over one
 * OpenClawService instance) so the WS remote bridge (M3) can reuse it.
 */
async function resolveOpenClawVisibility(
  mode: OpenClawMode,
  isInstalled: () => Promise<boolean>,
): Promise<boolean> {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isInstalled();
}

// OpenClaw desktop visibility (openclaw-stabilization M5): in 'auto' mode,
// `resolveOpenClawVisibility` above only ever reruns on boot or an explicit
// mode toggle — nothing re-queries `isInstalled()` on its own, so installing
// or uninstalling the openclaw CLI mid-session never updates gating until
// one of those happens. This drives a periodic recheck (main.ts, near the
// other openclaw wiring) that's a no-op outside 'auto' mode.
const OPENCLAW_VISIBILITY_RECHECK_MS = 30_000;

/** Rebuild the terminal-safe native menu when the UI language changes. */
function applyNativeMenuLocale(preference: UiLocalePreference): void {
  const locale = resolveUiLocale(preference, app.getPreferredSystemLanguages());
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(locale)));
}

// Defense-in-depth CSP for the raw-HTML injection sink in TextBlock (the ANSI →
// HTML external output, sanitized upstream by ansi_up). Strict: only same-origin
// scripts, no inline/eval scripts, no remote connections, no <object>/<base>/
// framing (SEC-MED-3). `style-src` keeps 'unsafe-inline' because ansi_up colors
// are emitted as inline style attributes.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'; " +
  "form-action 'none'";

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'EZTerminal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security defaults kept explicit: the renderer never gets Node access;
      // it talks to main only through the narrow preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  });
  mainWindowRef = mainWindow;
  openClawChatView?.attach(mainWindow);

  // Chromium reserves Ctrl+Tab before a renderer KeyboardEvent exists (the
  // real Electron E2E observes ControlLeft but no Tab keydown). Capture only
  // that chord here, suppress its native handling, and forward a data-free
  // cycle/commit/cancel union through the isolated desktop bridge. All other
  // keyboard input, including terminal Ctrl chords, stays on the normal path.
  let recentPanelInputActive = false;
  const sendRecentPanelInput = (input: import('../shared/ipc').RecentPanelInputEvent): void => {
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('recent-panels:input', input);
    }
  };
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const decision = classifyRecentPanelInput(recentPanelInputActive, input);
    recentPanelInputActive = decision.active;
    if (!decision.event) return;
    if (decision.preventDefault) event.preventDefault();
    sendRecentPanelInput(decision.event);
  });
  mainWindow.on('blur', () => {
    if (!recentPanelInputActive) return;
    recentPanelInputActive = false;
    sendRecentPanelInput({ type: 'cancel', restoreFocus: false });
  });

  // ── Navigation hardening (SEC-HIGH-2) ─────────────────────────────────────
  // An OSC-8 link in external output (TextBlock <a href>) must never navigate the
  // window to a remote origin (it would inherit window.ezterminal). Block any
  // in-window navigation away from the app origin, and route external links to the
  // OS browser instead of opening a renderer-privileged window.
  // The ONLY file:// URL that may load is our own packaged index.html (B-M6:
  // arbitrary file:// would hand the bridge to any local html file).
  const appRendererUrl = pathToFileURL(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  ).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL, appRendererUrl)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = normalizeExternalHttpUrl(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[main] renderer finished loading');
  });

  // A dead/killed renderer is a crash-grade event worth local evidence (B-M5).
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    mainLog?.line(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  // A reload must not leave the status overlay's panel-open-only collectors
  // running against a renderer that no longer thinks the panel is open
  // (status-overlay-panel: panelVisible lifecycle).
  mainWindow.webContents.on('did-navigate', () => {
    recentPanelInputActive = false;
    systemStatsService?.setPanelVisible(false);
    // Same reasoning for the packet-capture sub-view (Phase 2B): a reload
    // drops the renderer's port reference, so any live host is now orphaned.
    packetCaptureRegistry?.kill();
    // Same reasoning again for the OpenClaw chat view (M3): a reload drops
    // the renderer's bounds/visibility reporting, orphaning the WebContentsView.
    openClawChatView?.destroy();
  });

  // Window destroy (Phase 2B): stop any live capture host — it must not
  // outlive the window whose renderer it was streaming packets to.
  mainWindow.on('closed', () => {
    packetCaptureRegistry?.kill();
    openClawChatView?.destroy();
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  // ── Per-command MessagePort brokering (architecture §3) ───────────────────
  // For each run-command IPC from the renderer:
  //   1. Create a MessageChannelMain (port1, port2).
  //   2. Transfer port2 to the interpreter utilityProcess with the command.
  //   3. Transfer port1 to the renderer via webContents.postMessage.
  // After this, renderer ↔ interpreter communicate directly over the port
  // without routing bulk frame data through main.
  ipcMain.on(
    'run-command',
    (event, payload: { commandText: string; runId: string; sessionId: string }) => {
      if (!broker) {
        console.error('[main] interpreter not ready for command:', payload?.commandText);
        return;
      }
      const { commandText, runId, sessionId } = payload;
      const port1 = broker.runCommand(sessionId, runId, commandText);
      // A truthy broker over a DEAD interpreter returns null — restore the
      // pre-broker "not ready" log (parity), then skip the transfer.
      if (!port1) {
        console.error('[main] interpreter not ready for command:', commandText);
        return;
      }
      // Transfer port1 to renderer — arrives as a DOM MessagePort via event.ports.
      // Echo `runId` so the preload/renderer correlate THIS port to THIS run even
      // when multiple runs are in flight across panes (Codex B3).
      event.sender.postMessage('cmd-port', { runId }, [port1 as unknown as MessagePortMain]);
      console.log(`[main] brokered port for run ${runId} in session ${sessionId}`);
    },
  );
};

app.on('ready', () => {
  console.log('[main] EZTerminal main process ready');

  // Terminal-safe application menu (WT-parity M1): replaces Electron's default
  // menu, whose reload/close accelerators would otherwise steal Ctrl+R /
  // Ctrl+Shift+R / Ctrl+W / F5 from the terminal — see app-menu.ts.
  applyNativeMenuLocale('system');

  // Diagnostics (B-M5): error log under userData, dump retention keep-last-10
  // (proposed default). Local only — see crashReporter.start above.
  mainLog = new LogFile(path.join(app.getPath('userData'), 'logs', 'main.log'));
  void pruneCrashDumps(app.getPath('crashDumps'));

  // ── Layout persistence (Track A ③) ────────────────────────────────────────
  // Main owns the fs; the renderer passes raw api.toJSON() output and main
  // sanitizes/validates everything (Codex gate B5). init() is awaited by every
  // handler via `storeReady` so stale .tmp cleanup always precedes first use.
  const layoutStore = new LayoutStore(path.join(app.getPath('userData')));
  const storeReady = layoutStore.init().catch((err) => {
    console.error('[main] layout store init failed:', err);
  });
  // Replace the system-language bootstrap menu with the persisted choice as
  // soon as settings are available. The renderer does not need to be mounted.
  void storeReady
    .then(() => layoutStore.getUiPreferences())
    .then((preferences) => applyNativeMenuLocale(preferences.locale))
    .catch((err) => console.error('[main] native menu locale load failed:', err));
  const quickCommandStore = new QuickCommandStore(path.join(app.getPath('userData')));
  const quickCommandsReady = quickCommandStore.init().catch((err) => {
    console.error('[main] quick command store init failed:', err);
  });
  const workspaceFileSearch = new WorkspaceFileSearchService();
  quickCommandStore.subscribe((commands) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('quick-commands:changed', commands);
    }
  });

  // Agent activity persistence + loopback hook relay. The relay binds only to
  // 127.0.0.1 and its bearer descriptor is injected into interpreter shell
  // sessions below; it never crosses preload or the mobile bridge.
  const agentSettingsStore = new AgentSettingsStore(path.join(app.getPath('userData')));
  let agentActivityService: AgentActivityService | null = null;
  let agentRelayReady = false;
  const agentHookRelay = new AgentHookRelay(app.getPath('userData'), (event) => {
    agentActivityService?.handleHookEvent(event);
  });
  const agentInfrastructureReady = Promise.all([agentSettingsStore.init(), agentHookRelay.start()])
    .then(() => {
      agentRelayReady = true;
    })
    .catch((err) => {
      console.error('[main] agent hook infrastructure init failed:', err);
    });
  const agentHookInstaller = new AgentHookInstaller(app.getPath('home'), agentHookRelay.scriptPath);

  // ── Status overlay panel stats (status-overlay-panel + mobile M1) ─────────
  // The service always ticks its graph loop (CPU/MEM ring buffer, app
  // lifetime); this callback decides whether to PUSH a snapshot to desktop
  // windows (gated on `desktopStatsVisible` — a plain bool, deliberately NOT
  // `systemStatsService.isPanelVisible()` anymore: that now reflects the
  // COMBINED desktop-or-remote refcount via `statsVisibility` below, and
  // gating the desktop push on it would leak stats-update to desktop windows
  // just because a phone subscribed. Desktop behavior stays bit-identical).
  // Every snapshot ALSO fans out unconditionally to `remoteStatsListeners` —
  // per-connection gating is inherent, since a listener only exists in that
  // set while that connection's own `stats-visible:true` is active.
  let desktopStatsVisible = false;
  const remoteStatsListeners = new Set<(snapshot: SystemStatsSnapshot) => void>();
  systemStatsService = new SystemStatsService(mainLog, (snapshot) => {
    if (desktopStatsVisible) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        win.webContents.send('stats:update', snapshot);
      }
    }
    for (const listener of remoteStatsListeners) listener(snapshot);
  });
  systemStatsService.start();
  const statsVisibility = new StatsVisibility((effective) => systemStatsService?.setPanelVisible(effective));
  ipcMain.handle('stats:history', () => systemStatsService?.getHistory() ?? []);
  ipcMain.on('stats:panel-visible', (_event, visible: boolean) => {
    desktopStatsVisible = Boolean(visible);
    statsVisibility.setDesktopVisible(desktopStatsVisible);
  });

  // ── File explorer (file-explorer plan, M1) ────────────────────────────────
  // FileService is the single fs authority; this instance is also handed to
  // the WS bridge's `RemoteFileSource` seam in M3. `openFileInApp`/
  // `revealFileInExplorer` stay here (Electron `shell`, desktop-only) rather
  // than in FileService, which stays electron-free.
  const fileService = new FileService({ trashItem: (p) => shell.trashItem(p) });
  const terminalCapabilitiesBySender = new WeakMap<object, TerminalFileCapabilityStore>();
  const terminalCapabilitiesFor = (sender: object): TerminalFileCapabilityStore => {
    let store = terminalCapabilitiesBySender.get(sender);
    if (!store) {
      store = new TerminalFileCapabilityStore();
      terminalCapabilitiesBySender.set(sender, store);
    }
    return store;
  };
  const sessionWorktreeMutationGate = new AsyncMutationGate();
  const sessionWorktreeRunGuard = new SessionWorktreeGuard();
  const worktreeService = new WorktreeService({
    userDataDir: app.getPath('userData'),
    getSessionCwds: () => broker?.listSessions().map((item) => item.cwd) ?? [],
    mutationGate: sessionWorktreeMutationGate,
    runGuard: sessionWorktreeRunGuard,
  });
  const notifyDesktopWorktreeOpen = (worktree: WorktreeInfo): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('worktrees:open-requested', worktree);
    }
  };
  const pendingWorktreeActions = new Map<string, AbortController>();
  ipcMain.handle('worktrees:execute', async (event, request: unknown): Promise<WorktreeResult> => {
    if (!isWorktreeRequest(request)) {
      return {
        ok: false,
        action: 'list',
        error: 'INVALID_REQUEST',
        message: 'Invalid worktree request.',
      };
    }
    const result = await worktreeService.execute(request, 'desktop');
    if (request.action === 'open' && result.ok && result.opened && !event.sender.isDestroyed()) {
      event.sender.send('worktrees:open-requested', result.opened);
    }
    return result;
  });
  ipcMain.handle('files:list', (_event, path: string) => fileService.listDirectory(path));
  ipcMain.handle('files:roots', () => fileService.listRoots());
  ipcMain.handle('files:read-text', (_event, path: string) => fileService.readTextFile(path));
  ipcMain.handle('files:read-preview', async (event, path: string, capability?: unknown) => {
    if (capability === undefined) return fileService.readFilePreview(path);
    const authorized = await terminalCapabilitiesFor(event.sender).consumeAndOpen(capability, path);
    if (!authorized.ok) return { ok: false as const, error: 'Terminal preview authorization expired or the file changed.' };
    return fileService.readFilePreview(path, authorized.handle);
  });
  ipcMain.handle('files:mkdir', (_event, dirPath: string, name: string) =>
    fileService.createFolder(dirPath, name),
  );
  ipcMain.handle('files:rename', (_event, path: string, newName: string) =>
    fileService.renameEntry(path, newName),
  );
  ipcMain.handle('files:trash', (_event, path: string) => fileService.trashEntry(path));
  ipcMain.handle('files:open-path', async (_event, path: string) => {
    const err = await shell.openPath(path);
    if (err) console.error('[main] shell.openPath failed:', err);
  });
  ipcMain.handle('files:reveal', (_event, path: string) => {
    shell.showItemInFolder(path);
  });
  ipcMain.handle('external:open-http-url', async (_event, value: unknown): Promise<boolean> => {
    if (typeof value !== 'string') return false;
    const url = normalizeExternalHttpUrl(value);
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('quick-commands:list', async () => {
    await quickCommandsReady;
    return quickCommandStore.list();
  });
  ipcMain.handle('quick-commands:create', async (_event, input: unknown) => {
    await quickCommandsReady;
    return quickCommandStore.create(input);
  });
  ipcMain.handle('quick-commands:update', async (_event, id: unknown, input: unknown) => {
    await quickCommandsReady;
    return typeof id === 'string'
      ? quickCommandStore.update(id, input)
      : { ok: false, error: 'not-found', message: 'quick command not found' } as const;
  });
  ipcMain.handle('quick-commands:delete', async (_event, id: unknown) => {
    await quickCommandsReady;
    return typeof id === 'string'
      ? quickCommandStore.delete(id)
      : { ok: false, error: 'not-found', message: 'quick command not found' } as const;
  });
  ipcMain.handle('workspace-files:search', (_event, request: WorkspaceFileSearchRequest) =>
    workspaceFileSearch.search(request),
  );
  ipcMain.on('workspace-files:cancel', (_event, requestId: unknown) => {
    if (typeof requestId === 'string') workspaceFileSearch.cancel(requestId);
  });

  // ── Packet capture (Phase 2B, off-by-default sub-view) + mobile tee (M3) ──
  // main only forks the host and brokers its port to the renderer — it never
  // sees packet rows or capture status (both flow host -> renderer directly
  // over the port, same "bulk stays off main" shape as run-command's cmd-port
  // below). Output resolves to .vite/build/packet-capture-host.js, same
  // directory as main.js/interpreter-process.js/script-host.js.
  //
  // `packetMirror` (declared before assignment, referenced only inside the
  // registry's `onLiveChange` closure which fires later — see PacketMirror's
  // own header comment) brokers a SECOND port per mobile subscriber from the
  // same live host, entirely independent of the desktop's direct port above.
  let packetMirror: PacketMirror | null = null;
  packetCaptureRegistry = new PacketCaptureRegistry(
    path.join(__dirname, 'packet-capture-host.js'),
    (live) => packetMirror?.setLive(live),
  );
  packetMirror = new PacketMirror({
    addViewerPort: () => packetCaptureRegistry?.addViewerPort() ?? null,
  });
  ipcMain.on('packets:subscribe', (event) => {
    if (!packetCaptureRegistry) return;
    const port1 = packetCaptureRegistry.subscribe();
    event.sender.postMessage('packet-port', {}, [port1]);
  });
  ipcMain.on('packets:unsubscribe', () => {
    packetCaptureRegistry?.kill();
  });

  // ── known_hosts (E5 §3) ───────────────────────────────────────────────────
  // Same main-owns-the-filesystem discipline as layout persistence: the
  // interpreter only ever asks main to check/persist a host key over IPC.
  const knownHostsStore = new KnownHostsStore(path.join(app.getPath('userData')));
  const knownHostsReady = knownHostsStore.init().catch((err) => {
    console.error('[main] known_hosts store init failed:', err);
  });
  ipcMain.handle('layout:load', async () => {
    await storeReady;
    return layoutStore.loadLayout();
  });
  ipcMain.handle('layout:save', async (_event, rawLayout: unknown) => {
    await storeReady;
    layoutStore.saveLayout(rawLayout);
  });
  ipcMain.handle('layout:flush', async () => {
    await storeReady;
    await layoutStore.flush();
  });
  ipcMain.handle('layout:quarantine', async () => {
    await storeReady;
    await layoutStore.quarantineLayout();
  });
  ipcMain.handle('presets:list', async () => {
    await storeReady;
    return layoutStore.listPresets();
  });
  ipcMain.handle('presets:get', async (_event, name: string) => {
    await storeReady;
    return typeof name === 'string' ? layoutStore.getPreset(name) : null;
  });
  ipcMain.handle('presets:save', async (_event, name: string, rawLayout: unknown) => {
    await storeReady;
    return typeof name === 'string' ? layoutStore.savePreset(name, rawLayout) : false;
  });
  ipcMain.handle('presets:delete', async (_event, name: string) => {
    await storeReady;
    if (typeof name === 'string') await layoutStore.deletePreset(name);
  });
  ipcMain.handle('settings:get-startup', async () => {
    await storeReady;
    return layoutStore.getStartup();
  });
  ipcMain.handle('settings:set-startup', async (_event, pref: StartupPref) => {
    await storeReady;
    await layoutStore.setStartup(pref);
  });
  ipcMain.handle('settings:get-ui-preferences', async () => {
    await storeReady;
    return layoutStore.getUiPreferences();
  });
  ipcMain.handle('settings:set-ui-preferences', async (_event, preferences: unknown) => {
    await storeReady;
    const parsed = UiPreferencesPatchSchema.safeParse(preferences);
    if (!parsed.success) return layoutStore.getUiPreferences();
    const persisted = await layoutStore.setUiPreferences(parsed.data);
    applyNativeMenuLocale(persisted.locale);
    return persisted;
  });
  ipcMain.handle('settings:refresh-native-menu-locale', async () => {
    await storeReady;
    const preferences = await layoutStore.getUiPreferences();
    applyNativeMenuLocale(preferences.locale);
  });
  ipcMain.handle('settings:get-theme', async () => {
    await storeReady;
    return layoutStore.getTheme();
  });
  ipcMain.handle('settings:set-theme', async (_event, theme: ThemeName) => {
    await storeReady;
    await layoutStore.setTheme(theme);
  });
  ipcMain.handle('settings:get-ui-scale', async () => {
    await storeReady;
    return layoutStore.getUiScale();
  });
  ipcMain.handle('settings:set-ui-scale', async (_event, uiScale: number) => {
    await storeReady;
    if (typeof uiScale === 'number') await layoutStore.setUiScale(uiScale);
  });
  ipcMain.handle('settings:get-scrollback', async () => {
    await storeReady;
    return layoutStore.getScrollback();
  });
  ipcMain.handle('settings:set-scrollback', async (_event, scrollback: number) => {
    await storeReady;
    if (typeof scrollback === 'number') await layoutStore.setScrollback(scrollback);
  });
  ipcMain.handle('settings:get-terminal-renderer', async () => {
    await storeReady;
    return layoutStore.getTerminalRenderer();
  });
  ipcMain.handle('settings:set-terminal-renderer', async (_event, preference: unknown) => {
    const parsed = TerminalRendererPreferenceSchema.safeParse(preference);
    if (!parsed.success) return;
    await storeReady;
    await layoutStore.setTerminalRenderer(parsed.data);
  });
  ipcMain.handle('settings:get-confirm-risky-pane-close', async () => {
    await storeReady;
    return layoutStore.getConfirmRiskyPaneClose();
  });
  ipcMain.handle('settings:set-confirm-risky-pane-close', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    await storeReady;
    await layoutStore.setConfirmRiskyPaneClose(enabled);
  });
  ipcMain.handle('settings:get-allow-osc52-clipboard', async () => {
    await storeReady;
    return layoutStore.getAllowOsc52Clipboard();
  });
  ipcMain.handle('settings:set-allow-osc52-clipboard', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    await storeReady;
    await layoutStore.setAllowOsc52Clipboard(enabled);
  });
  ipcMain.handle('settings:get-terminal-paste-preferences', async () => {
    await storeReady;
    return layoutStore.getTerminalPastePreferences();
  });
  ipcMain.handle('settings:set-terminal-paste-preferences', async (_event, preferences: unknown) => {
    if (!isTerminalPastePreferences(preferences)) return;
    await storeReady;
    await layoutStore.setTerminalPastePreferences(preferences);
  });
  ipcMain.handle('terminal:read-clipboard', () => readTerminalClipboardSnapshot(clipboard));
  ipcMain.handle('terminal:write-osc52-clipboard', async (event, text: unknown): Promise<boolean> => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > OSC52_MAIN_MAX_BYTES) return false;
    await storeReady;
    if (!(await layoutStore.getAllowOsc52Clipboard())) return false;
    const now = Date.now();
    const previous = osc52LastWrite.get(event.sender) ?? Number.NEGATIVE_INFINITY;
    if (now - previous < OSC52_MAIN_MIN_INTERVAL_MS) return false;
    osc52LastWrite.set(event.sender, now);
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('terminal:resolve-file-location', (event, request: TerminalFileLocationRequest) =>
    resolveTerminalFileLocation(request, terminalCapabilitiesFor(event.sender)));
  ipcMain.handle('ssh-forwards:list', () => sshForwardService?.listAll() ?? []);
  ipcMain.handle(
    'ssh-forwards:stop',
    async (_event, connectionId: unknown, forwardId: unknown): Promise<SshForwardResult> => {
      if (typeof connectionId !== 'string' || typeof forwardId !== 'string') {
        return sshForwardFailure(new Error('invalid SSH forward stop request'));
      }
      try {
        if (!sshForwardService) throw new Error('SSH forwarding service is unavailable');
        return { ok: true, forwards: [await sshForwardService.stop(connectionId, forwardId)] };
      } catch (error) {
        return sshForwardFailure(error);
      }
    },
  );
  ipcMain.handle(
    'destroy-sessions-guarded',
    (_event, sessions: unknown): Promise<DestroySessionGuardResult> => {
      if (
        !Array.isArray(sessions)
        || sessions.length === 0
        || sessions.length > MAX_GUARDED_DESTROY_SESSIONS
        || sessions.some((entry) => {
          if (typeof entry !== 'object' || entry === null) return true;
          const candidate = entry as Partial<GuardedSessionDestroyRequest>;
          return (
            typeof candidate.sessionId !== 'string'
            || candidate.sessionId.length === 0
            || candidate.sessionId.length > 256
            || !Array.isArray(candidate.expectedActiveRunIds)
            || candidate.expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
            || candidate.expectedActiveRunIds.some(
              (runId) => typeof runId !== 'string' || runId.length === 0 || runId.length > 256,
            )
          );
        })
        || new Set(sessions.map((entry) => (entry as GuardedSessionDestroyRequest).sessionId)).size !== sessions.length
      ) {
        return Promise.resolve({ ok: false, reason: 'unavailable' });
      }
      return broker?.destroySessionsGuarded(sessions as GuardedSessionDestroyRequest[])
        ?? Promise.resolve({ ok: false, reason: 'unavailable' });
    },
  );

  ipcMain.handle('agents:get-snapshot', () => agentActivityService?.getSnapshot() ?? { revision: 0, items: [] });
  ipcMain.handle('agents:followup', (_event, activityId: string, text: string): AgentFollowupResult => {
    if (typeof activityId !== 'string' || typeof text !== 'string') return { ok: false, error: 'invalid-text' };
    return agentActivityService?.sendFollowup(activityId, text) ?? { ok: false, error: 'delivery-failed' };
  });
  ipcMain.handle('agents:list-integrations', async () => {
    await agentInfrastructureReady;
    return agentHookInstaller.list();
  });
  ipcMain.handle('agents:set-integration-enabled', async (_event, provider: unknown, enabled: unknown) => {
    await agentInfrastructureReady;
    if (!isAgentIntegrationProvider(provider) || typeof enabled !== 'boolean') {
      throw new Error('invalid agent integration request');
    }
    if (enabled && !agentRelayReady) {
      return {
        ok: false,
        error: 'io-error',
        message: 'The local agent hook relay is unavailable; no hook configuration was changed.',
        status: await agentHookInstaller.status(provider),
      } as const;
    }
    return agentHookInstaller.mutate(provider, enabled);
  });
  ipcMain.handle('agents:get-settings', async () => {
    await agentInfrastructureReady;
    return agentSettingsStore.get();
  });
  ipcMain.handle('agents:set-settings', async (_event, settings: unknown) => {
    await agentInfrastructureReady;
    return agentSettingsStore.set(settings);
  });

  // ── Custom themes + font/effects settings (theme-effects-font M3) ────────
  // theme-store.ts owns its own fs (the themes dir, independent of layoutStore's
  // userData files) so its handlers don't await `storeReady`; font/effect
  // toggles live in settings.json, so those do.
  ipcMain.handle('theme:get-available', () => getAvailableThemes());
  ipcMain.handle('theme:import', (_event, json: string) => importTheme(json));
  ipcMain.handle('settings:get-font', async () => {
    await storeReady;
    return layoutStore.getFont();
  });
  ipcMain.handle('settings:set-font', async (_event, id: string) => {
    await storeReady;
    if (typeof id === 'string') await layoutStore.setFont(id);
  });
  ipcMain.handle('settings:get-effect-toggles', async () => {
    await storeReady;
    return layoutStore.getEffectToggles();
  });
  ipcMain.handle('settings:set-effect-toggles', async (_event, toggles: Record<string, boolean>) => {
    await storeReady;
    if (toggles && typeof toggles === 'object') await layoutStore.setEffectToggles(toggles);
  });
  ipcMain.handle('settings:get-rollbar', async () => {
    await storeReady;
    return layoutStore.getRollbar();
  });
  ipcMain.handle('settings:set-rollbar', async (_event, params: RollbarSettings) => {
    await storeReady;
    if (params && typeof params === 'object') await layoutStore.setRollbar(params);
  });
  ipcMain.handle('settings:get-effect-params', async () => {
    await storeReady;
    return layoutStore.getEffectParams();
  });
  ipcMain.handle('settings:set-effect-params', async (_event, params: EffectParamsSettings) => {
    await storeReady;
    if (params && typeof params === 'object') await layoutStore.setEffectParams(params);
  });
  // Best-effort final flush; the debounced save already persisted anything
  // older than ~300ms (accepted v1 loss window — gate Q2).
  app.on('before-quit', () => {
    appIsQuitting = true;
    void layoutStore.flush();
    systemStatsService?.stop();
    packetCaptureRegistry?.kill();
    void remoteRuntimeController?.shutdown();
    void stopOpenClawProxy();
    unsubscribeOpenClawEndpoint();
    openClawService?.dispose();
    openClawChatView?.destroy();
    agentActivityService?.dispose();
    void agentSettingsStore.flush();
    void quickCommandStore.flush();
    workspaceFileSearch.dispose();
    void sshForwardService?.dispose();
    sshForwardService = null;
    void agentHookRelay.stop();
    clearInterval(openclawVisibilityRecheckTimer);
  });

  // Session lifecycle (Codex B1/B5). create-session is the ONLY way a shell session
  // comes into being — the interpreter mints the authoritative {sessionId, cwd} and
  // replies via `session-created`, correlated by requestId. A pane awaits this before
  // it can run commands. The broker owns the correlation state + the session directory.
  ipcMain.handle('create-session', async (_event, cwd?: string): Promise<SessionInfo> => {
    await agentInfrastructureReady;
    return broker ? broker.createSession(cwd) : Promise.reject(new Error('interpreter not running'));
  });

  // Destroy a session when its pane/tab closes (fire-and-forget; interpreter aborts
  // the session's in-flight runs and drops it — idempotent, Codex B2/B6).
  ipcMain.on('destroy-session', (_event, sessionId: string) => {
    broker?.destroySession(sessionId);
  });
  ipcMain.handle(
    'destroy-session-guarded',
    (_event, sessionId: unknown, expectedActiveRunIds: unknown): Promise<DestroySessionGuardResult> => {
      if (
        typeof sessionId !== 'string'
        || sessionId.length === 0
        || !Array.isArray(expectedActiveRunIds)
        || expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
        || expectedActiveRunIds.some((runId) => typeof runId !== 'string' || runId.length === 0 || runId.length > 256)
      ) {
        return Promise.resolve({ ok: false, reason: 'unavailable' });
      }
      return broker?.destroySessionGuarded(sessionId, expectedActiveRunIds as string[])
        ?? Promise.resolve({ ok: false, reason: 'unavailable' });
    },
  );

  // ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ──
  // list-sessions is a straight passthrough to the broker's directory;
  // session-added/session-removed/run-started fan out to every desktop window
  // via the broker subscriptions wired at broker construction. remote-bridge.ts
  // subscribes to the SAME broker independently for its own WS fan-out (T2.1).
  ipcMain.handle('list-sessions', () => broker?.listSessions() ?? []);
  // list-runs (M1 mirror-active-runs): resolves `[]` immediately if there's no
  // broker/interpreter (mirrors create-session's own guard) — there are no runs
  // to report either way, so there is nothing to await.
  ipcMain.handle('list-runs', (): Promise<readonly RunStartedInfo[]> =>
    broker ? broker.listRuns() : Promise.resolve([]),
  );

  // attach-run (T2.2f): brokers a NON-INITIATING port onto an existing run's
  // ExecutionSession — mirrors the run-command handler in createWindow()
  // exactly (broker mints a fresh port pair, port2 to the interpreter, port1 to
  // THIS event's sender), except it never starts a new run (canRun/session-
  // registry are untouched — attach is view+input, not a second writer).
  ipcMain.on('attach-run', (event, payload: { sessionId: string; runId: string }) => {
    if (!broker) return;
    const port1 = broker.attachRun(payload.sessionId, payload.runId);
    if (!port1) return;
    event.sender.postMessage('attach-port', { runId: payload.runId }, [port1 as unknown as MessagePortMain]);
  });

  // Enforce the CSP as a response header for the packaged renderer (defense-in-depth
  // alongside the build-injected <meta>, SEC-MED-3). Skipped under the Vite dev
  // server, whose HMR needs inline scripts / eval / a websocket the strict policy
  // would block — production (packaged) is where this matters.
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }

  // Spawn the interpreter as a utilityProcess (architecture §1).
  // utilityProcess keeps interpreter work off the main thread and enables
  // MessagePortMain-based streaming without freezing the UI.
  // Output resolves to .vite/build/interpreter-process.js (same dir as main.js).
  const interpreterPath = path.join(__dirname, 'interpreter-process.js');
  const spawnInterpreterProcess = (): UtilityProcess => {
    console.log(`[main] spawning interpreter at: ${interpreterPath}`);
    return utilityProcess.fork(interpreterPath, [], {
      serviceName: 'EZTerminal Interpreter',
      stdio: 'inherit',
    });
  };

  interpreter = spawnInterpreterProcess();

  // The single main-side broker over the interpreter (interpreter-broker plan).
  // It attaches listener #1 (session/run dispatch) + an exit listener in its
  // constructor and owns the session directory; main's own listener #2 below
  // handles the disjoint script-host/known-host message types.
  broker = new InterpreterBroker({
    interpreter: interpreter as unknown as BrokerInterpreter,
    createMessageChannel: () => new MessageChannelMain(),
    mutationGate: sessionWorktreeMutationGate,
    runGuard: sessionWorktreeRunGuard,
    validateSessionCwd: async (cwd) => {
      try {
        return (await stat(cwd)).isDirectory();
      } catch {
        return false;
      }
    },
    sessionEnvironment: (sessionId) => {
      if (!agentRelayReady) return {} as Readonly<Record<string, string>>;
      return {
        EZTERMINAL_SESSION_ID: sessionId,
        EZTERMINAL_AGENT_HOOK_DESCRIPTOR: agentHookRelay.environmentDescriptor,
      };
    },
  });
  console.log('[main] interpreter broker ready');

  const bindSshForwardService = (target: UtilityProcess): void => {
    sshForwardService = new SshForwardService({
      interpreter: target as unknown as BrokerInterpreter,
      createMessageChannel: () => new MessageChannelMain(),
      onInterpreterExited: (listener) => broker?.onInterpreterExited(listener) ?? (() => undefined),
    });
  };
  bindSshForwardService(interpreter);
  console.log('[main] SSH forwarding service ready');

  agentActivityService = new AgentActivityService({
    broker,
    getSettings: () => agentSettingsStore.current,
  });
  agentActivityService.onSnapshot((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('agents:snapshot', snapshot);
    }
  });
  const liveAgentNotifications = new Set<Notification>();
  agentActivityService.onTransition((transition: AgentActivityTransition) => {
    const { activity } = transition;
    if (activity.status !== 'waiting' && activity.status !== 'blocked' && activity.status !== 'error') return;
    if (!agentSettingsStore.current.notifications[activity.status]) return;
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    if (windows.some((win) => win.isFocused()) || !Notification.isSupported()) return;
    const notification = new Notification({
      title: `${activity.provider} agent ${activity.status}`,
      body: activity.cwd || 'EZTerminal session',
      silent: false,
    });
    liveAgentNotifications.add(notification);
    notification.on('close', () => liveAgentNotifications.delete(notification));
    notification.on('click', () => {
      const win = mainWindowRef ?? windows[0];
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('agents:reveal-session', activity.sessionId);
    });
    notification.show();
  });

  // ── Session/run fan-out to every desktop window (M2 mirroring) ────────────
  // The broker is the sole session `add`/`remove` caller; these subscriptions
  // replace the former sessionDirectory.onSessionAdded/onSessionRemoved wiring
  // and the run-started broadcast arm of the interpreter message dispatcher.
  // remote-bridge.ts subscribes to the SAME broker independently (T2.1). Both
  // broadcasts are origin-agnostic (including a window's own session — see
  // SessionDirectory's doc for why the ordering is safe).
  broker.onSessionAdded((session) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('session-added', session);
    }
  });
  broker.onSessionRemoved((sessionId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('session-removed', sessionId);
    }
  });
  broker.onRunStarted((info) => {
    // runId is caller-minted, so unlike session-added there's no "learn my own
    // id first" race to guard — a plain broadcast is enough.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('run-started', {
        sessionId: info.sessionId,
        runId: info.runId,
        commandText: info.commandText,
        executionKind: info.executionKind,
      });
    }
  });

  // run-script (E4 §6.1): main is the only process that can fork a utilityProcess
  // (C1/C2), so the interpreter asks main to spawn/kill a script-host per
  // `run-script` invocation, correlated by hostId. Output resolves to
  // .vite/build/script-host.js, same directory as main.js/interpreter-process.js.
  const scriptHostRegistry = new ScriptHostRegistry(path.join(__dirname, 'script-host.js'));

  // Interpreter → main replies: the script-host spawn/kill protocol (E4) + the
  // known_hosts TOFU verdicts. This is listener #2 — disjoint by message type
  // from the broker's listener #1 (session-created/run-started/run-list), so the
  // two never double-process a message.
  const recoveryDelaysMs = [250, 1_000, 3_000] as const;
  let consecutiveRecoveryAttempts = 0;
  let recoveryStabilityTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleInterpreterRecovery(): void {
    if (appIsQuitting) return;
    const attemptIndex = consecutiveRecoveryAttempts;
    if (attemptIndex >= recoveryDelaysMs.length) {
      mainLog?.line('interpreter recovery exhausted after 3 consecutive attempts');
      return;
    }
    consecutiveRecoveryAttempts += 1;
    const delayMs = recoveryDelaysMs[attemptIndex];
    mainLog?.line(`interpreter recovery attempt ${String(consecutiveRecoveryAttempts)} scheduled in ${String(delayMs)}ms`);
    setTimeout(() => {
      if (appIsQuitting) return;
      let next: UtilityProcess | null = null;
      try {
        next = spawnInterpreterProcess();
        interpreter = next;
        if (!broker?.restart(next as unknown as BrokerInterpreter)) {
          throw new Error('broker rejected interpreter replacement');
        }
        bindSshForwardService(next);
        wireInterpreterProcess(next);
        mainLog?.line(`interpreter recovered on attempt ${String(consecutiveRecoveryAttempts)}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('session-recovered');
          }
        }
        if (recoveryStabilityTimer !== null) clearTimeout(recoveryStabilityTimer);
        recoveryStabilityTimer = setTimeout(() => {
          consecutiveRecoveryAttempts = 0;
          recoveryStabilityTimer = null;
        }, 30_000);
      } catch (error) {
        mainLog?.line(`interpreter recovery spawn failed: ${String(error)}`);
        if (next) {
          try { next.kill(); } catch { /* already gone */ }
        }
        interpreter = null;
        scheduleInterpreterRecovery();
      }
    }, delayMs);
  }

  function postToInterpreterGeneration(
    target: UtilityProcess,
    message: MainToInterpreter,
    transfer?: MessagePortMain[],
  ): void {
    if (target !== interpreter) return;
    try {
      target.postMessage(message, transfer);
    } catch {
      // The generation exited while an asynchronous main-owned request settled.
    }
  }

  function wireInterpreterProcess(target: UtilityProcess): void {
    target.on('message', (msg: InterpreterToMain) => {
      if (target !== interpreter) return;
      if (msg?.type === 'spawn-script-host') {
        const result = scriptHostRegistry.spawn(msg.hostId, msg.scriptPath, msg.args, msg.cwd, (hostId, code) => {
          postToInterpreterGeneration(target, { type: 'script-host-exit', hostId, code });
        });
        if ('error' in result) {
          postToInterpreterGeneration(target, {
            type: 'script-host-error',
            hostId: msg.hostId,
            message: result.error,
          });
        } else {
          postToInterpreterGeneration(target, {
            type: 'script-host-ready',
            hostId: msg.hostId,
          }, [result.interpreterPort]);
        }
      } else if (msg?.type === 'kill-script-host') {
        scriptHostRegistry.kill(msg.hostId);
      } else if (msg?.type === 'known-host-check') {
        const { requestId, host, port, keyType, fingerprint } = msg;
        void knownHostsReady
          .then(() => knownHostsStore.check(host, port, keyType, fingerprint))
          .then((outcome) => {
            postToInterpreterGeneration(target, {
              type: 'known-host-verdict',
              requestId,
              verdict: outcome.verdict,
              existingFingerprint: outcome.existingFingerprint,
              knownHostsPath: knownHostsStore.path,
            });
          })
          .catch((err: unknown) => {
            console.error('[main] known-host-check failed:', err);
            // Fail closed as 'unknown' (re-prompts TOFU) rather than dropping the
            // request — a store error must never silently resolve as 'match'.
            postToInterpreterGeneration(target, {
              type: 'known-host-verdict',
              requestId,
              verdict: 'unknown',
              knownHostsPath: knownHostsStore.path,
            });
          });
      } else if (msg?.type === 'known-host-add') {
        void knownHostsReady
          .then(() => knownHostsStore.add(msg.host, msg.port, msg.keyType, msg.fingerprint))
          .catch((err: unknown) => {
            console.error('[main] known-host-add failed:', err);
          });
      } else if (msg?.type === 'worktree-action-request') {
        const origin = msg.origin === 'desktop' ? 'desktop' : 'mobile';
        if (!isWorktreeRequest(msg.request)) {
          postToInterpreterGeneration(target, {
            type: 'worktree-action-response',
            requestId: msg.requestId,
            result: {
              ok: false,
              action: 'list',
              error: 'INVALID_REQUEST',
              message: 'Invalid worktree request.',
            },
          });
          return;
        }
        const controller = new AbortController();
        pendingWorktreeActions.get(msg.requestId)?.abort();
        pendingWorktreeActions.set(msg.requestId, controller);
        void worktreeService
          .execute(msg.request, origin, controller.signal, {
            sessionId: msg.sessionId,
            runId: msg.runId,
          })
          .then((result) => {
            if (controller.signal.aborted || pendingWorktreeActions.get(msg.requestId) !== controller) return;
            if (origin === 'desktop' && msg.request.action === 'open' && result.ok && result.opened) {
              notifyDesktopWorktreeOpen(result.opened);
            }
            postToInterpreterGeneration(target, {
              type: 'worktree-action-response',
              requestId: msg.requestId,
              result,
            });
          })
          .finally(() => {
            if (pendingWorktreeActions.get(msg.requestId) === controller) {
              pendingWorktreeActions.delete(msg.requestId);
            }
          });
      } else if (msg?.type === 'worktree-action-cancel') {
        pendingWorktreeActions.get(msg.requestId)?.abort();
        pendingWorktreeActions.delete(msg.requestId);
      }
    });

    target.on('exit', (code) => {
      if (target !== interpreter) return;
      console.log(`[main] interpreter exited with code ${String(code)}`);
      mainLog?.line(`interpreter exited with code ${String(code)} (planned=${String(appIsQuitting)})`);
      interpreter = null;
      if (recoveryStabilityTimer !== null) {
        clearTimeout(recoveryStabilityTimer);
        recoveryStabilityTimer = null;
      }
      for (const controller of pendingWorktreeActions.values()) controller.abort();
      pendingWorktreeActions.clear();
      // Shared-fate (Codex B8, extended for E4): ONE utilityProcess backs every
      // session, so its death kills them all — including every live script-host,
      // which would otherwise become an orphaned process (design §6.1). Tell every
      // renderer to mark active runs interrupted while recovery replaces the
      // process. The broker's OWN exit listener flips its `alive` flag and rejects
      // in-flight create-session/list-runs pendings — this listener stays orthogonal
      // (process/window cleanup), so it must NOT also reject them here.
      scriptHostRegistry.killAll();
      // The payload (additive, B-M5) lets the renderer's banner point the user at
      // the local evidence.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('session-dead', { logPath: mainLog?.path ?? null });
        }
      }
      scheduleInterpreterRecovery();
    });
  }

  wireInterpreterProcess(interpreter);

  // ── OpenClaw management service (openclaw-management M1) ─────────────────
  // Electron-free service (see openclaw-service.ts's module doc for the M0
  // Stage-0 latency findings this is built around) — constructed here (rather
  // than down by its IPC handlers below) because the mobile bridge/proxy
  // wiring right below needs it to build `remoteOpenClawSource`.
  const openclaw = new OpenClawService();
  openClawService = openclaw;

  // ── OpenClaw chat WebContentsView (openclaw-management M3) ────────────────
  // See openclaw-chat-view.ts's module doc for the config verified live in
  // the M0 spike. Attached to the window in createWindow(); state pushes
  // (did-fail-load/did-finish-load) fan out to every window below.
  openClawChatView = new OpenClawChatViewManager({
    getChatUrl: () => openclaw.getChatUrl(),
    onStateChange: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        win.webContents.send('openclaw:chat-view-state', state);
      }
    },
  });

  // ── Mobile remote-control WS bridge (M0) + OpenClaw reverse proxy (M4) ──
  // Default OFF (opt-in — see LayoutStore.getRemoteEnabled): the bridge grants
  // a paired device full command + filesystem access, so the listener only
  // binds once the user enables it in Settings. When enabled it binds 0.0.0.0
  // (LAN + Tailscale reachable), token-gated and origin-checked. The OpenClaw
  // proxy (mobile chat embed's tunnel to the gateway) starts lazily only for
  // chat, so its port/upstream failure cannot take terminal/session/file remote
  // control down with it.
  // The bridge adapts to the SAME broker instance the local IPC handlers use,
  // so both transports share one interpreter listener + one session directory.
  const openClawProxyPort = Number(process.env.EZTERMINAL_OPENCLAW_PROXY_PORT) || DEFAULT_OPENCLAW_PROXY_PORT;
  // Adapts `openclaw` (an OpenClawService instance) + `openClawProxyHandle`
  // (started lazily below) to the bridge's DI seam — `mintChatTicket` is the
  // one method genuinely composed from BOTH
  // sources (the service's token + the proxy's ticket), everything else is a
  // direct passthrough (method names match `OpenClawService`'s own exactly).
  // OpenClaw availability (openclaw-stabilization M3) — `currentOpenClawVisible`
  // is kept resolved eagerly (before listener start and on every
  // `settings:set-openclaw-mode` call) so `remoteOpenClawSource.isVisible()`
  // can stay synchronous for the mobile presentation hint without gating
  // authenticated remote APIs. `remoteOpenClawVisibilityListeners`
  // mirrors `remoteStatsListeners` above — the bridge's per-connection
  // `subscribeVisibility` adds/removes from it; notified below whenever the
  // mode changes.
  let currentOpenClawVisible = false;
  const remoteOpenClawVisibilityListeners = new Set<(visible: boolean) => void>();
  let openClawProxyStart: Promise<OpenClawProxyHandle | null> | null = null;
  const ensureOpenClawProxy = (): Promise<OpenClawProxyHandle | null> => {
    if (openClawProxyHandle) return Promise.resolve(openClawProxyHandle);
    if (openClawProxyStart) return openClawProxyStart;
    openClawProxyStart = (async () => {
      try {
        const endpoint = openclaw.getEndpoint();
        const handle = await startOpenClawProxy({
          port: openClawProxyPort,
          upstreamOrigin: endpoint.origin,
        });
        // Endpoint discovery/config may have advanced while the listener was
        // binding. Retarget before exposing the handle.
        handle.setUpstreamOrigin(openclaw.getEndpoint().origin);
        openClawProxyHandle = handle;
        return handle;
      } catch (error) {
        console.error('[main] OpenClaw proxy remained off:', error);
        return null;
      } finally {
        openClawProxyStart = null;
      }
    })();
    return openClawProxyStart;
  };
  const stopOpenClawProxy = async (): Promise<void> => {
    if (openClawProxyStart) await openClawProxyStart;
    const handle = openClawProxyHandle;
    openClawProxyHandle = null;
    if (handle) await handle.stop();
  };
  const unsubscribeOpenClawEndpoint = openclaw.onEndpointChanged((endpoint) => {
    try {
      openClawProxyHandle?.setUpstreamOrigin(endpoint.origin);
    } catch (error) {
      console.error('[main] OpenClaw proxy retarget failed:', error);
    }
  });
  const remoteOpenClawSource: RemoteOpenClawSource = {
    subscribeStatus: (listener) => openclaw.subscribeStatus(listener),
    runLifecycle: (action) => openclaw.runLifecycle(action),
    subscribeLogs: (listener) => openclaw.subscribeLogs(listener),
    listAgentSessions: () => openclaw.listAgentSessions(),
    getCoreConfig: () => openclaw.getCoreConfig(),
    setCoreConfig: (key, value) => openclaw.setCoreConfig(key, value),
    mintChatTicket: async () => {
      if (remoteRuntimeController?.currentStatus.state !== 'running') {
        return { ticket: null, reason: 'proxy-unavailable' };
      }
      const status = await openclaw.getStatus();
      if (status.state === 'unknown') return { ticket: null, reason: 'gateway-unreachable' };
      if (status.state !== 'running') return { ticket: null, reason: 'gateway-stopped' };
      const insecureAuth = await openclaw.getInsecureAuthStatus();
      if (insecureAuth === 'disabled' || insecureAuth === 'unset') {
        return { ticket: null, reason: 'insecure-auth-required' };
      }
      if (insecureAuth === 'error') return { ticket: null, reason: 'token-unavailable' };
      const token = await openclaw.getChatToken();
      if (!token) return { ticket: null, reason: 'token-unavailable' };
      const proxy = await ensureOpenClawProxy();
      if (!proxy || remoteRuntimeController?.currentStatus.state !== 'running') {
        if (proxy) await stopOpenClawProxy();
        return { ticket: null, reason: 'proxy-unavailable' };
      }
      return { ticket: proxy.mintTicket(), proxyPort: proxy.port, token };
    },
    isVisible: () => currentOpenClawVisible,
    subscribeVisibility: (listener) => {
      remoteOpenClawVisibilityListeners.add(listener);
      return () => remoteOpenClawVisibilityListeners.delete(listener);
    },
  };
  const remoteTokenStore = new RemoteTokenStore(path.join(app.getPath('userData')), {
    protector: process.platform === 'win32'
      ? {
          encrypt: (plaintext) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error('Windows credential encryption is unavailable.');
            }
            return safeStorage.encryptString(plaintext);
          },
          decrypt: (ciphertext) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error('Windows credential encryption is unavailable.');
            }
            return safeStorage.decryptString(ciphertext);
          },
        }
      : undefined,
    requireProtector: process.platform === 'win32',
  });
  let remoteTokenSecure = false;
  let remoteSecurityError: string | null = null;
  let remoteTokenInit: Promise<void> | null = null;
  const ensureRemoteTokenSecurity = (): Promise<void> => {
    if (remoteTokenSecure) return Promise.resolve();
    if (remoteTokenInit === null) {
      remoteTokenInit = (async () => {
        await remoteTokenStore.init();
        // Mint/load and fully harden the token before any listener can bind.
        await remoteTokenStore.getToken();
        remoteTokenSecure = true;
        remoteSecurityError = null;
      })()
        .catch((err) => {
          remoteTokenSecure = false;
          remoteSecurityError = 'The remote access token could not be stored securely. Remote access remains off.';
          console.error('[main] remote token security readiness failed:', err);
          throw err;
        })
        .finally(() => {
          remoteTokenInit = null;
        });
    }
    return remoteTokenInit ?? Promise.resolve();
  };
  const remoteBridgePort = Number(process.env.EZTERMINAL_REMOTE_PORT) || DEFAULT_REMOTE_BRIDGE_PORT;
  const remoteStatsSource: RemoteStatsSource = {
    getHistory: () => systemStatsService?.getHistory() ?? [],
    onSnapshot: (listener) => {
      remoteStatsListeners.add(listener);
      return () => remoteStatsListeners.delete(listener);
    },
    acquire: () => statsVisibility.acquire(),
    release: () => statsVisibility.release(),
  };
  const remotePacketSource: RemotePacketSource = {
    subscribe: (listener) => packetMirror?.subscribe(listener) ?? (() => undefined),
  };
  const remoteQuickCommandSource: RemoteQuickCommandSource = {
    list: async () => {
      await quickCommandsReady;
      return quickCommandStore.list();
    },
  };
  const publishRemoteRuntimeStatus = (status: RemoteRuntimeStatus): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('remote:runtime-status', status);
    }
  };
  const runtime = new RemoteRuntimeController({
    port: remoteBridgePort,
    readDesiredEnabled: async () => {
      await storeReady;
      return layoutStore.getRemoteEnabled();
    },
    writeDesiredEnabled: async (enabled) => {
      await storeReady;
      await layoutStore.setRemoteEnabled(enabled);
    },
    start: async () => {
      try {
        await ensureRemoteTokenSecurity();
      } catch {
        throw new RemoteRuntimeStartError('REMOTE_TOKEN_UNAVAILABLE', 'remote token unavailable');
      }
      await agentInfrastructureReady;
      // Keep the presentation hint current before auth; it no longer gates
      // any authenticated OpenClaw request.
      currentOpenClawVisible = await resolveOpenClawVisibility(
        await layoutStore.getOpenClawMode(),
        () => openclaw.isInstalled(),
      );
      return startRemoteBridge({
        port: remoteBridgePort,
        getToken: () => remoteTokenStore.getToken(),
        hostVersion: app.getVersion(),
        buildSha: process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA,
        broker: broker!,
        statsSource: remoteStatsSource,
        packetSource: remotePacketSource,
        fileSource: fileService satisfies RemoteFileSource,
        worktreeSource: worktreeService,
        quickCommandSource: remoteQuickCommandSource,
        openclawSource: remoteOpenClawSource,
        agentSource: agentActivityService ?? undefined,
      });
    },
    onStatus: publishRemoteRuntimeStatus,
    onError: (error) => console.error('[main] remote runtime operation failed:', error),
  });
  remoteRuntimeController = runtime;
  void runtime.initialize();

  // Desktop pairing panel (M4): connection info/token are read-only display +
  // an explicit rotate action, same invoke shape as the settings handlers above.
  ipcMain.handle('remote:get-connection-info', () => {
    return formatConnectionInfo(networkInterfaces(), remoteBridgePort);
  });
  ipcMain.handle('remote:get-token', async () => {
    await ensureRemoteTokenSecurity();
    return remoteTokenStore.getToken();
  });
  ipcMain.handle('remote:get-security-status', async () => {
    try {
      await ensureRemoteTokenSecurity();
    } catch {
      // The status payload is the renderer-safe error channel.
    }
    return {
      state: remoteSecurityError === null ? 'ready' : 'error',
      error: remoteSecurityError,
    } as const;
  });
  ipcMain.handle('remote:rotate-token', async () => {
    await ensureRemoteTokenSecurity();
    try {
      return await remoteTokenStore.rotateToken();
    } catch (err) {
      remoteTokenSecure = false;
      remoteSecurityError = 'The new remote access token could not be stored securely. Remote access was stopped.';
      await runtime.stopWithError('REMOTE_TOKEN_UNAVAILABLE', remoteSecurityError);
      await stopOpenClawProxy().catch((error) => console.error('[main] OpenClaw proxy stop failed:', error));
      throw err;
    }
  });
  ipcMain.handle('remote:get-enabled', async () => {
    return (await runtime.getStatus()).desiredEnabled;
  });
  ipcMain.handle('remote:get-runtime-status', () => runtime.getStatus());
  ipcMain.handle('remote:set-enabled', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return runtime.getStatus();
    const status = await runtime.setDesiredEnabled(enabled);
    if (!enabled) {
      await stopOpenClawProxy().catch((error) => console.error('[main] OpenClaw proxy stop failed:', error));
    }
    return status;
  });
  ipcMain.handle('remote:retry-runtime', () => runtime.retry());

  // ── OpenClaw management (openclaw-management M1) ─────────────────────────
  // `openclaw`/`openClawService` are constructed earlier (see the mobile
  // bridge/proxy wiring above, which needs it to build `remoteOpenClawSource`)
  // — IPC here is a thin adapter, same shape as the file explorer's
  // FileService wiring above. The chat token/URL never cross to the renderer
  // (M3 owns the WebContentsView main-side) — only a boolean "is a token
  // available" is exposed via `openclaw:chat-available`.
  ipcMain.handle('openclaw:get-status', (_event, force?: boolean) => openclaw.getStatus(force));
  ipcMain.handle('openclaw:lifecycle', (_event, action: OpenClawLifecycleAction) => openclaw.runLifecycle(action));
  ipcMain.handle('openclaw:list-sessions', () => openclaw.listAgentSessions());
  ipcMain.handle('openclaw:get-config', () => openclaw.getCoreConfig());
  ipcMain.handle('openclaw:set-config', (_event, key: string, value: string) => openclaw.setCoreConfig(key, value));
  ipcMain.handle('openclaw:chat-available', async () => (await openclaw.getChatToken()) !== null);
  // autostart (openclaw-management #9) — `gateway install|uninstall`, serialized
  // on the same CLI lane as start/stop/restart (see OpenClawService.runAutostart).
  ipcMain.handle('openclaw:autostart', (_event, action: OpenClawAutostartAction) => openclaw.runAutostart(action));

  // ── OpenClaw desktop visibility (openclaw-stabilization M2) ───────────────
  // Tri-state setting gating whether ANY OpenClaw UI shows on desktop at all.
  // Lives in settings.json (hence the `settings:*` channel naming, matching
  // the generic settings block above) but is colocated here rather than
  // there, since computing `visible` needs `openclaw` (constructed above).
  //
  // `applyOpenClawVisibility` is the single place that broadcasts a resolved
  // {mode, visible} to every desktop window AND the mobile bridge's
  // visibility listeners, keeping `currentOpenClawVisible` in sync with both.
  // Shared by the explicit mode-toggle handler right below and the periodic
  // 'auto'-mode recheck (M5) further down, so the two can never drift apart.
  const applyOpenClawVisibility = (visibility: OpenClawVisibility): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('openclaw:visibility-changed', visibility);
    }
    // M3: same notification, mirrored to the mobile bridge — see
    // `remoteOpenClawSource.subscribeVisibility` above.
    currentOpenClawVisible = visibility.visible;
    for (const listener of remoteOpenClawVisibilityListeners) listener(visibility.visible);
  };
  ipcMain.handle('settings:get-openclaw-mode', async () => {
    await storeReady;
    return layoutStore.getOpenClawMode();
  });
  ipcMain.handle('settings:set-openclaw-mode', async (_event, mode: OpenClawMode) => {
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') return;
    await storeReady;
    await layoutStore.setOpenClawMode(mode);
    applyOpenClawVisibility({
      mode,
      visible: await resolveOpenClawVisibility(mode, () => openclaw.isInstalled()),
    });
  });
  ipcMain.handle('openclaw:get-visibility', async (): Promise<OpenClawVisibility> => {
    await storeReady;
    const mode = await layoutStore.getOpenClawMode();
    return { mode, visible: await resolveOpenClawVisibility(mode, () => openclaw.isInstalled()) };
  });
  // M5: nothing re-queries `openclaw.isInstalled()` on its own once boot/the
  // handler above have run, so in 'auto' mode installing/uninstalling the CLI
  // while the app is running never updates gating until a mode toggle or
  // restart (`isInstalled()`'s own negative-cache TTL is INSTALL_RECHECK_MS,
  // M2 — this is what actually re-triggers a real lookup). Skipped entirely
  // for 'on'/'off' (unconditional, nothing to recheck). Cheap: a PATH lookup
  // via CommandResolver + fs stat, no gateway HTTP/WS traffic. `.unref()`'d
  // so it never keeps the process alive on its own — same pattern as
  // FileService's idle-upload sweep timer (file-service.ts).
  const openclawVisibilityRecheckTimer = setInterval(() => {
    void (async () => {
      const mode = await layoutStore.getOpenClawMode();
      if (mode !== 'auto') return;
      const visible = await resolveOpenClawVisibility(mode, () => openclaw.isInstalled());
      if (visible !== currentOpenClawVisible) applyOpenClawVisibility({ mode, visible });
    })();
  }, OPENCLAW_VISIBILITY_RECHECK_MS);
  openclawVisibilityRecheckTimer.unref();

  // Status push is wanted by TWO independent UI surfaces: the drawer
  // (openclaw:set-drawer-open) and the M3 chat panel (openclaw:chat-panel-
  // mounted — sent for as long as the singleton dockview tab exists, NOT
  // gated on gateway running state: the panel needs status pushes WHILE
  // stopped precisely to detect the stopped->running transition and only
  // then request the WebContentsView, see `openclaw:chat-open` below) —
  // each reports its own open/closed state, since either can be open while
  // the other is closed, so a single shared boolean would let closing one
  // kill pushes the other still needs. Logs stay drawer-only (the chat panel
  // never shows them). Mirrors the stats overlay's `stats:panel-visible`
  // gating; broadcasts to every window.
  let openclawDrawerOpen = false;
  let openclawChatPanelOpen = false;
  let openclawUnsubscribeStatus: (() => void) | null = null;
  let openclawUnsubscribeLogs: (() => void) | null = null;
  const syncOpenClawStatusSubscription = (): void => {
    const wantStatus = openclawDrawerOpen || openclawChatPanelOpen;
    if (wantStatus && !openclawUnsubscribeStatus) {
      openclawUnsubscribeStatus = openclaw.subscribeStatus((status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
          win.webContents.send('openclaw:status', status);
        }
      });
    } else if (!wantStatus && openclawUnsubscribeStatus) {
      openclawUnsubscribeStatus();
      openclawUnsubscribeStatus = null;
    }
  };
  const syncOpenClawLogSubscription = (): void => {
    if (openclawDrawerOpen && !openclawUnsubscribeLogs) {
      openclawUnsubscribeLogs = openclaw.subscribeLogs((line) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
          win.webContents.send('openclaw:log', line);
        }
      });
    } else if (!openclawDrawerOpen && openclawUnsubscribeLogs) {
      openclawUnsubscribeLogs();
      openclawUnsubscribeLogs = null;
    }
  };
  ipcMain.on('openclaw:set-drawer-open', (_event, open: boolean) => {
    openclawDrawerOpen = Boolean(open);
    syncOpenClawStatusSubscription();
    syncOpenClawLogSubscription();
  });
  ipcMain.on('openclaw:chat-panel-mounted', (_event, mounted: boolean) => {
    openclawChatPanelOpen = Boolean(mounted);
    syncOpenClawStatusSubscription();
  });

  // ── OpenClaw chat WebContentsView IPC (openclaw-management M3) ───────────
  // The placeholder panel (OpenClawChatPanel.tsx) reports its bounding rect
  // and App.tsx's single effective-visibility derivation continuously; the
  // manager itself decides lazy creation (see openclaw-chat-view.ts's module
  // doc). `chat-open` is sent only once the panel observes status==='running'
  // (requesting the view); `chat-close` is the panel's unmount, fully
  // destroying the view (a closed singleton panel has no use for a live,
  // hidden WebContentsView still holding a renderer process).
  ipcMain.on('openclaw:chat-open', () => {
    void openClawChatView?.ensureView();
  });
  ipcMain.on('openclaw:chat-close', () => {
    openClawChatView?.destroy();
  });
  ipcMain.on('openclaw:chat-bounds', (_event, bounds: Rectangle) => {
    if (bounds && typeof bounds === 'object') openClawChatView?.setBounds(bounds);
  });
  ipcMain.on('openclaw:chat-visible', (_event, visible: boolean) => {
    const isVisible = Boolean(visible);
    if (isVisible) void openClawChatView?.ensureView();
    openClawChatView?.setVisible(isVisible);
  });
  ipcMain.on('openclaw:chat-reload', () => {
    void openClawChatView?.reload();
  });
  // "브라우저로 열기" escape hatch (openclaw-stabilization M6) — resolves the
  // SAME token'd chat URL the embedded view uses and hands it to the OS
  // default browser instead, for when the WebContentsView embed misbehaves.
  ipcMain.handle('openclaw:chat-open-external', async (): Promise<boolean> => {
    const url = await openclaw.getChatUrl();
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  createWindow();
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
