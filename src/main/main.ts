import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  nativeTheme,
  Notification,
  protocol,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type {
  IpcMainInvokeEvent,
  MessagePortMain,
  OpenDialogOptions,
  UtilityProcess,
  WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isAppUrl } from './url-guard';
import { APP_RENDERER_ORIGIN } from '../shared/desktop-window';
import {
  rendererEntryUrls,
  resolveRendererAssetPath,
} from './app-renderer-protocol';
import { DesktopWindowManager } from './desktop-window-manager';
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
import { RendererCrashRecovery } from './renderer-crash-recovery';
import { RendererRecoveryCheckpointStore } from './renderer-recovery-checkpoint-store';
import { installRunCommandIpc } from './run-command-ipc';
import { GracefulShutdownCoordinator } from './graceful-shutdown';
import { OpenClawService } from './openclaw-service';
import { OpenClawLifecycleCoordinator } from './openclaw-lifecycle-coordinator';
import { OpenClawChatViewManager } from './openclaw-chat-view';
import { OpenClawChatSurfaceRevisionGate } from './openclaw-chat-surface-revisions';
import { startOpenClawProxy, DEFAULT_OPENCLAW_PROXY_PORT, type OpenClawProxyHandle } from './openclaw-proxy';
import { resolveOpenClawVisibility } from './openclaw-visibility';
import { InterpreterBroker, type BrokerInterpreter } from './interpreter-broker';
import { SshForwardService } from './ssh-forward-service';
import { sshForwardFailure, type SshForwardResult } from '../shared/ssh-forward';
import { AgentActivityService, type AgentActivityTransition } from './agent-activity-service';
import { AgentHookRelay, isAgentIntegrationProvider } from './agent-hook-relay';
import { AgentHookInstaller } from './agent-hook-installer';
import { AgentSettingsStore } from './agent-settings-store';
import { AgentProjectStore } from './agent-project-store';
import { AgentCoordinationStore } from './agent-coordination-store';
import { AgentCoordinationService } from './agent-coordination-service';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamService } from './agent-team-service';
import { AgentValidationRunner } from './agent-validation-runner';
import { ManagedMergeService } from './managed-merge-service';
import { AgentControlServer } from './agent-control-server';
import { AgentCliShim } from './agent-cli-shim';
import { AgentHistoryService } from './agent-history-service';
import { CodexAppServerClient } from './codex-app-server-client';
import { CodexHistoryAdapter } from './codex-history-adapter';
import { ClaudeHistoryAdapter } from './claude-history-adapter';
import { GitStatusService } from './git-status-service';
import { PairingCodeService } from './pairing-code-service';
import { QuickCommandStore } from './quick-command-store';
import { WorkspaceFileSearchService } from './workspace-file-search-service';
import { ProjectWorkspaceService } from './project-workspace-service';
import { ProjectReviewService } from './project-review-service';
import { ProjectDocumentService } from './project-document-service';
import { ProjectWorkspaceAccessStore } from './project-workspace-access-store';
import { ProjectMapBindingStore } from './project-map-binding-store';
import { ProjectMapCacheStore } from './project-map-cache-store';
import { ProjectMapApprovalStore } from './project-map-approval-store';
import { ProjectMapJobStore } from './project-map-job-store';
import { exportProjectMap } from './project-map-exporter';
import { ProjectMapService } from './project-map-service';
import { GitRunner, WorktreeService } from './worktree-service';
import { AsyncMutationGate } from './async-mutation-gate';
import { SessionWorktreeGuard } from './session-worktree-guard';
import { SessionSurfaceAuthority } from './session-surface-authority';
import type {
  RemoteFileSource,
  RemoteOpenClawSource,
  RemotePacketSource,
  RemoteQuickCommandSource,
  RemoteStatsSource,
} from './remote-bridge';
import { RemoteDeviceRoster } from './remote-device-roster';
import type { DesktopRuntime } from './desktop-runtime';
import { createElectronDesktopRuntime } from './electron-desktop-runtime-adapter';
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
} from '../shared/ipc';
import {
  isProjectMapBindingRequest,
  isProjectMapCollectionRequest,
  isProjectMapApprovalRequest,
  isProjectMapExportRequest,
  isProjectMapJobRequest,
  isProjectMapReadRequest,
  isProjectMapStartJobRequest,
} from '../shared/project-map';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentParticipantInput,
  type AgentProjectCoordinationInput,
  type ManagedMergeDecisionInput,
  type ManagedMergeGrantInput,
} from '../shared/agent-coordination';
import type {
  InterpreterToMain,
  MainToInterpreter,
  RunStartedInfo,
  SystemStatsSnapshot,
} from '../shared/ipc';
import {
  isOpenClawChatSurfaceSnapshot,
  type OpenClawAutostartAction,
  type OpenClawControlSnapshot,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleReceipt,
  type OpenClawVisibility,
} from '../shared/openclaw';
import type { AgentDecisionResult } from '../shared/agent';
import {
  EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT,
  type AgentLauncherCapabilities,
  type AgentPersonaInput,
  type AgentStarterTeamInput,
  type AgentTeamDesktopSnapshot,
  type AgentTeamInput,
  type AgentTeamMemberActivationInput,
  type AgentTeamMemberBinding,
  type AgentTeamMemberFailureInput,
  type AgentTeamMemberLaunchInput,
  type AgentTeamPlanApprovalInput,
  type AgentTeamRunDecisionInput,
  type AgentTeamRunInput,
  composeAgentTeamPlanningBrief,
} from '../shared/agent-team';
import { normalizeExternalHttpUrl } from '../shared/external-url';
import type {
  AgentLaunchStartRequest,
  AgentLaunchStartResult,
  AgentLaunchTarget,
  AgentProjectLaunchStartRequest,
  AgentProjectLaunchStartResult,
  AgentProjectInput,
  AgentResumeStartRequest,
  AgentResumeStartResult,
} from '../shared/agent-history';
import { MAX_AGENT_LAUNCH_DIRECTORY_LENGTH } from '../shared/agent-history';
import { classifyRecentPanelInput } from './recent-panel-input';
import type { WorkspaceFileSearchRequest } from '../shared/workspace-search';
import { isWorktreeRequest, type WorktreeInfo, type WorktreeResult } from '../shared/worktree';
import { isProjectSessionTarget } from '../shared/project-workspace';
import type { TerminalFileLocationRequest } from '../shared/terminal-file-location';
import { resolveTerminalFileLocation } from './terminal-path-resolver';
import {
  isSessionSurfaceCloseDecisions,
  isSessionSurfaceCloseEntries,
  isSessionSurfaceId,
  isSessionSurfaceIntent,
} from '../shared/session-surface';
import {
  readTerminalClipboardSnapshot,
  writeTerminalClipboardText,
} from './terminal-clipboard';
import { isTerminalPastePreferences } from '../shared/terminal-clipboard';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
import { AppUpdateService } from './app-update-service';
import { resolveNativeHostPath } from './native-host-path';
import { ProcessGuardian } from './process-guardian';
import { ElectronUpdateHttpClient } from './app-update-network';
import {
  UiPreferencesPatchSchema,
  resolveUiLocale,
  type UiLocalePreference,
} from '../shared/ui-preferences';

const osc52LastWrite = new WeakMap<object, number>();
const OSC52_MAIN_MAX_BYTES = 64 * 1024;
const OSC52_MAIN_MIN_INTERVAL_MS = 1_000;

function isBoundedAgentString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isAgentLaunchTarget(value: unknown): value is AgentLaunchTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (target.kind === 'project') {
    return Object.keys(target).every((key) => (
      key === 'kind' || key === 'projectId' || key === 'rootId' || key === 'workspaceId'
    )) && isProjectSessionTarget({
      projectId: target.projectId,
      ...(target.rootId !== undefined ? { rootId: target.rootId } : {}),
      ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
    });
  }
  if (target.kind === 'directory') {
    return isBoundedAgentString(target.directory, MAX_AGENT_LAUNCH_DIRECTORY_LENGTH);
  }
  return false;
}

function isAgentTeamLaunchReference(value: unknown): value is NonNullable<AgentLaunchStartRequest['teamMember']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const reference = value as Partial<NonNullable<AgentLaunchStartRequest['teamMember']>>;
  return isBoundedAgentString(reference.runId, 64) && isBoundedAgentString(reference.personaId, 64);
}

function isAgentTeamMemberBinding(value: unknown): value is AgentTeamMemberBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const limits: Readonly<Record<string, number>> = {
    branch: 200,
    rootId: 128,
    workspaceId: 128,
    worktreeId: 128,
    worktreePath: 8_192,
    sessionId: 256,
    activityId: 256,
    participantId: 256,
  };
  return Object.entries(binding).every(([key, item]) => (
    limits[key] !== undefined && isBoundedAgentString(item, limits[key]!)
  ));
}

function isAgentLaunchStartRequest(value: unknown): value is AgentLaunchStartRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Partial<AgentLaunchStartRequest>;
  return (
    isAgentLaunchTarget(request.target)
    && isBoundedAgentString(request.launcherId, 128)
    && isBoundedAgentString(request.sessionId, 256)
    && isBoundedAgentString(request.runId, 256)
    && isBoundedAgentString(request.revision, 128)
    && (request.teamMember === undefined || isAgentTeamLaunchReference(request.teamMember))
  );
}

function directoryKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

// The main process owns the interpreter utilityProcess lifetime
// (`docs/architecture.md`). Per-command MessagePort brokering + session/run correlation live in the
// extracted InterpreterBroker (interpreter-broker.ts); main (local IPC) and
// remote-bridge (WS) are thin adapters over one shared instance, so bulk frame
// data never routes through main.

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
if (!allowMultipleInstances) {
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
let processGuardian: ProcessGuardian | null = null;
let interpreterGroupId: string | null = null;
let appIsQuitting = false;

function requireProcessGuardian(): ProcessGuardian {
  if (!processGuardian) throw new Error('Windows process guardian is unavailable');
  return processGuardian;
}

async function openExternalForUser(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await requireProcessGuardian().shellHandoff('open', url);
    return;
  }
  await shell.openExternal(url);
}

async function openPathForUser(filePath: string): Promise<string> {
  if (process.platform !== 'win32') return shell.openPath(filePath);
  try {
    await requireProcessGuardian().shellHandoff('open', filePath);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function revealPathForUser(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    await requireProcessGuardian().shellHandoff('reveal', filePath);
    return;
  }
  shell.showItemInFolder(filePath);
}

// The single main-side broker over the interpreter — created once on 'ready'
// right after the fork. main (local IPC) and remote-bridge (WS) are thin
// adapters over this ONE instance; it owns the create-session/list-runs
// correlation state, the run/attach port brokering, and the session/run dispatch.
let broker: InterpreterBroker | null = null;
let sessionSurfaceAuthority: SessionSurfaceAuthority | null = null;
const desktopSessionPrincipalByWebContentsId = new Map<number, string>();
const sessionSurfaceLifecycleWired = new WeakSet<WebContents>();
const rendererRecoveryCheckpoints = new RendererRecoveryCheckpointStore();
const recoveringDesktopWebContents = new Set<number>();

function releaseDesktopSessionPrincipal(webContentsId: number): void {
  const principalId = desktopSessionPrincipalByWebContentsId.get(webContentsId);
  if (!principalId) return;
  desktopSessionPrincipalByWebContentsId.delete(webContentsId);
  sessionSurfaceAuthority?.disconnectClient(principalId);
}

function prepareDesktopRendererRecovery(webContentsId: number): void {
  rendererRecoveryCheckpoints.markRecoverable(webContentsId);
  recoveringDesktopWebContents.add(webContentsId);
  const principalId = desktopSessionPrincipalByWebContentsId.get(webContentsId);
  if (principalId) sessionSurfaceAuthority?.suspendClient(principalId);
}

function resolveDesktopSessionPrincipal(
  event: IpcMainInvokeEvent,
  clientInstanceId: unknown,
): string | null {
  if (!isSessionSurfaceId(clientInstanceId) || !sessionSurfaceAuthority) return null;
  const sender = event.sender;
  const principalId = `desktop:${sender.id}:${clientInstanceId}`;
  sessionSurfaceAuthority.connectClient(principalId, `desktop:${sender.id}`);
  desktopSessionPrincipalByWebContentsId.set(sender.id, principalId);
  recoveringDesktopWebContents.delete(sender.id);
  if (!sessionSurfaceLifecycleWired.has(sender)) {
    sessionSurfaceLifecycleWired.add(sender);
    sender.on('did-navigate', () => {
      if (!recoveringDesktopWebContents.has(sender.id)) {
        releaseDesktopSessionPrincipal(sender.id);
      }
    });
    sender.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || appIsQuitting) {
        releaseDesktopSessionPrincipal(sender.id);
      } else {
        prepareDesktopRendererRecovery(sender.id);
      }
    });
    sender.on('destroyed', () => {
      recoveringDesktopWebContents.delete(sender.id);
      rendererRecoveryCheckpoints.clear(sender.id);
      releaseDesktopSessionPrincipal(sender.id);
    });
  }
  return principalId;
}

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

