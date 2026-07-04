import {
  app,
  BrowserWindow,
  crashReporter,
  ipcMain,
  MessageChannelMain,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type { UtilityProcess } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import started from 'electron-squirrel-startup';

import { isAppUrl } from './url-guard';
import { LayoutStore } from './layout-store';
import { ScriptHostRegistry } from './script-host-registry';
import { PacketCaptureRegistry } from './packet-capture-registry';
import { KnownHostsStore } from './known-hosts-store';
import { LogFile, pruneCrashDumps } from './diagnostics';
import { SystemStatsService } from './system-stats-service';
import type { StartupPref, ThemeName } from '../shared/layout-schema';
import type { InterpreterToMain, MainToInterpreter, SessionInfo } from '../shared/ipc';

// The main process is the broker (architecture §1).
// It owns the interpreter utilityProcess lifetime and brokers per-command
// MessagePorts between the renderer and the interpreter so that bulk frame
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

// Status overlay panel stats collector — created once on 'ready' (status-overlay-panel).
let systemStatsService: SystemStatsService | null = null;

// Packet-capture host registry (Phase 2B) — created once on 'ready'; referenced
// from createWindow()'s lifecycle hooks below, so (like systemStatsService) it
// must be a module-level `let`, not a local const inside the 'ready' handler.
let packetCaptureRegistry: PacketCaptureRegistry | null = null;

// Pending `create-session` round-trips, keyed by requestId: the interpreter mints
// the authoritative {sessionId, cwd} and replies with `session-created` (Codex B5).
// Rejected en masse if the interpreter dies mid-request (Codex B8).
const pendingCreates = new Map<
  string,
  { resolve: (info: SessionInfo) => void; reject: (err: Error) => void }
>();

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
    title: 'EZTerminal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security defaults kept explicit: the renderer never gets Node access;
      // it talks to main only through the narrow preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
    if (/^https?:/i.test(url)) void shell.openExternal(url);
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
    systemStatsService?.setPanelVisible(false);
    // Same reasoning for the packet-capture sub-view (Phase 2B): a reload
    // drops the renderer's port reference, so any live host is now orphaned.
    packetCaptureRegistry?.kill();
  });

  // Window destroy (Phase 2B): stop any live capture host — it must not
  // outlive the window whose renderer it was streaming packets to.
  mainWindow.on('closed', () => {
    packetCaptureRegistry?.kill();
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
      if (!interpreter) {
        console.error('[main] interpreter not ready for command:', payload?.commandText);
        return;
      }
      const { commandText, runId, sessionId } = payload;
      const { port1, port2 } = new MessageChannelMain();
      // Send command + session + port2 to interpreter (session must already exist).
      interpreter.postMessage({ type: 'run', commandText, sessionId }, [port2]);
      // Transfer port1 to renderer — arrives as a DOM MessagePort via event.ports.
      // Echo `runId` so the preload/renderer correlate THIS port to THIS run even
      // when multiple runs are in flight across panes (Codex B3).
      event.sender.postMessage('cmd-port', { runId }, [port1]);
      console.log(`[main] brokered port for run ${runId} in session ${sessionId}`);
    },
  );
};