// Deep Module owning remote listener, desktop-control, IPC, and cleanup lifecycle.
let desktopRuntime: DesktopRuntime | null = null;

// OpenClaw reverse proxy (openclaw-management M4) — started lazily by the
// first authenticated chat-ticket request, independently of the core bridge.
let openClawProxyHandle: OpenClawProxyHandle | null = null;

// OpenClaw management service (openclaw-management M1) — created once on
// 'ready'; referenced only for before-quit dispose() below (all its IPC
// handlers close over a local const, see the 'ready' handler).
let openClawService: OpenClawService | null = null;
let openClawLifecycleCoordinator: OpenClawLifecycleCoordinator | null = null;

// OpenClaw chat WebContentsView manager (openclaw-management M3) — created
// once on 'ready', attached to the main window in createWindow() (needs a
// module-level ref, mirrors mainWindowRef below), torn down on window
// reload/close (packetCaptureRegistry teardown hygiene precedent) and quit.
let openClawChatView: OpenClawChatViewManager | null = null;

// The main BrowserWindow — module-level (like the refs above) because
// createWindow() itself is defined outside 'ready', and openClawChatView's
// attach() needs a handle to the window it should embed into.
let mainWindowRef: BrowserWindow | null = null;
let desktopWindowManager: DesktopWindowManager | null = null;
let quitConfirmationOpen = false;

function requestExplicitQuit(): void {
  if (appIsQuitting || quitConfirmationOpen) return;
  quitConfirmationOpen = true;
  const korean = app.getLocale().toLowerCase().startsWith('ko');
  const options = {
    type: 'warning' as const,
    title: 'EZTerminal',
    message: korean ? 'EZTerminal을 종료할까요?' : 'Quit EZTerminal?',
    detail: korean
      ? '실행 중인 터미널과 에이전트 세션이 모두 종료됩니다. 창만 닫으려면 취소한 뒤 닫기 버튼을 사용하세요.'
      : 'All running terminal and agent sessions will stop. To close only the window, cancel and use the window close button.',
    buttons: korean ? ['취소', '종료'] : ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const owner = mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.isVisible()
    ? mainWindowRef
    : null;
  const prompt = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  void prompt.then(({ response }) => {
    quitConfirmationOpen = false;
    if (response === 1 && !appIsQuitting) app.quit();
  }).catch((error) => {
    quitConfirmationOpen = false;
    mainLog?.line(`quit confirmation failed: ${String(error)}`);
  });
}

// OpenClaw desktop visibility (openclaw-stabilization M5): in 'auto' mode,
// `resolveOpenClawVisibility` only ever reruns on boot or an explicit
// mode toggle — nothing re-queries `isInstalled()` on its own, so installing
// or uninstalling the openclaw CLI mid-session never updates gating until
// one of those happens. This drives a periodic recheck (main.ts, near the
// other openclaw wiring) that's a no-op outside 'auto' mode.
const OPENCLAW_VISIBILITY_RECHECK_MS = 30_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Rebuild the terminal-safe native menu when the UI language changes. */
function applyNativeMenuLocale(preference: UiLocalePreference): void {
  const locale = resolveUiLocale(preference, app.getPreferredSystemLanguages());
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(locale, requestExplicitQuit)));
}

// Defense-in-depth CSP for the raw-HTML injection sink in TextBlock (the ANSI →
// HTML external output, sanitized upstream by ansi_up). Strict: only same-origin
// scripts, no inline/eval scripts, no remote connections, no <object>/<base>/
// framing (SEC-MED-3). `style-src` keeps 'unsafe-inline' because ansi_up colors
// are emitted as inline style attributes.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'; " +
  "form-action 'none'";