app.on('ready', () => {
  console.log('[main] EZTerminal main process ready');

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

  // ── Status overlay panel stats (status-overlay-panel) ─────────────────────
  // The service always ticks its graph loop (CPU/MEM ring buffer, app
  // lifetime); this callback only decides whether to PUSH a snapshot to the
  // renderer, gated on panelVisible — 1Hz push cost is zero while closed.
  systemStatsService = new SystemStatsService(mainLog, (snapshot) => {
    if (!systemStatsService?.isPanelVisible()) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('stats:update', snapshot);
    }
  });
  systemStatsService.start();
  ipcMain.handle('stats:history', () => systemStatsService?.getHistory() ?? []);
  ipcMain.on('stats:panel-visible', (_event, visible: boolean) => {
    systemStatsService?.setPanelVisible(Boolean(visible));
  });

  // ── Packet capture (Phase 2B, off-by-default sub-view) ───────────────────
  // main only forks the host and brokers its port to the renderer — it never
  // sees packet rows or capture status (both flow host -> renderer directly
  // over the port, same "bulk stays off main" shape as run-command's cmd-port
  // below). Output resolves to .vite/build/packet-capture-host.js, same
  // directory as main.js/interpreter-process.js/script-host.js.
  packetCaptureRegistry = new PacketCaptureRegistry(
    path.join(__dirname, 'packet-capture-host.js'),
  );
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
  ipcMain.handle('settings:get-theme', async () => {
    await storeReady;
    return layoutStore.getTheme();
  });
  ipcMain.handle('settings:set-theme', async (_event, theme: ThemeName) => {
    await storeReady;
    await layoutStore.setTheme(theme);
  });
  // Best-effort final flush; the debounced save already persisted anything
  // older than ~300ms (accepted v1 loss window — gate Q2).
  app.on('before-quit', () => {
    void layoutStore.flush();
    systemStatsService?.stop();
    packetCaptureRegistry?.kill();
  });

  // Session lifecycle (Codex B1/B5). create-session is the ONLY way a shell session
  // comes into being — the interpreter mints the authoritative {sessionId, cwd} and
  // replies via `session-created`, correlated by requestId. A pane awaits this before
  // it can run commands.
  ipcMain.handle('create-session', (_event, cwd?: string): Promise<SessionInfo> => {
    return new Promise<SessionInfo>((resolve, reject) => {
      if (!interpreter) {
        reject(new Error('interpreter not running'));
        return;
      }
      const requestId = randomUUID();
      pendingCreates.set(requestId, { resolve, reject });
      interpreter.postMessage({ type: 'create-session', requestId, cwd });
    });
  });

  // Destroy a session when its pane/tab closes (fire-and-forget; interpreter aborts
  // the session's in-flight runs and drops it — idempotent, Codex B2/B6).
  ipcMain.on('destroy-session', (_event, sessionId: string) => {
    interpreter?.postMessage({ type: 'destroy-session', sessionId });
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
  console.log(`[main] spawning interpreter at: ${interpreterPath}`);

  interpreter = utilityProcess.fork(interpreterPath, [], {
    serviceName: 'EZTerminal Interpreter',
    stdio: 'inherit',
  });

  // run-script (E4 §6.1): main is the only process that can fork a utilityProcess
  // (C1/C2), so the interpreter asks main to spawn/kill a script-host per
  // `run-script` invocation, correlated by hostId. Output resolves to
  // .vite/build/script-host.js, same directory as main.js/interpreter-process.js.
  const scriptHostRegistry = new ScriptHostRegistry(path.join(__dirname, 'script-host.js'));

  // Interpreter → main replies: `session-created` for create-session, and the
  // script-host spawn/kill protocol (E4).
  interpreter.on('message', (msg: InterpreterToMain) => {
    if (msg?.type === 'session-created') {
      const pending = pendingCreates.get(msg.requestId);
      if (pending) {
        pendingCreates.delete(msg.requestId);
        pending.resolve({ sessionId: msg.sessionId, cwd: msg.cwd });
      }
    } else if (msg?.type === 'spawn-script-host') {
      const result = scriptHostRegistry.spawn(msg.hostId, msg.scriptPath, msg.args, msg.cwd, (hostId, code) => {
        interpreter?.postMessage({ type: 'script-host-exit', hostId, code } satisfies MainToInterpreter);
      });
      if ('error' in result) {
        interpreter?.postMessage({
          type: 'script-host-error',
          hostId: msg.hostId,
          message: result.error,
        } satisfies MainToInterpreter);
      } else {
        interpreter?.postMessage(
          { type: 'script-host-ready', hostId: msg.hostId } satisfies MainToInterpreter,
          [result.interpreterPort],
        );
      }
    } else if (msg?.type === 'kill-script-host') {
      scriptHostRegistry.kill(msg.hostId);
    } else if (msg?.type === 'known-host-check') {
      const { requestId, host, port, keyType, fingerprint } = msg;
      void knownHostsReady
        .then(() => knownHostsStore.check(host, port, keyType, fingerprint))
        .then((outcome) => {
          interpreter?.postMessage({
            type: 'known-host-verdict',
            requestId,
            verdict: outcome.verdict,
            existingFingerprint: outcome.existingFingerprint,
            knownHostsPath: knownHostsStore.path,
          } satisfies MainToInterpreter);
        })
        .catch((err: unknown) => {
          console.error('[main] known-host-check failed:', err);
          // Fail closed as 'unknown' (re-prompts TOFU) rather than dropping the
          // request — a store error must never silently resolve as 'match'.
          interpreter?.postMessage({
            type: 'known-host-verdict',
            requestId,
            verdict: 'unknown',
            knownHostsPath: knownHostsStore.path,
          } satisfies MainToInterpreter);
        });
    } else if (msg?.type === 'known-host-add') {
      void knownHostsReady
        .then(() => knownHostsStore.add(msg.host, msg.port, msg.keyType, msg.fingerprint))
        .catch((err: unknown) => {
          console.error('[main] known-host-add failed:', err);
        });
    }
  });

  interpreter.on('exit', (code) => {
    console.log(`[main] interpreter exited with code ${String(code)}`);
    mainLog?.line(`interpreter exited with code ${String(code)} (all sessions dead)`);
    interpreter = null;
    // Shared-fate (Codex B8, extended for E4): ONE utilityProcess backs every
    // session, so its death kills them all — including every live script-host,
    // which would otherwise become an orphaned process (design §6.1). Fail
    // in-flight create-session calls and tell every renderer to mark its panes
    // dead + stop accepting runs (no auto-respawn in Phase 1).
    scriptHostRegistry.killAll();
    for (const { reject } of pendingCreates.values()) {
      reject(new Error('interpreter exited'));
    }
    pendingCreates.clear();
    // The payload (additive, B-M5) lets the renderer's banner point the user at
    // the local evidence.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('session-dead', { logPath: mainLog?.path ?? null });
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