const rendererRoot = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}`,
);
const rendererUrls = rendererEntryUrls(MAIN_WINDOW_VITE_DEV_SERVER_URL);
const desktopPreloadPath = path.join(__dirname, 'preload.js');

/**
 * Dockview's popout safety check requires an HTTP(S) same-origin page. A
 * packaged build therefore serves only Vite's renderer output from a
 * synthetic HTTPS origin. Unrelated HTTPS requests bypass this handler and
 * continue through Chromium's normal network stack.
 */
function installPackagedRendererProtocol(): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return;
  protocol.handle('https', async (request) => {
    if (!request.url.startsWith(`${APP_RENDERER_ORIGIN}/`)) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    const assetPath = resolveRendererAssetPath(rendererRoot, request.url, request.method);
    if (!assetPath) return new Response('Not found', { status: 404 });
    try {
      const asset = await stat(assetPath);
      if (!asset.isFile()) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(assetPath).href, { method: request.method });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Chromium consumes Ctrl+Tab before renderer KeyboardEvents. Capture it in
 * every native window, but route the data-free command to the sole main
 * renderer where the shared Dockview instance lives.
 */
function configureRecentPanelInput(
  window: BrowserWindow,
  kind: import('../shared/desktop-window').DesktopWindowKind,
  windowName?: string,
): void {
  let active = false;
  const source: import('../shared/ipc').RecentPanelWindowSource = kind === 'main'
    ? { kind: 'main' }
    : { kind: 'auxiliary', windowName: windowName ?? '' };
  const send = (input: import('../shared/ipc').RecentPanelInputCommand): void => {
    const mainWindow = mainWindowRef;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('recent-panels:input', { ...input, source });
    }
  };
  window.webContents.on('before-input-event', (event, input) => {
    const decision = classifyRecentPanelInput(active, input);
    active = decision.active;
    if (!decision.event) return;
    if (decision.preventDefault) event.preventDefault();
    send(decision.event);
  });
  window.on('blur', () => {
    if (!active) return;
    active = false;
    send({ type: 'cancel', restoreFocus: false });
  });
}

const createWindow = (): void => {
  const rendererCrashRecovery = new RendererCrashRecovery();
  let crashFailureDialogOpen = false;
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'EZTerminal',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: desktopPreloadPath,
      // Security defaults kept explicit: the renderer never gets Node access;
      // it talks to main only through the narrow preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  });
  mainWindowRef = mainWindow;
  desktopWindowManager?.configureMainWindow(mainWindow);
  openClawChatView?.attach(mainWindow);

  // Chromium reserves Ctrl+Tab before a renderer KeyboardEvent exists (the
  // real Electron E2E observes ControlLeft but no Tab keydown). Capture only
  // that chord here, suppress its native handling, and forward a data-free
  // cycle/commit/cancel union through the isolated desktop bridge. All other
  // keyboard input, including terminal Ctrl chords, stays on the normal path.
  // ── Navigation hardening (SEC-HIGH-2) ─────────────────────────────────────
  // An OSC-8 link in external output (TextBlock <a href>) must never navigate the
  // window to a remote origin (it would inherit window.ezterminal). Block any
  // in-window navigation away from the app origin, and route external links to the
  // OS browser instead of opening a renderer-privileged window.
  // The ONLY file:// URL that may load is our own packaged index.html (B-M6:
  // arbitrary file:// would hand the bridge to any local html file).
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(rendererUrls.main);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(rendererUrls.main);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] renderer finished loading');
    rendererCrashRecovery.armStabilityTimer();
  });

  // A dead/killed renderer is a crash-grade event worth local evidence (B-M5).
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    mainLog?.line(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (appIsQuitting || mainWindow.isDestroyed()) return;
    if (details.reason !== 'clean-exit') {
      prepareDesktopRendererRecovery(mainWindow.webContents.id);
    }
    const decision = rendererCrashRecovery.decide(details.reason);
    mainLog?.line(`renderer crash recovery decision=${decision}`);
    if (decision === 'reload') {
      setTimeout(() => {
        if (!appIsQuitting && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      }, 250).unref();
      return;
    }
    if (decision !== 'show-failure' || crashFailureDialogOpen) return;
    crashFailureDialogOpen = true;
    const korean = app.getLocale().toLowerCase().startsWith('ko');
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'EZTerminal',
      message: korean
        ? '화면 프로세스 복구가 반복해서 실패했습니다.'
        : 'The interface process repeatedly failed to recover.',
      detail: korean
        ? '터미널 세션은 백그라운드에 유지됩니다. 화면을 다시 불러오거나 앱을 종료할 수 있습니다.'
        : 'Terminal sessions remain in the background. Reload the interface or quit the app.',
      buttons: korean ? ['화면 다시 불러오기', '앱 종료'] : ['Reload interface', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      crashFailureDialogOpen = false;
      if (appIsQuitting || mainWindow.isDestroyed()) return;
      if (response === 0) {
        rendererCrashRecovery.markStable();
        mainWindow.webContents.reload();
      } else {
        app.quit();
      }
    }).catch((error) => {
      crashFailureDialogOpen = false;
      mainLog?.line(`renderer crash recovery dialog failed: ${String(error)}`);
    });
  });

  // A reload must not leave the status overlay's panel-open-only collectors
  // running against a renderer that no longer thinks the panel is open
  // (status-overlay-panel: panelVisible lifecycle).
  mainWindow.webContents.on('did-navigate', () => {
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
    rendererCrashRecovery.dispose();
    packetCaptureRegistry?.kill();
    openClawChatView?.destroy();
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  // ── Per-command MessagePort brokering (`docs/design/terminal-runtime.md`) ──
  // The app-lifetime run-command listener is installed once after the broker
  // is constructed. Window recreation must not register global IPC again.
};

app.on('ready', async () => {
  console.log('[main] EZTerminal main process ready');

  if (process.platform === 'win32') {
    try {
      processGuardian = await ProcessGuardian.start({
        executablePath: resolveNativeHostPath(),
        ownerPid: process.pid,
        reportError: (message) => {
          console.error(message);
          mainLog?.line(message);
        },
      });
      console.log('[main] process guardian ready');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[main] process guardian startup failed:', error);
      dialog.showErrorBox(
        'EZTerminal startup failed',
        `The Windows process guardian could not start. Local commands were not enabled.\n\n${detail}`,
      );
      app.exit(1);
      return;
    }
  }

  installPackagedRendererProtocol();
  desktopWindowManager = new DesktopWindowManager({
    auxiliaryRendererUrl: rendererUrls.auxiliary,
    preloadPath: desktopPreloadPath,
    isAllowedNavigation: (url) => (
      isAppUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL, rendererUrls.main)
    ),
    getMainWindow: () => mainWindowRef,
    isAppQuitting: () => appIsQuitting,
    quitApp: () => app.quit(),
    openExternal: openExternalForUser,
    onWindowConfigured: (window, kind, name) => configureRecentPanelInput(window, kind, name),
    reportError: (context, error) => {
      console.error(`[main] ${context}:`, error);
      mainLog?.line(`${context}: ${String(error)}`);
    },
  });

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
  let uninstallRunCommandIpc: (() => void) | null = null;
  let scriptHostRegistry: ScriptHostRegistry | null = null;
  quickCommandStore.subscribe((commands) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('quick-commands:changed', commands);
    }
  });

  const appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    resolveDownloadsDirectory: () => path.join(app.getPath('downloads'), 'EZTerminal'),
    http: new ElectronUpdateHttpClient(),
    openPath: openPathForUser,
  });
  appUpdateService.subscribe((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('app-update:snapshot', snapshot);
    }
  });
  ipcMain.handle('app-update:get-snapshot', () => appUpdateService.getSnapshot());
  ipcMain.handle('app-update:check', () => appUpdateService.check());
  ipcMain.handle('app-update:download', () => appUpdateService.download());
  ipcMain.handle('app-update:cancel-download', () => appUpdateService.cancelDownload());
  ipcMain.handle('app-update:open', (_event, options: unknown) => {
    if (
      typeof options !== 'object'
      || options === null
      || Array.isArray(options)
      || Object.keys(options).length !== 1
      || typeof (options as { acknowledgeUnsigned?: unknown }).acknowledgeUnsigned !== 'boolean'
    ) {
      return { ok: false as const, reason: 'failed' as const };
    }
    return appUpdateService.openDownloadedUpdate(
      (options as { acknowledgeUnsigned: boolean }).acknowledgeUnsigned,
    );
  });

  // Agent activity persistence + loopback hook relay. The relay binds only to
  // 127.0.0.1 and its bearer descriptor is injected into interpreter shell
  // sessions below; it never crosses preload or the mobile bridge.
  const agentSettingsStore = new AgentSettingsStore(path.join(app.getPath('userData')));
  const agentProjectStore = new AgentProjectStore(path.join(app.getPath('userData')));
  const agentCoordinationStore = new AgentCoordinationStore(app.getPath('userData'));
  const agentTeamStore = new AgentTeamStore(app.getPath('userData'));
  const agentCoordinationReady = agentCoordinationStore.init().catch((err) => {
    console.error('[main] agent coordination store init failed:', err);
  });
  const agentTeamReady = agentTeamStore.init().catch((err) => {
    console.error('[main] agent Team store init failed:', err);
  });
  const codexHistoryAdapter = new CodexHistoryAdapter(new CodexAppServerClient());
  // Home resolution is left to the adapter so it matches how Claude Code itself
  // locates `~/.claude`.
  const claudeHistoryAdapter = new ClaudeHistoryAdapter();
  const agentHistoryService = new AgentHistoryService(
    agentProjectStore,
    [codexHistoryAdapter, claudeHistoryAdapter],
    () => agentSettingsStore.current.genericProfiles,
  );
  const agentHistoryReady = agentProjectStore.init().catch((err) => {
    console.error('[main] agent project store init failed:', err);
  });
  // Read-only, cached, argv-only. Safe to call on every directory listing.
  const gitStatusService = new GitStatusService();
  // In-memory, single-use, expiring. Never persisted — see the service header.
  const pairingCodeService = new PairingCodeService();
  let agentActivityService: AgentActivityService | null = null;
  let agentCoordinationService: AgentCoordinationService | null = null;
  let agentTeamService: AgentTeamService | null = null;
  let managedMergeService: ManagedMergeService | null = null;
  let agentControlServer: AgentControlServer | null = null;
  const agentCliShim = new AgentCliShim(app.getPath('userData'), resolveNativeHostPath());
  let agentCliAvailable = false;
  const agentCliReady = agentCliShim.init()
    .then(() => { agentCliAvailable = true; })
    .catch((err) => {
      console.error('[main] Agent CLI shim init failed:', err);
    });
  let agentRelayReady = false;
  const agentHookRelay = new AgentHookRelay(
    app.getPath('userData'),
    (event) => {
      agentActivityService?.handleHookEvent(event);
    },
    // No service means no one to ask, so the provider keeps its own prompt.
    async (event) => (await agentActivityService?.requestApproval(event)) ?? null,
  );
  const agentInfrastructureReady = Promise.all([agentSettingsStore.init(), agentHookRelay.start()])
    .then(() => {
      agentRelayReady = true;
    })
    .catch((err) => {
      console.error('[main] agent hook infrastructure init failed:', err);
    });
  const agentHookInstaller = new AgentHookInstaller(app.getPath('home'), agentHookRelay.scriptPath);
  let agentTeamCapabilities: readonly AgentLauncherCapabilities[] = [
    {
      provider: 'codex',
      available: false,
      supportsModel: true,
      effortValues: [],
      permissionValues: ['read-only', 'workspace-write'],
      modelAvailability: 'launch-time',
    },
    {
      provider: 'claude',
      available: false,
      supportsModel: true,
      effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
      permissionValues: ['plan', 'manual', 'acceptEdits'],
      modelAvailability: 'launch-time',
    },
  ];
  const refreshAgentTeamCapabilities = async (): Promise<void> => {
    await agentInfrastructureReady;
    const [statuses, launchers] = await Promise.all([
      agentHookInstaller.list(),
      Promise.resolve(agentHistoryService.listLaunchers()),
    ]);
    const launchProviders = new Set(launchers.map((launcher) => launcher.provider));
    const statusByProvider = new Map(statuses.map((status) => [status.provider, status]));
    const next = agentTeamCapabilities.map((capability): AgentLauncherCapabilities => {
      const status = statusByProvider.get(capability.provider);
      return {
        ...capability,
        available: agentRelayReady
          && agentCliAvailable
          && agentControlServer !== null
          && launchProviders.has(capability.provider)
          && status?.enabled === true
          && status.blockers.length === 0,
      };
    });
    if (JSON.stringify(next) === JSON.stringify(agentTeamCapabilities)) return;
    agentTeamCapabilities = next;
    agentTeamService?.capabilitiesChanged();
  };

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
  void storeReady
    .then(() => layoutStore.getUiPreferences())
    .then((preferences) => systemStatsService?.setResourceProfile(preferences.resourceProfile))
    .catch((err) => mainLog?.line(`resource profile load failed: ${String(err)}`));
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
  const agentTeamGitRunner = new GitRunner();
  const worktreeService = new WorktreeService({
    userDataDir: app.getPath('userData'),
    getSessionCwds: () => broker?.listSessions().map((item) => item.cwd) ?? [],
    mutationGate: sessionWorktreeMutationGate,
    runGuard: sessionWorktreeRunGuard,
  });
  const projectWorkspaceAccessStore = new ProjectWorkspaceAccessStore(app.getPath('userData'));
  const projectWorkspaceAccessReady = projectWorkspaceAccessStore.init().catch((err) => {
    console.error('[main] project workspace access store init failed:', err);
  });
  const projectWorkspaceService = new ProjectWorkspaceService(agentProjectStore, {
    listWorktrees: (cwd) => worktreeService.execute({ action: 'list', cwd }, 'desktop'),
    accessStore: projectWorkspaceAccessStore,
  });
  const projectMapBindingStore = new ProjectMapBindingStore(app.getPath('userData'));
  const projectMapCacheStore = new ProjectMapCacheStore(app.getPath('userData'));
  const projectMapApprovalStore = new ProjectMapApprovalStore(app.getPath('userData'));
  const projectMapJobStore = new ProjectMapJobStore(app.getPath('userData'));
  const projectMapReady = Promise.all([
    projectMapBindingStore.init(),
    projectMapCacheStore.init(),
    projectMapApprovalStore.init(),
    projectMapJobStore.init(),
  ]).catch((err) => {
    console.error('[main] project map stores init failed:', err);
  });
  const projectMapService = new ProjectMapService(
    projectWorkspaceService,
    projectMapBindingStore,
    projectMapCacheStore,
    agentTeamGitRunner,
    projectMapApprovalStore,
    projectMapJobStore,
  );
  projectMapService.onChanged((event) => {
    const request = {
      projectId: event.projectId,
      ownerRootId: event.ownerRootId,
      ownerWorkspaceId: event.ownerWorkspaceId,
      reason: event.reason,
      ...(event.impactedMapIds ? { impactedMapIds: event.impactedMapIds } : {}),
    };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('project-map:changed', request);
      }
    }
  });
  const projectReviewService = new ProjectReviewService(projectWorkspaceService, agentHistoryService);
  const projectDocumentService = new ProjectDocumentService(projectWorkspaceService, projectReviewService);
  const projectWorkspaceSearches = new Map<string, AbortController>();
  const projectWorkspaceReady = Promise.all([agentHistoryReady, projectWorkspaceAccessReady]);
  agentHistoryService.setProjectSessionTargetResolver(async (target) => {
    await projectWorkspaceReady;
    return projectWorkspaceService.resolveSessionTarget(target);
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
    const err = await openPathForUser(path);
    if (err) console.error('[main] shell.openPath failed:', err);
  });
  ipcMain.handle('files:reveal', async (_event, path: string) => {
    await revealPathForUser(path);
  });
  ipcMain.handle('external:open-http-url', async (_event, value: unknown): Promise<boolean> => {
    if (typeof value !== 'string') return false;
    const url = normalizeExternalHttpUrl(value);
    if (!url) return false;
    try {
      await openExternalForUser(url);
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
    systemStatsService?.setResourceProfile(persisted.resourceProfile);
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
  ipcMain.handle('settings:get-boot-intro', async () => {
    await storeReady;
    return layoutStore.getBootIntro();
  });
  ipcMain.handle('settings:set-boot-intro', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    await storeReady;
    await layoutStore.setBootIntro(enabled);
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
  ipcMain.handle('terminal:write-clipboard', (_event, text: unknown): boolean =>
    writeTerminalClipboardText(clipboard, text));
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
  ipcMain.handle('agents:get-snapshot', () => agentActivityService?.getSnapshot() ?? { revision: 0, items: [] });
  ipcMain.handle('agents:get-coordination-snapshot', () => (
    agentCoordinationService?.getSnapshot() ?? EMPTY_AGENT_COORDINATION_SNAPSHOT
  ));
  ipcMain.handle('agents:join-collaboration', async (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentCoordinationService) {
      return { ok: false, error: 'invalid', message: 'Invalid collaboration request.' } as const;
    }
    const result = await agentCoordinationService.join(input as AgentParticipantInput);
    if (result.ok && agentControlServer && broker) {
      const descriptor = agentControlServer.descriptorForSession(result.value.participant.sessionId);
      broker.setPrivateSessionEnvironment(result.value.participant.sessionId, {
        EZTERMINAL_AGENT_CONTROL_DESCRIPTOR: descriptor,
        PATH: agentCliShim.prependToPath(process.env.PATH),
      });
    }
    return result;
  });
  ipcMain.handle('agents:leave-collaboration', (_event, activityId: unknown) => {
    if (typeof activityId !== 'string' || !agentCoordinationService) return false;
    return agentCoordinationService.leave(activityId);
  });
  ipcMain.handle('agents:save-coordination-project', async (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentCoordinationService) {
      return { ok: false, error: 'invalid', message: 'Invalid Project coordination settings.' } as const;
    }
    return agentCoordinationService.saveProject(input as AgentProjectCoordinationInput);
  });
  ipcMain.handle('agent-teams:get-snapshot', async () => {
    await Promise.all([agentTeamReady, refreshAgentTeamCapabilities()]);
    return agentTeamService?.getSnapshot() ?? EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT;
  });
  ipcMain.handle('agent-teams:save-persona', async (_event, input: unknown) => {
    await agentTeamReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Persona settings.' } as const;
    }
    return agentTeamService.savePersona(input as AgentPersonaInput);
  });
  ipcMain.handle('agent-teams:delete-persona', async (
    _event,
    personaId: unknown,
    expectedRevision: unknown,
  ) => {
    await agentTeamReady;
    if (!isBoundedAgentString(personaId, 64)
      || typeof expectedRevision !== 'number'
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1
      || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Persona deletion.' } as const;
    }
    return agentTeamService.deletePersona(personaId, expectedRevision);
  });
  ipcMain.handle('agent-teams:create-starter-team', async (_event, input: unknown) => {
    await Promise.all([agentTeamReady, refreshAgentTeamCapabilities()]);
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid starter Team settings.' } as const;
    }
    return agentTeamService.createStarterTeam(input as AgentStarterTeamInput);
  });
  ipcMain.handle('agent-teams:save-team', async (_event, input: unknown) => {
    await agentTeamReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team settings.' } as const;
    }
    return agentTeamService.saveTeam(input as AgentTeamInput);
  });
  ipcMain.handle('agent-teams:delete-team', async (
    _event,
    teamId: unknown,
    expectedRevision: unknown,
  ) => {
    await agentTeamReady;
    if (!isBoundedAgentString(teamId, 64)
      || typeof expectedRevision !== 'number'
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1
      || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team deletion.' } as const;
    }
    return agentTeamService.deleteTeam(teamId, expectedRevision);
  });
  ipcMain.handle('agent-teams:create-run', async (_event, input: unknown) => {
    await Promise.all([agentTeamReady, refreshAgentTeamCapabilities()]);
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team run.' } as const;
    }
    return agentTeamService.createRun(input as AgentTeamRunInput);
  });
  ipcMain.handle('agent-teams:approve-plan', async (_event, input: unknown) => {
    await agentTeamReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team plan approval.' } as const;
    }
    return agentTeamService.approvePlan(input as AgentTeamPlanApprovalInput);
  });
  ipcMain.handle('agent-teams:decide-run', async (_event, input: unknown) => {
    await agentTeamReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team run decision.' } as const;
    }
    return agentTeamService.decideRun(input as AgentTeamRunDecisionInput);
  });
  ipcMain.handle('agent-teams:fail-member', async (_event, input: unknown) => {
    await agentTeamReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team member failure.' } as const;
    }
    const candidate = input as Partial<AgentTeamMemberFailureInput>;
    if (!isBoundedAgentString(candidate.runId, 64)
      || !isBoundedAgentString(candidate.personaId, 64)
      || typeof candidate.expectedRevision !== 'number'
      || !Number.isSafeInteger(candidate.expectedRevision)
      || candidate.expectedRevision < 1
      || !isBoundedAgentString(candidate.error, 500)
      || (candidate.binding !== undefined && !isAgentTeamMemberBinding(candidate.binding))) {
      return { ok: false, error: 'invalid', message: 'Invalid Team member failure.' } as const;
    }
    return agentTeamService.bindMember(
      candidate.runId,
      candidate.personaId,
      candidate.expectedRevision,
      'failed',
      candidate.binding,
      candidate.error,
    );
  });
  ipcMain.handle('agents:mark-seen', (_event, activityId: unknown, stateSeq: unknown) => (
    typeof activityId === 'string'
    && typeof stateSeq === 'number'
    && Number.isSafeInteger(stateSeq)
    && agentCoordinationService?.markSeen(activityId, stateSeq) === true
  ));
  ipcMain.handle('agents:prompt', (
    _event,
    activityId: unknown,
    text: unknown,
    options?: unknown,
  ) => {
    const validOptions = options === undefined || (
      typeof options === 'object'
      && options !== null
      && !Array.isArray(options)
      && Object.keys(options).every((key) => key === 'whenReady')
      && (
        (options as { readonly whenReady?: unknown }).whenReady === undefined
        || typeof (options as { readonly whenReady?: unknown }).whenReady === 'boolean'
      )
    );
    if (
      typeof activityId !== 'string'
      || typeof text !== 'string'
      || !validOptions
      || !agentActivityService
    ) {
      return { ok: false, error: 'invalid-text' } as const;
    }
    const whenReady = (options as { readonly whenReady?: boolean } | undefined)?.whenReady === true;
    if (whenReady) {
      return agentCoordinationService?.prompt(activityId, text, { whenReady: true })
        ?? { ok: false, error: 'not-found' } as const;
    }
    return agentActivityService.sendPrompt(activityId, text);
  });
  ipcMain.handle('agents:request-managed-merge', (_event, activityId: unknown, targetBranch: unknown) => {
    if (typeof activityId !== 'string' || typeof targetBranch !== 'string' || !managedMergeService) {
      return { ok: false, error: 'invalid', message: 'Invalid managed merge request.' } as const;
    }
    return managedMergeService.requestForActivity(activityId, targetBranch);
  });
  ipcMain.handle('agents:decide-managed-merge', (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !managedMergeService) {
      return { ok: false, error: 'invalid', message: 'Invalid managed merge decision.' } as const;
    }
    return managedMergeService.decide({
      ...(input as ManagedMergeDecisionInput),
      actor: 'desktop',
    });
  });
  ipcMain.handle('agents:grant-next-managed-merge', (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !managedMergeService) {
      return { ok: false, error: 'invalid', message: 'Invalid one-shot merge grant.' } as const;
    }
    return managedMergeService.grantNext(input as ManagedMergeGrantInput);
  });
  ipcMain.handle('agents:get-managed-merge-diff', (_event, requestId: unknown, revision: unknown) => {
    if (
      typeof requestId !== 'string'
      || typeof revision !== 'number'
      || !Number.isSafeInteger(revision)
      || !managedMergeService
    ) return { ok: false, error: 'git-failed' } as const;
    return managedMergeService.readCandidateDiff(requestId, revision);
  });
  ipcMain.handle('agent-history:list-projects', async (
    _event,
    force?: unknown,
    cursor?: unknown,
    limit?: unknown,
    query?: unknown,
  ) => {
    await agentHistoryReady;
    return agentHistoryService.listProjects(
      force === true,
      typeof cursor === 'string' ? cursor : undefined,
      typeof limit === 'number' ? limit : undefined,
      typeof query === 'string' ? query : undefined,
    );
  });
  ipcMain.handle('agent-history:list-sessions', async (
    _event,
    projectId: unknown,
    cursor?: unknown,
    limit?: unknown,
    force?: unknown,
  ) => {
    await agentHistoryReady;
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) {
      return { items: [], nextCursor: null };
    }
    return agentHistoryService.listSessions(
      projectId,
      typeof cursor === 'string' ? cursor : undefined,
      typeof limit === 'number' ? limit : undefined,
      force === true,
    );
  });
  ipcMain.handle('agent-history:read', async (
    _event,
    historyId: unknown,
    cursor?: unknown,
    limit?: unknown,
  ) => {
    await agentHistoryReady;
    if (typeof historyId !== 'string' || historyId.length === 0 || historyId.length > 128) return null;
    return agentHistoryService.readTranscript(
      historyId,
      typeof cursor === 'string' ? cursor : undefined,
      typeof limit === 'number' ? limit : undefined,
    );
  });
  ipcMain.handle('agent-history:prepare-resume', async (_event, historyId: unknown) => {
    await agentHistoryReady;
    if (typeof historyId !== 'string' || historyId.length === 0 || historyId.length > 128) return null;
    return agentHistoryService.prepareResume(historyId);
  });
  ipcMain.handle('agent-history:start-resume', async (
    event,
    request: unknown,
  ): Promise<AgentResumeStartResult> => {
    await agentHistoryReady;
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return { ok: false, reason: 'invalid' };
    }
    const candidate = request as Partial<AgentResumeStartRequest>;
    if (
      typeof candidate.historyId !== 'string'
      || candidate.historyId.length === 0
      || candidate.historyId.length > 128
      || typeof candidate.sessionId !== 'string'
      || candidate.sessionId.length === 0
      || candidate.sessionId.length > 256
      || typeof candidate.runId !== 'string'
      || candidate.runId.length === 0
      || candidate.runId.length > 256
      || typeof candidate.revision !== 'string'
      || candidate.revision.length === 0
      || candidate.revision.length > 128
      || (candidate.rootChoice !== 'recorded' && candidate.rootChoice !== 'current')
    ) {
      return { ok: false, reason: 'invalid' };
    }
    const resolved = await agentHistoryService.resolveResume(
      candidate.historyId,
      candidate.revision,
      candidate.rootChoice,
    );
    if (!resolved.ok) return resolved;
    const session = broker?.listSessions().find((item) => item.sessionId === candidate.sessionId);
    if (!session || !resolved.roots[0]
      || directoryKey(session.cwd) !== directoryKey(resolved.roots[0])) {
      return { ok: false, reason: 'session-mismatch' };
    }
    // The launch line is built by the provider adapter; the provider's session id
    // remains main/interpreter private and renderer frames and shell history
    // receive only the redacted display text.
    const port = broker?.runPrivateCommand(
      candidate.sessionId,
      candidate.runId,
      resolved.commandText,
      resolved.displayCommandText,
    );
    if (!port) return { ok: false, reason: 'unavailable' };
    void agentHistoryService.recordTerminalWork(resolved.roots, Date.now()).catch((err) => {
      console.error('[main] failed to record resumed Agent project:', err);
    });
    event.sender.postMessage('cmd-port', { runId: candidate.runId }, [port as unknown as MessagePortMain]);
    return { ok: true };
  });
  ipcMain.handle('agent-projects:list-launchers', async () => {
    await agentInfrastructureReady;
    return agentHistoryService.listLaunchers();
  });
  const startAgentLaunchInSession = async (
    event: IpcMainInvokeEvent,
    candidate: AgentLaunchStartRequest,
  ): Promise<AgentLaunchStartResult> => {
    let teamContext: ReturnType<AgentTeamService['launchContext']> | null = null;
    if (candidate.teamMember) {
      if (!agentTeamService || candidate.target.kind !== 'project') {
        return { ok: false, reason: 'unavailable' };
      }
      teamContext = agentTeamService.launchContext(
        candidate.teamMember.runId,
        candidate.teamMember.personaId,
      );
      if (!teamContext.ok) {
        return { ok: false, reason: teamContext.error === 'stale' ? 'stale' : 'unavailable' };
      }
      const slot = teamContext.value.run.slots.find(
        (item) => item.personaId === candidate.teamMember!.personaId,
      );
      if (!slot
        || slot.state !== 'prepared'
        || candidate.launcherId !== teamContext.value.persona.launch.provider
        || candidate.target.projectId !== teamContext.value.run.projectId
        || candidate.target.rootId !== slot.rootId
        || candidate.target.workspaceId !== slot.workspaceId) {
        return { ok: false, reason: 'stale' };
      }
    }
    const resolved = await agentHistoryService.resolveLaunch(
      candidate.target,
      candidate.launcherId,
      candidate.revision,
      teamContext?.ok ? teamContext.value.persona.launch : undefined,
    );
    if (!resolved.ok) return resolved;
    const session = broker?.listSessions().find((item) => item.sessionId === candidate.sessionId);
    if (!session || !resolved.roots[0]
      || directoryKey(session.cwd) !== directoryKey(resolved.roots[0])) {
      return { ok: false, reason: 'session-mismatch' };
    }
    let launchingTeamRevision: number | null = null;
    if (candidate.teamMember && teamContext?.ok && agentTeamService) {
      const launching = await agentTeamService.bindMemberCurrent(
        candidate.teamMember.runId,
        candidate.teamMember.personaId,
        'launching',
        { sessionId: candidate.sessionId },
      );
      if (!launching.ok) return { ok: false, reason: 'stale' };
      launchingTeamRevision = launching.value.revision;
    }
    const port = broker?.runPrivateCommand(
      candidate.sessionId,
      candidate.runId,
      resolved.commandText,
      resolved.displayCommandText,
    );
    if (!port) {
      if (candidate.teamMember && launchingTeamRevision && agentTeamService) {
        await agentTeamService.bindMemberCurrent(
          candidate.teamMember.runId,
          candidate.teamMember.personaId,
          'failed',
          { sessionId: candidate.sessionId },
          'The provider process could not be started.',
        );
      }
      return { ok: false, reason: 'unavailable' };
    }
    void agentHistoryService.recordLaunchTargetWork(candidate.target, resolved.roots, Date.now()).catch((err) => {
      console.error('[main] failed to record launched Agent project:', err);
    });
    event.sender.postMessage('cmd-port', { runId: candidate.runId }, [port as unknown as MessagePortMain]);
    return { ok: true };
  };
  ipcMain.handle('agent-launch:prepare', async (
    _event,
    target: unknown,
    launcherId: unknown,
  ) => {
    await Promise.all([agentHistoryReady, agentInfrastructureReady]);
    if (!isAgentLaunchTarget(target) || !isBoundedAgentString(launcherId, 128)) {
      return { ok: false, reason: 'invalid' };
    }
    return agentHistoryService.prepareLaunch(target, launcherId);
  });
  ipcMain.handle('agent-teams:prepare-member-launch', async (_event, input: unknown) => {
    await Promise.all([agentHistoryReady, agentInfrastructureReady, agentTeamReady]);
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !agentTeamService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team member launch.' } as const;
    }
    const candidate = input as Partial<AgentTeamMemberLaunchInput>;
    if (!isBoundedAgentString(candidate.runId, 64)
      || !isBoundedAgentString(candidate.personaId, 64)
      || typeof candidate.expectedRevision !== 'number'
      || !Number.isSafeInteger(candidate.expectedRevision)
      || candidate.expectedRevision < 1
      || !isAgentLaunchTarget(candidate.target)
      || candidate.target.kind !== 'project'
      || !candidate.target.rootId
      || !candidate.target.workspaceId
      || !isAgentTeamMemberBinding(candidate.binding)
      || !candidate.binding.branch
      || !candidate.binding.rootId
      || !candidate.binding.workspaceId
      || !candidate.binding.worktreeId
      || !candidate.binding.worktreePath
      || candidate.binding.sessionId !== undefined
      || candidate.binding.activityId !== undefined
      || candidate.binding.participantId !== undefined
      || candidate.target.rootId !== candidate.binding.rootId
      || candidate.target.workspaceId !== candidate.binding.workspaceId) {
      return { ok: false, error: 'invalid', message: 'A managed worktree target is required.' } as const;
    }
    const target = candidate.target;
    const context = agentTeamService.launchContext(
      candidate.runId,
      candidate.personaId,
      candidate.expectedRevision,
    );
    if (!context.ok) return context;
    if (target.projectId !== context.value.run.projectId) {
      return { ok: false, error: 'conflict', message: 'The worktree belongs to another Project.' } as const;
    }
    const described = await projectWorkspaceService.describeProjectWorkspaces(target.projectId);
    const managedWorkspace = described.ok
      ? described.project.workspaces?.find((workspace) => (
          workspace.workspaceId === target.workspaceId
          && workspace.rootId === target.rootId
          && workspace.kind === 'managed'
          && workspace.access === 'granted'
        ))
      : undefined;
    if (!managedWorkspace
      || managedWorkspace.workspaceId !== candidate.binding.worktreeId
      || (managedWorkspace.branch !== undefined && managedWorkspace.branch !== candidate.binding.branch)) {
      return { ok: false, error: 'conflict', message: 'The Team member requires the exact managed worktree.' } as const;
    }
    const canonicalBinding: AgentTeamMemberBinding = {
      branch: managedWorkspace.branch ?? candidate.binding.branch,
      rootId: managedWorkspace.rootId,
      workspaceId: managedWorkspace.workspaceId,
      worktreeId: managedWorkspace.workspaceId,
      worktreePath: managedWorkspace.displayPath,
    };
    const slot = context.value.run.slots.find((item) => item.personaId === candidate.personaId);
    if (!slot || !['planned', 'failed', 'prepared'].includes(slot.state)) {
      return { ok: false, error: 'conflict', message: 'This Team member is not ready to prepare.' } as const;
    }
    const preparation = await agentHistoryService.prepareLaunch(
      target,
      context.value.persona.launch.provider,
      context.value.persona.launch,
    );
    if (!preparation.ok) {
      return {
        ok: false,
        error: preparation.reason === 'invalid' ? 'invalid' : 'unavailable',
        message: `Unable to prepare ${context.value.persona.name}.`,
      } as const;
    }
    if (directoryKey(preparation.cwd) !== directoryKey(managedWorkspace.displayPath)) {
      return { ok: false, error: 'conflict', message: 'The prepared Agent path does not match the managed worktree.' } as const;
    }
    const bound = await agentTeamService.bindMemberCurrent(
      candidate.runId,
      candidate.personaId,
      'prepared',
      canonicalBinding,
    );
    return bound.ok
      ? { ok: true, value: { run: bound.value, preparation } } as const
      : bound;
  });
  ipcMain.handle('agent-teams:activate-member', async (_event, input: unknown) => {
    await Promise.all([agentInfrastructureReady, agentTeamReady]);
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || !agentTeamService || !agentActivityService || !agentCoordinationService) {
      return { ok: false, error: 'invalid', message: 'Invalid Team member activation.' } as const;
    }
    const candidate = input as Partial<AgentTeamMemberActivationInput>;
    if (!isBoundedAgentString(candidate.runId, 64)
      || !isBoundedAgentString(candidate.personaId, 64)
      || !isBoundedAgentString(candidate.sessionId, 256)) {
      return { ok: false, error: 'invalid', message: 'Invalid Team member activation.' } as const;
    }
    let context = agentTeamService.launchContext(candidate.runId, candidate.personaId);
    if (!context.ok) return context;
    let slot = context.value.run.slots.find((item) => item.personaId === candidate.personaId);
    if (slot?.state === 'failed' && slot.sessionId === candidate.sessionId) {
      const rebound = await agentTeamService.bindMemberCurrent(
        candidate.runId,
        candidate.personaId,
        'launching',
        { sessionId: candidate.sessionId },
      );
      if (!rebound.ok) return rebound;
      context = agentTeamService.launchContext(candidate.runId, candidate.personaId);
      if (!context.ok) return context;
      slot = context.value.run.slots.find((item) => item.personaId === candidate.personaId);
    }
    if (!slot || slot.state !== 'launching' || slot.sessionId !== candidate.sessionId) {
      return { ok: false, error: 'conflict', message: 'This terminal is not the prepared Team member.' } as const;
    }
    const activities = agentActivityService.getSnapshot().items.filter((activity) => (
      activity.live
      && activity.sessionId === candidate.sessionId
      && activity.provider === context.value.persona.launch.provider
    ));
    if (activities.length === 0) {
      return { ok: false, error: 'unavailable', message: 'Waiting for the Agent integration to observe this session.' } as const;
    }
    if (activities.length > 1) {
      const message = 'More than one live Agent was observed in the prepared Team session.';
      await agentTeamService.bindMemberCurrent(
        candidate.runId,
        candidate.personaId,
        'failed',
        { sessionId: candidate.sessionId },
        message,
      );
      return { ok: false, error: 'conflict', message } as const;
    }
    const activity = activities[0]!;
    const joined = await agentCoordinationService.join({
      activityId: activity.id,
      alias: context.value.persona.name,
      role: context.value.persona.role,
      task: context.value.task,
      expectedProjectRevision: context.value.run.validationConfigRevision,
    });
    if (!joined.ok) {
      await agentTeamService.bindMemberCurrent(
        candidate.runId,
        candidate.personaId,
        'failed',
        { sessionId: candidate.sessionId },
        joined.message,
      );
      return joined;
    }
    if (joined.value.participant.projectId !== context.value.run.projectId
      || joined.value.participant.rootId !== slot.rootId
      || joined.value.participant.workspaceId !== slot.workspaceId) {
      agentCoordinationService.leave(activity.id);
      const message = 'The observed Agent started outside its prepared worktree.';
      await agentTeamService.bindMemberCurrent(
        candidate.runId,
        candidate.personaId,
        'failed',
        { sessionId: candidate.sessionId },
        message,
      );
      return { ok: false, error: 'conflict', message } as const;
    }
    const bound = await agentTeamService.bindMemberCurrent(
      candidate.runId,
      candidate.personaId,
      'active',
      {
        sessionId: candidate.sessionId,
        activityId: activity.id,
        participantId: joined.value.participant.participantId,
      },
    );
    if (!bound.ok) {
      agentCoordinationService.leave(activity.id);
      return bound;
    }
    const brief = !bound.value.approvedAt && candidate.personaId === bound.value.plannerPersonaId
      ? composeAgentTeamPlanningBrief(bound.value)
      : context.value.brief;
    return { ok: true, value: { run: bound.value, brief } } as const;
  });
  ipcMain.handle('agent-launch:start', async (
    event,
    request: unknown,
  ): Promise<AgentLaunchStartResult> => {
    await Promise.all([agentHistoryReady, agentInfrastructureReady]);
    return isAgentLaunchStartRequest(request)
      ? startAgentLaunchInSession(event, request)
      : { ok: false, reason: 'invalid' };
  });
  ipcMain.handle('agent-projects:prepare-launch', async (
    _event,
    projectId: unknown,
    launcherId: unknown,
  ) => {
    await Promise.all([agentHistoryReady, agentInfrastructureReady]);
    if (
      typeof projectId !== 'string'
      || projectId.length === 0
      || projectId.length > 128
      || typeof launcherId !== 'string'
      || launcherId.length === 0
      || launcherId.length > 128
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return agentHistoryService.prepareProjectLaunch(projectId, launcherId);
  });
  ipcMain.handle('agent-projects:start-launch', async (
    event,
    request: unknown,
  ): Promise<AgentProjectLaunchStartResult> => {
    await Promise.all([agentHistoryReady, agentInfrastructureReady]);
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return { ok: false, reason: 'invalid' };
    }
    const candidate = request as Partial<AgentProjectLaunchStartRequest>;
    if (
      typeof candidate.projectId !== 'string'
      || candidate.projectId.length === 0
      || candidate.projectId.length > 128
      || typeof candidate.launcherId !== 'string'
      || candidate.launcherId.length === 0
      || candidate.launcherId.length > 128
      || typeof candidate.sessionId !== 'string'
      || candidate.sessionId.length === 0
      || candidate.sessionId.length > 256
      || typeof candidate.runId !== 'string'
      || candidate.runId.length === 0
      || candidate.runId.length > 256
      || typeof candidate.revision !== 'string'
      || candidate.revision.length === 0
      || candidate.revision.length > 128
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return startAgentLaunchInSession(event, {
      target: { kind: 'project', projectId: candidate.projectId },
      launcherId: candidate.launcherId,
      sessionId: candidate.sessionId,
      runId: candidate.runId,
      revision: candidate.revision,
    });
  });
  ipcMain.handle('agent-projects:save', async (_event, input: unknown) => {
    await agentHistoryReady;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, reason: 'invalid' };
    }
    return agentHistoryService.saveProject(input as AgentProjectInput);
  });
  ipcMain.handle('agent-projects:remove', async (_event, projectId: unknown) => {
    await agentHistoryReady;
    if (typeof projectId !== 'string' || projectId.length > 128) return false;
    const removed = await agentHistoryService.removeProject(projectId);
    if (removed) {
      await Promise.all([
        projectWorkspaceService.revokeProjectAccess(projectId),
        agentTeamService?.removeProject(projectId),
      ]);
    }
    return removed;
  });
  ipcMain.handle('agent-projects:select-folders', async (event, multiple?: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Select project folders',
      properties: ['openDirectory', ...(multiple === false ? [] : ['multiSelections' as const])],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, paths: result.canceled ? [] : result.filePaths };
  });
  ipcMain.handle('renderer-recovery:save-checkpoint', (event, checkpoint: unknown) => (
    rendererRecoveryCheckpoints.save(event.sender.id, checkpoint)
  ));
  ipcMain.handle('renderer-recovery:consume-checkpoint', (event) => (
    rendererRecoveryCheckpoints.consume(event.sender.id)
  ));
  ipcMain.handle('renderer-recovery:prepare', (event) => {
    prepareDesktopRendererRecovery(event.sender.id);
  });
  ipcMain.handle('project-workspace:describe', async (_event, projectId: unknown) => {
    await projectWorkspaceReady;
    return projectWorkspaceService.describeProjectWorkspaces(projectId);
  });
  ipcMain.handle('project-documents:resolve', async (_event, request: unknown) => {
    await projectWorkspaceReady;
    return projectDocumentService.resolveTarget(request);
  });
  ipcMain.handle('project-documents:list-directory', async (_event, request: unknown) => {
    await projectWorkspaceReady;
    return projectDocumentService.listDirectory(request);
  });
  ipcMain.handle('project-documents:read', async (_event, request: unknown) => {
    await projectWorkspaceReady;
    return projectDocumentService.readDocument(request);
  });
  ipcMain.handle('project-workspace:search', async (event, request: unknown) => {
    await projectWorkspaceReady;
    const requestId = typeof request === 'object' && request !== null && !Array.isArray(request)
      ? (request as { readonly requestId?: unknown }).requestId
      : undefined;
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) {
      return projectWorkspaceService.search(request);
    }
    const key = `${String(event.sender.id)}:${requestId}`;
    projectWorkspaceSearches.get(key)?.abort();
    const controller = new AbortController();
    projectWorkspaceSearches.set(key, controller);
    try {
      return await projectWorkspaceService.search(request, controller.signal);
    } finally {
      if (projectWorkspaceSearches.get(key) === controller) projectWorkspaceSearches.delete(key);
    }
  });
  ipcMain.on('project-workspace:cancel-search', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
    const key = `${String(event.sender.id)}:${requestId}`;
    projectWorkspaceSearches.get(key)?.abort();
    projectWorkspaceSearches.delete(key);
  });
  ipcMain.handle('project-workspace:approve', async (_event, request: unknown) => {
    await projectWorkspaceReady;
    return projectWorkspaceService.approveWorkspace(request);
  });
  ipcMain.handle('project-workspace:revoke', async (_event, request: unknown) => {
    await projectWorkspaceReady;
    return projectWorkspaceService.revokeWorkspace(request);
  });
  ipcMain.handle('project-map:describe', async (_event, request: unknown) => {
    if (!isProjectMapCollectionRequest(request)) {
      return {
        ok: false,
        error: 'invalid-request',
        collection: {
          projectId: '',
          state: 'invalid',
          roots: [],
          bindings: [],
          maps: [],
          diagnostics: [{
            severity: 'error',
            code: 'request.invalid',
            subject: '$',
            message: 'Invalid Project Map collection request.',
          }],
        },
      };
    }
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.describe(request);
  });
  ipcMain.handle('project-map:set-bindings', async (_event, request: unknown) => {
    if (!isProjectMapBindingRequest(request)) {
      return {
        ok: false,
        error: 'invalid-request',
        collection: {
          projectId: '',
          state: 'binding-required',
          roots: [],
          bindings: [],
          maps: [],
          diagnostics: [{
            severity: 'error',
            code: 'request.invalid',
            subject: '$',
            message: 'Invalid Project Map root binding request.',
          }],
        },
      };
    }
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.setBindings(request);
  });
  const readProjectMap = async (request: unknown) => {
    if (!isProjectMapReadRequest(request)) {
      return {
        ok: false,
        error: 'invalid-request',
        state: 'invalid',
        diagnostics: [{
          severity: 'error',
          code: 'request.invalid',
          subject: '$',
          message: 'Invalid Project Map read request.',
        }],
      };
    }
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.read(request);
  };
  ipcMain.handle('project-map:read', (_event, request: unknown) => readProjectMap(request));
  ipcMain.handle('project-map:refresh', (_event, request: unknown) => readProjectMap(request));
  const invalidProjectMapOpen = () => ({
    ok: false as const,
    error: 'invalid-request',
    snapshot: {
      collection: {
        projectId: '',
        state: 'invalid' as const,
        roots: [],
        bindings: [],
        maps: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'request.invalid',
          subject: '$',
          message: 'Invalid Project Map request.',
        }],
      },
      freshness: 'verified' as const,
      verificationPending: false,
    },
  });
  ipcMain.handle('project-map:open', async (_event, request: unknown) => {
    if (!isProjectMapReadRequest(request)) return invalidProjectMapOpen();
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.open(request);
  });
  ipcMain.handle('project-map:refresh-v2', async (_event, request: unknown) => {
    if (!isProjectMapReadRequest(request)) return invalidProjectMapOpen();
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.open(request, true);
  });
  ipcMain.handle('project-map:approve', async (_event, request: unknown) => {
    if (!isProjectMapApprovalRequest(request)) return invalidProjectMapOpen();
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    return projectMapService.approve(request);
  });
  ipcMain.handle('project-map:start-job', async (_event, request: unknown) => {
    if (!isProjectMapStartJobRequest(request)) return { ok: false, error: 'invalid-request' };
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    try {
      return { ok: true, job: await projectMapService.startJob(request) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'job-start-failed' };
    }
  });
  ipcMain.handle('project-map:cancel-job', async (_event, request: unknown) => {
    if (!isProjectMapJobRequest(request)) return { ok: false, error: 'invalid-request' };
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    const job = await projectMapService.cancelJob(request);
    return job ? { ok: true, job } : { ok: false, error: 'job-not-found' };
  });
  ipcMain.handle('project-map:select-export-directory', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef ?? undefined;
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0]
      ? { ok: false as const, error: 'canceled' }
      : { ok: true as const, directory: result.filePaths[0] };
  });
  ipcMain.handle('project-map:export', async (_event, request: unknown) => {
    if (!isProjectMapExportRequest(request) || !request.mapId) {
      return { ok: false, error: 'invalid-request' };
    }
    await Promise.all([projectWorkspaceReady, projectMapReady]);
    const document = await projectMapService.approvedDocument(request);
    if (!document) return { ok: false, error: 'approved-map-not-found' };
    return exportProjectMap(request, document, nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });
  ipcMain.handle('agents:followup', (_event, activityId: string, text: string) => {
    if (typeof activityId !== 'string' || typeof text !== 'string') return { ok: false, error: 'invalid-text' };
    return agentActivityService?.sendPrompt(activityId, text) ?? { ok: false, error: 'delivery-failed' };
  });
  ipcMain.handle('pairing:issue', () => {
    if (!desktopRuntime?.isRunning()) {
      pairingCodeService.revoke();
      throw new Error('Remote pairing is unavailable while the trusted listener is stopped.');
    }
    return pairingCodeService.issue();
  });
  ipcMain.handle('pairing:get', () => pairingCodeService.current());
  ipcMain.handle('pairing:revoke', () => { pairingCodeService.revoke(); });
  ipcMain.handle('git:status', (_event, directory: string) => gitStatusService.getStatus(directory));
  ipcMain.handle('git:diff', (_event, directory: string) => gitStatusService.getDiff(directory));
  ipcMain.handle('agents:decide', (
    _event,
    activityId: unknown,
    approvalId: unknown,
    decision: unknown,
  ): AgentDecisionResult => {
    if (
      typeof activityId !== 'string'
      || activityId.length < 1
      || activityId.length > 128
      || typeof approvalId !== 'string'
      || approvalId.length < 1
      || approvalId.length > 128
      || (decision !== 'allow' && decision !== 'deny')
    ) {
      return { ok: false, error: 'not-found' };
    }
    return agentActivityService?.decideApproval(activityId, approvalId, decision)
      ?? { ok: false, error: 'not-found' };
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
    const result = await agentHookInstaller.mutate(provider, enabled);
    await refreshAgentTeamCapabilities();
    return result;
  });
  ipcMain.handle('agents:get-settings', async () => {
    await agentInfrastructureReady;
    return agentSettingsStore.get();
  });
  ipcMain.handle('agents:set-settings', async (_event, settings: unknown) => {
    await agentInfrastructureReady;
    const saved = await agentSettingsStore.set(settings);
    if (saved) agentActivityService?.applySettings(saved);
    return saved;
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
  // The first quit is held while every owned service drains exactly once;
  // completion or a bounded timeout reissues app.quit().
  const gracefulShutdown = new GracefulShutdownCoordinator({
    timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    continueQuit: () => app.quit(),
    reportError: (context, error) => {
      console.error(`[main] ${context}:`, error);
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      mainLog?.line(`${context}: ${detail}`);
    },
    tasks: [
      {
        name: 'quit state',
        run: async () => {
          appIsQuitting = true;
          await processGuardian?.armRootDeadline(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        },
      },
      {
        name: 'run command IPC',
        run: () => {
          uninstallRunCommandIpc?.();
          uninstallRunCommandIpc = null;
        },
      },
      {
        name: 'terminal runtime',
        run: async () => {
          const terminatingGroupId = interpreterGroupId;
          try {
            await broker?.shutdown(2_800);
          } catch (error) {
            console.error('[main] interpreter graceful drain failed:', error);
          }
          if (terminatingGroupId && processGuardian) {
            await processGuardian.terminateGroup(terminatingGroupId);
          } else {
            try {
              interpreter?.kill();
            } catch {
              // The interpreter already exited.
            }
          }
          await scriptHostRegistry?.killAll();
        },
      },
      {
        name: 'session surface authority',
        run: () => {
          sessionSurfaceAuthority?.dispose();
          sessionSurfaceAuthority = null;
          desktopSessionPrincipalByWebContentsId.clear();
        },
      },
      {
        name: 'renderer layout and layout store',
        run: async () => {
          await desktopWindowManager?.requestLayoutFlush();
          await layoutStore.flush();
        },
      },
      { name: 'system stats', run: () => systemStatsService?.stop() },
      { name: 'packet capture', run: () => packetCaptureRegistry?.kill() },
      {
        name: 'desktop runtime and file uploads',
        run: async () => {
          const runtime = desktopRuntime;
          desktopRuntime = null;
          try {
            await runtime?.dispose();
          } finally {
            // Stop the bridge first so no remote begin can race the service
            // drain. FileService then closes/unlinks every active or late
            // pending `.ezpart` before the quit gate is released.
            await fileService.dispose();
          }
        },
      },
      { name: 'OpenClaw endpoint subscription', run: () => unsubscribeOpenClawEndpoint() },
      { name: 'OpenClaw lifecycle coordinator', run: () => openClawLifecycleCoordinator?.dispose() },
      { name: 'OpenClaw service', run: () => openClawService?.dispose() },
      { name: 'OpenClaw chat view', run: () => openClawChatView?.destroy() },
      { name: 'agent control server', run: () => agentControlServer?.stop() },
      { name: 'managed merge', run: () => managedMergeService?.dispose() },
      { name: 'agent Teams', run: () => agentTeamService?.dispose() },
      { name: 'agent coordination', run: () => agentCoordinationService?.dispose() },
      { name: 'agent activity', run: () => agentActivityService?.dispose() },
      { name: 'agent history', run: () => agentHistoryService.dispose() },
      { name: 'agent coordination store', run: () => agentCoordinationStore.flush() },
      { name: 'agent Team store', run: () => agentTeamStore.flush() },
      { name: 'agent settings', run: () => agentSettingsStore.flush() },
      { name: 'project workspace access', run: () => projectWorkspaceAccessStore.flush() },
      {
        name: 'project maps',
        run: async () => {
          projectMapService.close();
          await Promise.all([
            projectMapBindingStore.flush(),
            projectMapCacheStore.flush(),
            projectMapApprovalStore.flush(),
            projectMapJobStore.flush(),
          ]);
        },
      },
      { name: 'quick commands', run: () => quickCommandStore.flush() },
      { name: 'app update', run: () => appUpdateService.dispose() },
      { name: 'workspace search', run: () => workspaceFileSearch.dispose() },
      {
        name: 'project workspace search',
        run: () => {
          for (const controller of projectWorkspaceSearches.values()) controller.abort();
          projectWorkspaceSearches.clear();
        },
      },
      {
        name: 'SSH forwards',
        run: () => {
          const service = sshForwardService;
          sshForwardService = null;
          return service?.dispose();
        },
      },
      { name: 'agent hook relay', run: () => agentHookRelay.stop() },
      {
        name: 'OpenClaw visibility timer',
        run: () => clearInterval(openclawVisibilityRecheckTimer),
      },
    ],
  });
  app.on('before-quit', (event) => gracefulShutdown.handleBeforeQuit(event));

  // Session surfaces are the only renderer-facing session lifecycle API. Main
  // derives the principal from the exact WebContents + preload generation; a
  // renderer can never present another client's host-issued binding capability.
  ipcMain.handle(
    'session-surface:open',
    (
      event,
      clientInstanceId: unknown,
      surfaceId: unknown,
      intent: unknown,
    ) => {
      const principalId = resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId || !isSessionSurfaceId(surfaceId) || !isSessionSurfaceIntent(intent)) {
        return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
      }
      return sessionSurfaceAuthority!.openSessionSurface(principalId, surfaceId, intent);
    },
  );
  ipcMain.handle(
    'session-surface:prepare-close',
    (event, clientInstanceId: unknown, entries: unknown) => {
      const principalId = resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId || !isSessionSurfaceCloseEntries(entries)) {
        return { ok: false as const, reason: 'state-changed' as const };
      }
      return sessionSurfaceAuthority!.prepareSessionSurfaceClose(principalId, entries);
    },
  );
  ipcMain.handle(
    'session-surface:commit-close',
    (
      event,
      clientInstanceId: unknown,
      closeToken: unknown,
      decisions: unknown,
    ) => {
      const principalId = resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (
        !principalId
        || !isSessionSurfaceId(closeToken)
        || !isSessionSurfaceCloseDecisions(decisions)
      ) {
        return Promise.resolve({ ok: false as const, reason: 'state-changed' as const });
      }
      return sessionSurfaceAuthority!.commitSessionSurfaceClose(
        principalId,
        closeToken,
        decisions,
      );
    },
  );
  ipcMain.handle(
    'session-surface:release',
    (event, clientInstanceId: unknown, bindingId: unknown) => {
      const principalId = resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId || !isSessionSurfaceId(bindingId)) {
        return { ok: false as const, reason: 'state-changed' as const };
      }
      return sessionSurfaceAuthority!.releaseSessionSurface(principalId, bindingId);
    },
  );
  ipcMain.handle(
    'session-surface:terminate',
    (
      event,
      clientInstanceId: unknown,
      sessionId: unknown,
      expectedActiveRunIds: unknown,
    ) => {
      const principalId = resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (
        !principalId
        || !isSessionSurfaceId(sessionId)
        || !Array.isArray(expectedActiveRunIds)
        || expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
        || expectedActiveRunIds.some((runId) => !isSessionSurfaceId(runId))
      ) {
        return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
      }
      return sessionSurfaceAuthority!.terminateSessionGuarded(
        sessionId,
        expectedActiveRunIds,
      );
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
      if (!details.url.startsWith(`${APP_RENDERER_ORIGIN}/`)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }

  // Spawn the interpreter as a utilityProcess (`docs/architecture.md`).
  // utilityProcess keeps interpreter work off the main thread and enables
  // MessagePortMain-based streaming without freezing the UI.
  // Output resolves to .vite/build/interpreter-process.js (same dir as main.js).
  const interpreterPath = path.join(__dirname, 'interpreter-process.js');
  const waitForUtilityProcessSpawn = (target: UtilityProcess): Promise<number> => {
    if (target.pid !== undefined) return Promise.resolve(target.pid);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        target.off('spawn', onSpawn);
        target.off('exit', onExit);
      };
      const onSpawn = (): void => {
        cleanup();
        if (target.pid === undefined) reject(new Error('interpreter spawned without a pid'));
        else resolve(target.pid);
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error('interpreter exited before guardian ownership was established'));
      };
      target.once('spawn', onSpawn);
      target.once('exit', onExit);
    });
  };
  const spawnInterpreterProcess = async (): Promise<UtilityProcess> => {
    console.log(`[main] spawning interpreter at: ${interpreterPath}`);
    const target = utilityProcess.fork(interpreterPath, [], {
      serviceName: 'EZTerminal Interpreter',
      stdio: 'inherit',
    });
    const pid = await waitForUtilityProcessSpawn(target);
    const nextGroupId = `interpreter:${randomUUID()}`;
    try {
      await processGuardian?.createGroup(nextGroupId, pid);
    } catch (error) {
      try {
        target.kill();
      } catch {
        // The worker exited while ownership registration failed.
      }
      throw error;
    }
    interpreterGroupId = processGuardian ? nextGroupId : null;
    return target;
  };

  try {
    interpreter = await spawnInterpreterProcess();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[main] interpreter ownership setup failed:', error);
    dialog.showErrorBox(
      'EZTerminal startup failed',
      `The terminal interpreter could not be placed under process ownership.\n\n${detail}`,
    );
    app.exit(1);
    return;
  }

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
      const environment: Record<string, string> = {
        EZTERMINAL_SESSION_ID: sessionId,
      };
      if (agentRelayReady) {
        environment.EZTERMINAL_AGENT_HOOK_DESCRIPTOR = agentHookRelay.environmentDescriptor;
      }
      if (agentControlServer) {
        const descriptor = agentControlServer.descriptorForSession(sessionId);
        if (descriptor) {
          environment.EZTERMINAL_AGENT_CONTROL_DESCRIPTOR = descriptor;
          environment.PATH = agentCliShim.prependToPath(process.env.PATH);
        }
      }
      return environment;
    },
  });
  sessionSurfaceAuthority = new SessionSurfaceAuthority(broker, {
    resolveProjectTarget: async (target) => {
      await projectWorkspaceReady;
      return projectWorkspaceService.resolveSessionTarget(target);
    },
  });
  console.log('[main] interpreter broker ready');
  uninstallRunCommandIpc = installRunCommandIpc({
    ipc: ipcMain,
    getBroker: () => broker,
  });

  const bindSshForwardService = (target: UtilityProcess): void => {
    sshForwardService = new SshForwardService({
      interpreter: target as unknown as BrokerInterpreter,
      createMessageChannel: () => new MessageChannelMain(),
      onInterpreterExited: (listener) => broker?.onInterpreterExited(listener) ?? (() => undefined),
    });
  };
  bindSshForwardService(interpreter);
  console.log('[main] SSH forwarding service ready');

  const broadcast = (channel: string, payload?: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  };
  pairingCodeService.onChange((code) => broadcast('pairing:changed', code));

  agentActivityService = new AgentActivityService({
    broker,
    getSettings: () => agentSettingsStore.current,
  });
  await Promise.all([
    agentCoordinationReady,
    agentTeamReady,
    agentCliReady,
    projectWorkspaceReady,
    refreshAgentTeamCapabilities(),
  ]);
  agentCoordinationService = new AgentCoordinationService({
    activities: agentActivityService,
    store: agentCoordinationStore,
    listProjects: () => agentProjectStore.list(),
    resolveWorkspace: async (activity) => {
      const resolved = await projectWorkspaceService.resolveAbsoluteProjectPath({
        absolutePath: activity.cwd,
      });
      if (!resolved.ok) return null;
      const described = await projectWorkspaceService.describeProjectWorkspaces(
        resolved.request.projectId,
      );
      if (!described.ok) return null;
      const workspace = described.project.workspaces?.find(
        (candidate) => candidate.workspaceId === resolved.request.workspaceId,
      );
      if (!workspace) return null;
      return {
        projectId: resolved.request.projectId,
        rootId: workspace.rootId,
        workspaceId: workspace.workspaceId,
        ...(workspace.kind === 'managed' ? { worktreeId: workspace.workspaceId } : {}),
      };
    },
  });
  agentTeamService = new AgentTeamService({
    store: agentTeamStore,
    listProjects: () => agentProjectStore.list(),
    getCoordinationProject: (projectId) => agentCoordinationService?.getProject(projectId) ?? null,
    capabilities: () => agentTeamCapabilities,
    isActivityLive: (activityId) => agentActivityService?.getSnapshot().items.some(
      (activity) => activity.id === activityId && activity.live,
    ) === true,
    inspectBase: async (project, targetBranch) => {
      const status = await gitStatusService.getStatus(project.primaryRoot);
      if (status.availability !== 'ready') return null;
      try {
        const head = (await agentTeamGitRunner.run(project.primaryRoot, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${targetBranch}^{commit}`,
        ])).trim();
        return /^[0-9a-f]{40,64}$/iu.test(head)
          ? { head, dirty: status.changes.length > 0 }
          : null;
      } catch {
        return null;
      }
    },
  });
  const validationRunner = new AgentValidationRunner(broker);
  managedMergeService = new ManagedMergeService({
    userDataDir: app.getPath('userData'),
    coordination: agentCoordinationService,
    coordinationStore: agentCoordinationStore,
    worktrees: worktreeService,
    validationRunner,
    runGuard: sessionWorktreeRunGuard,
    projectRoot: (projectId) => (
      agentProjectStore.list().find((project) => project.projectId === projectId)?.primaryRoot ?? null
    ),
    hasActiveRunInPath: async (targetPath) => {
      const [runs, sessions] = await Promise.all([broker!.listRuns(), Promise.resolve(broker!.listSessions())]);
      const activeSessions = new Set(runs.map((run) => run.sessionId));
      const targetKey = process.platform === 'win32'
        ? path.resolve(targetPath).toLocaleLowerCase('en-US')
        : path.resolve(targetPath);
      return sessions.some((session) => {
        if (!activeSessions.has(session.sessionId)) return false;
        const cwdKey = process.platform === 'win32'
          ? path.resolve(session.cwd).toLocaleLowerCase('en-US')
          : path.resolve(session.cwd);
        const relative = path.relative(targetKey, cwdKey);
        return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
      });
    },
  });
  try {
    await Promise.all([managedMergeService.init(), projectMapReady]);
    agentCoordinationService.bindMergeSource(managedMergeService);
    agentControlServer = new AgentControlServer({
      coordination: agentCoordinationService,
      merges: managedMergeService,
      maps: projectMapService,
      teams: agentTeamService,
    });
    await agentControlServer.start();
    await refreshAgentTeamCapabilities();
    for (const session of broker.listSessions()) {
      broker.setPrivateSessionEnvironment(session.sessionId, {
        EZTERMINAL_AGENT_CONTROL_DESCRIPTOR: agentControlServer.descriptorForSession(session.sessionId),
        PATH: agentCliShim.prependToPath(process.env.PATH),
      });
    }
  } catch (err) {
    console.error('[main] Agent collaboration infrastructure init failed:', err);
    await agentControlServer?.stop().catch(() => undefined);
    agentControlServer = null;
  }
  broker.onSessionRemoved((sessionId) => agentControlServer?.revokeSession(sessionId));
  agentCoordinationService.onSnapshot((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('agents:coordination-snapshot', snapshot);
    }
  });
  const broadcastAgentTeamSnapshot = (snapshot: AgentTeamDesktopSnapshot): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('agent-teams:snapshot', snapshot);
    }
  };
  agentTeamService.onSnapshot(broadcastAgentTeamSnapshot);
  broadcastAgentTeamSnapshot(agentTeamService.getSnapshot());
  agentActivityService.onObserved((activity) => {
    // Every provider EZTerminal has local history for — generic profiles have no
    // adapter and so no sessions to come back to.
    if (!isAgentIntegrationProvider(activity.provider) || !activity.cwd) return;
    void projectWorkspaceReady
      .then(async () => {
        const registered = await projectWorkspaceService.resolveAbsoluteProjectPath({
          absolutePath: activity.cwd,
        });
        if (registered.ok) {
          await agentHistoryService.recordObservedProjectWork(
            registered.request.projectId,
            activity.updatedAt,
          );
          return;
        }
        await agentHistoryService.recordTerminalWork([activity.cwd], activity.updatedAt);
      })
      .catch((err) => {
        console.error('[main] failed to record terminal Agent project:', err);
      });
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
    if (activity.state !== 'done' && activity.state !== 'blocked' && activity.state !== 'error') return;
    const notificationSetting = activity.state === 'done' ? 'waiting' : activity.state;
    if (!agentSettingsStore.current.notifications[notificationSetting]) return;
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    if (windows.some((win) => win.isFocused()) || !Notification.isSupported()) return;
    const notification = new Notification({
      title: `${activity.provider} agent ${activity.state === 'done' ? 'ready' : activity.state}`,
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
  const activeScriptHostRegistry = new ScriptHostRegistry(
    path.join(__dirname, 'script-host.js'),
    processGuardian ?? undefined,
    () => interpreterGroupId,
  );
  scriptHostRegistry = activeScriptHostRegistry;

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
      void (async () => {
        if (appIsQuitting) return;
        let next: UtilityProcess | null = null;
        try {
          next = await spawnInterpreterProcess();
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
      })();
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
        void activeScriptHostRegistry.spawn(msg.hostId, msg.scriptPath, msg.args, msg.cwd, (hostId, code) => {
          postToInterpreterGeneration(target, { type: 'script-host-exit', hostId, code });
        }).then((result) => {
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
        });
      } else if (msg?.type === 'kill-script-host') {
        void activeScriptHostRegistry.kill(msg.hostId);
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
      interpreterGroupId = null;
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
      void activeScriptHostRegistry.killAll();
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
  const openclawControl = process.platform === 'win32'
    && process.env.EZTERMINAL_DISABLE_OPENCLAW_SUPERVISOR !== '1'
    ? new OpenClawLifecycleCoordinator({
        userDataDirectory: app.getPath('userData'),
        supervisorAssetPath: app.isPackaged
          ? path.join(process.resourcesPath, 'openclaw-supervisor.ps1')
          : path.join(app.getAppPath(), 'assets', 'openclaw-supervisor.ps1'),
        getPhysicalStatus: (force) => openclaw.getStatus(force),
      })
    : null;
  openClawLifecycleCoordinator = openclawControl;
  await openclawControl?.initialize();

  const transientControlSnapshot = async (force = false): Promise<OpenClawControlSnapshot> => {
    const status = await openclaw.getStatus(force);
    return {
      schemaVersion: 1,
      intentId: null,
      generation: 0,
      status,
      desiredState: status.state === 'running' || status.state === 'starting' ? 'running' : 'stopped',
      supervisorState: 'unregistered',
      operation: null,
      issue: null,
      updatedAt: new Date().toISOString(),
    };
  };
  const getOpenClawControl = (force = false): Promise<OpenClawControlSnapshot> => (
    openclawControl?.getSnapshot(force) ?? transientControlSnapshot(force)
  );
  const requestOpenClawLifecycle = async (
    action: OpenClawLifecycleAction,
  ): Promise<OpenClawLifecycleReceipt> => {
    if (openclawControl) return openclawControl.requestLifecycle(action);
    const result = await openclaw.runLifecycle(action);
    return result.ok
      ? { accepted: true }
      : {
          accepted: false,
          issue: {
            code: result.code === 'unhealthy' ? 'gateway-unhealthy' : 'supervisor-failed',
            detail: result.stderr || 'OpenClaw did not accept the lifecycle request.',
            remediation: 'Inspect the OpenClaw CLI output and retry the requested action.',
            diagnosticId: `transient-${Date.now().toString(36)}`,
          },
        };
  };
  const subscribeOpenClawControl = (
    listener: (snapshot: OpenClawControlSnapshot) => void,
  ): (() => void) => {
    if (openclawControl) return openclawControl.subscribe(listener);
    return openclaw.subscribeStatus((status) => {
      listener({
        schemaVersion: 1,
        intentId: null,
        generation: 0,
        status,
        desiredState: status.state === 'running' || status.state === 'starting' ? 'running' : 'stopped',
        supervisorState: 'unregistered',
        operation: null,
        issue: null,
        updatedAt: new Date().toISOString(),
      });
    });
  };

  // ── OpenClaw chat WebContentsView (openclaw-management M3) ────────────────
  // See openclaw-chat-view.ts's module doc for the config verified live in
  // the M0 spike. Attached to the window in createWindow(); state pushes
  // (did-fail-load/did-finish-load) fan out to every window below.
  openClawChatView = new OpenClawChatViewManager({
    getChatUrl: () => openclaw.getChatUrl(),
    openExternal: openExternalForUser,
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
    subscribeControl: subscribeOpenClawControl,
    runLifecycle: requestOpenClawLifecycle,
    subscribeLogs: (listener) => openclaw.subscribeLogs(listener),
    listAgentSessions: () => openclaw.listAgentSessions(),
    getCoreConfig: () => openclaw.getCoreConfig(),
    setCoreConfig: (key, value) => openclaw.setCoreConfig(key, value),
    mintChatTicket: async () => {
      if (!desktopRuntime?.isRunning()) {
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
      if (!proxy || !desktopRuntime?.isRunning()) {
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
  const deviceRoster = new RemoteDeviceRoster();
  ipcMain.handle('remote:list-devices', () => deviceRoster.list());

  const runtime = createElectronDesktopRuntime({
    deviceRoster,
    requestQuit: requestExplicitQuit,
    revokePairingCodes: () => pairingCodeService.revoke(),
    readDesiredEnabled: async () => {
      await storeReady;
      return layoutStore.getRemoteEnabled();
    },
    writeDesiredEnabled: async (enabled) => {
      await storeReady;
      await layoutStore.setRemoteEnabled(enabled);
    },
    waitUntilBridgeReady: async () => {
      await agentInfrastructureReady;
    },
    prepareBridge: async () => {
      // Keep the presentation hint current before auth; it no longer gates
      // any authenticated OpenClaw request.
      currentOpenClawVisible = await resolveOpenClawVisibility(
        await layoutStore.getOpenClawMode(),
        () => openclaw.isInstalled(),
      );
    },
    stopAuxiliaryRuntime: stopOpenClawProxy,
    bridgeSources: {
      broker: broker!,
      sessionSurfaceAuthority: sessionSurfaceAuthority!,
      statsSource: remoteStatsSource,
      packetSource: remotePacketSource,
      fileSource: fileService satisfies RemoteFileSource,
      worktreeSource: worktreeService,
      quickCommandSource: remoteQuickCommandSource,
      openclawSource: remoteOpenClawSource,
      agentSource: agentActivityService ? {
        getSnapshot: () => agentActivityService!.getSnapshot(),
        onSnapshot: (listener) => agentActivityService!.onSnapshot(listener),
        sendFollowup: (activityId, text) => agentActivityService!.sendPrompt(activityId, text),
        decideApproval: (activityId, approvalId, decision) => (
          agentActivityService!.decideApproval(activityId, approvalId, decision)
        ),
      } : undefined,
      agentCoordinationSource: agentCoordinationService && managedMergeService ? {
        getSnapshot: () => agentCoordinationService!.getSnapshot(),
        onSnapshot: (listener) => agentCoordinationService!.onSnapshot(listener),
        markSeen: (activityId, stateSeq) => agentCoordinationService!.markSeen(activityId, stateSeq),
        decideManagedMerge: (input) => managedMergeService!.decide(input),
      } : undefined,
      agentHistorySource: agentHistoryService,
      gitSource: gitStatusService,
      pairingSource: {
        match: (code) => pairingCodeService.match(code),
        consume: (code, generation) => {
          const redeemed = pairingCodeService.consume(code, generation);
          // Announced separately from the code going null, so the dialog can
          // tell "a device just paired" from "the code simply expired".
          if (redeemed) broadcast('pairing:redeemed');
          return redeemed;
        },
      },
    },
    getMainWindow: () => (
      mainWindowRef
      ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      ?? null
    ),
  });
  desktopRuntime = runtime;
  void runtime.initialize().catch(() => undefined);

  // ── OpenClaw management (openclaw-management M1) ─────────────────────────
  // `openclaw`/`openClawService` are constructed earlier (see the mobile
  // bridge/proxy wiring above, which needs it to build `remoteOpenClawSource`)
  // — IPC here is a thin adapter, same shape as the file explorer's
  // FileService wiring above. The chat token/URL never cross to the renderer
  // (M3 owns the WebContentsView main-side) — only a boolean "is a token
  // available" is exposed via `openclaw:chat-available`.
  ipcMain.handle('openclaw:get-status', (_event, force?: boolean) => openclaw.getStatus(force));
  ipcMain.handle('openclaw:get-control', (_event, force?: boolean) => getOpenClawControl(force));
  ipcMain.handle('openclaw:lifecycle', (_event, action: OpenClawLifecycleAction) => requestOpenClawLifecycle(action));
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
        openclawControl?.updatePhysicalStatus(status);
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
  let openclawUnsubscribeControl: (() => void) | null = null;
  const syncOpenClawControlSubscription = (): void => {
    const wantControl = openclawDrawerOpen || openclawChatPanelOpen;
    if (wantControl && !openclawUnsubscribeControl) {
      openclawUnsubscribeControl = subscribeOpenClawControl((snapshot) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
          win.webContents.send('openclaw:control', snapshot);
        }
      });
    } else if (!wantControl && openclawUnsubscribeControl) {
      openclawUnsubscribeControl();
      openclawUnsubscribeControl = null;
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
    syncOpenClawControlSubscription();
    syncOpenClawLogSubscription();
  });
  ipcMain.on('openclaw:chat-panel-mounted', (_event, mounted: boolean) => {
    openclawChatPanelOpen = Boolean(mounted);
    syncOpenClawStatusSubscription();
    syncOpenClawControlSubscription();
  });

  // ── OpenClaw chat WebContentsView IPC (openclaw-management M3) ───────────
  // The placeholder panel (OpenClawChatPanel.tsx) reports its bounding rect
  // and App.tsx's single effective-visibility derivation continuously; the
  // manager itself decides lazy creation (see openclaw-chat-view.ts's module
  // doc). `chat-open` is sent only once the panel observes status==='running';
  // the revisioned surface message is the sole ownership/geometry/visibility
  // contract and `mounted:false` tears the native view down.
  ipcMain.on('openclaw:chat-open', () => {
    void openClawChatView?.ensureView();
  });
  const openClawChatSurfaceRevisions = new OpenClawChatSurfaceRevisionGate();
  ipcMain.on('openclaw:chat-surface', (event, surface: unknown) => {
    const mainWindow = mainWindowRef;
    if (
      !mainWindow
      || mainWindow.isDestroyed()
      || event.sender !== mainWindow.webContents
      || !isOpenClawChatSurfaceSnapshot(surface)
    ) return;
    const host = surface.mounted
      ? desktopWindowManager?.resolveWindowName(surface.windowName)
      : null;
    if (surface.mounted && !host) return;
    if (!openClawChatSurfaceRevisions.accept(surface)) return;
    if (!surface.mounted) {
      openClawChatView?.destroy();
      return;
    }
    if (!host) return;
    openClawChatView?.updateSurface(host, surface);
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
      await openExternalForUser(url);
      return true;
    } catch {
      return false;
    }
  });

  createWindow();
  if (process.env.EZTERMINAL_DISABLE_UPDATE_CHECK !== '1') {
    void appUpdateService.check();
  }
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    return;
  }
  const mainWindow = mainWindowRef;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
