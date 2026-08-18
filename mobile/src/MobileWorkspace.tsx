import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronLeft, ChevronsUpDown, Plus } from 'lucide-react';

import type { OpenClawMode, ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import type { SessionInfo } from '../../src/shared/ipc';
import type { SessionSurfaceBinding, SessionSurfaceIntent } from '../../src/shared/session-surface';
import { EMPTY_AGENT_ACTIVITY_SNAPSHOT, type AgentActivitySnapshot } from '../../src/shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationSnapshot,
} from '../../src/shared/agent-coordination';
import { countAgentAttention } from '../../src/shared/agent-attention';
import { observationalIntervalMs } from '../../src/shared/resource-profile';
import type { AgentTerminalBootstrap } from '../../src/shared/agent-history';
import { formatCwd } from '../../src/renderer/format-cwd';
import { startAsyncPoll } from '../../src/renderer/async-poller';
import { formatEndpointHost } from './mobile-endpoint';
import { useAppTranslation } from '../../src/renderer/i18n';
import { quoteEzArgument } from '../../src/shared/quote-ez-argument';
import { insertIntoPaneInput } from '../../src/renderer/pane-registry';
import { e2eLog } from './e2e-telemetry';
import { MobileHomeView, type HomeSessionRow } from './MobileHomeView';
import { MobileMoreSheet } from './MobileMoreSheet';
import { MobilePageHeader } from './MobilePageHeader';
import { MobileSessionSheet } from './MobileSessionSheet';
import { MobileSessionView } from './MobileSessionView';
import { MobileTabBar, type MobileShellTab } from './MobileTabBar';
import { MobileToastProvider } from './MobileToast';
import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';
import { loadOpenClawMode, saveOpenClawMode } from './openclaw-mode';
import { decideTabSwipe } from './tab-swipe';
import { ThemeMenu } from './ThemeMenu';
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  OPEN_TERMINAL_KEY_SETTINGS_EVENT,
} from './terminal-accessory-layout';
import { applyTheme, loadTheme, saveTheme } from './theme';
import { initialTabsState, mobileTerminalPanelId, tabsReducer } from './tabs';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';
import { usePageVisible } from './use-page-visible';
import {
  createInitialAppUpdateSnapshot,
  isAppUpdateAvailable,
} from '../../src/shared/app-update';
import type { MobileAppUpdateController } from './use-mobile-app-update';
import { MOBILE_BUILD_INFO } from './build-info';
import { useMobileUiPreferences } from './MobileUiPreferencesProvider';
import {
  LazyFeature,
  createFeatureModuleLoader,
  preloadOnIntent,
  useProfileFeaturePreload,
  type PreloadableFeature,
} from '../../src/renderer/feature-loader';

const MOBILE_FEATURE_LOADERS = Object.freeze({
  agents: createFeatureModuleLoader(
    () => import('./MobileAgentView'),
    (module) => module.MobileAgentView,
  ),
  files: createFeatureModuleLoader(
    () => import('./MobileFileView'),
    (module) => module.MobileFileView,
  ),
  openclaw: createFeatureModuleLoader(
    () => import('./MobileOpenClawView'),
    (module) => module.MobileOpenClawView,
  ),
  pcControl: createFeatureModuleLoader(
    () => import('./MobileRemoteDesktopView'),
    (module) => module.MobileRemoteDesktopView,
  ),
  settings: createFeatureModuleLoader(
    () => import('./MobileSettingsView'),
    (module) => module.MobileSettingsView,
  ),
  stats: createFeatureModuleLoader(
    () => import('./MobileStatsView'),
    (module) => module.MobileStatsView,
  ),
  sessions: createFeatureModuleLoader(
    () => import('./SessionSwitcher'),
    (module) => module.SessionSwitcher,
  ),
});

const MOBILE_PRELOAD_LOADERS: readonly PreloadableFeature[] = Object.freeze(
  Object.values(MOBILE_FEATURE_LOADERS),
);

/** Slow enough to be invisible on a battery, fast enough that a finished run
 * stops claiming to be live before the user looks twice. */
const ACTIVE_RUN_POLL_MS = 4_000;

let mobileSurfaceSequence = 0;
function nextMobileSurfaceId(): string {
  mobileSurfaceSequence += 1;
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${mobileSurfaceSequence}`;
  return `mobile-tab:${uuid}`;
}

const UNAVAILABLE_APP_UPDATE_CONTROLLER: MobileAppUpdateController = {
  snapshot: createInitialAppUpdateSnapshot(MOBILE_BUILD_INFO.appVersion),
  check: () => Promise.resolve(),
  download: () => Promise.resolve(),
  cancelDownload: () => Promise.resolve(),
  openDownloaded: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
};

/** Full-screen destinations reachable from a tab root. Each one owns the Back
 * stop above the tab layer, so Back unwinds sheet -> sub-page -> tab -> exit. */
export const MOBILE_SUB_PAGES = ['files', 'stats', 'openclaw', 'settings', 'pc-control', 'sessions'] as const;
type MobileSubPage = (typeof MOBILE_SUB_PAGES)[number];

export const MOBILE_SHEETS = ['more', 'sessions'] as const;
type MobileSheet = (typeof MOBILE_SHEETS)[number];

// MobileWorkspace — the authed shell. The commercial pass replaces the old
// "hub -> full-screen destination" tree with a five-item bottom bar (a 72dp
// left rail from 600dp up): Home | Terminal | PC | Agents | More. PC Control
// is an explicit start action rather than a destination, and More is a sheet.
//
// KEEP-ALIVE (unchanged contract): every open tab's MobileSessionView stays
// MOUNTED for as long as its tab exists. Switching shell tabs only renders an
// opaque page layer OVER the terminal layer (MobileWorkbenchCoordinator) and
// switching terminal tabs only toggles `display: none` on the wrapper div —
// neither ever unmounts. A fresh mount would tear down that tab's
// BlockController(s)/FakeMessagePort and lose the running PTY stream's UI
// state. `display: none` keeps React state alive (and the compile-time E2E
// output probe active); the one thing it breaks is xterm's internal
// measurement of a now-zero-size container, which is why activating a tab
// dispatches a `resize` event on the next animation frame.
export function MobileWorkspace({
  transport,
  appActive = true,
  connectionUrl = '',
  roundTripMs = null,
  onDisconnect,
  appUpdateController = UNAVAILABLE_APP_UPDATE_CONTROLLER,
}: {
  transport: WsEzTerminalTransport;
  /** Capacitor activity, independent of WebView visibility quirks. */
  appActive?: boolean;
  connectionUrl?: string;
  /** Smoothed link latency, or null before the first probe answers. */
  roundTripMs?: number | null;
  onDisconnect: () => void;
  readonly appUpdateController?: MobileAppUpdateController;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { preferences: uiPreferences } = useMobileUiPreferences();
  const pageVisible = usePageVisible();
  useProfileFeaturePreload(MOBILE_PRELOAD_LOADERS, uiPreferences.resourceProfile, true);
  const [tabsState, dispatch] = useReducer(tabsReducer, initialTabsState);
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  const [tab, setTab] = useState<MobileShellTab>('home');
  const [subPage, setSubPage] = useState<MobileSubPage | null>(null);
  const [sheet, setSheet] = useState<MobileSheet | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(() => loadTheme());
  const [agentSnapshot, setAgentSnapshot] = useState<AgentActivitySnapshot>(EMPTY_AGENT_ACTIVITY_SNAPSHOT);
  const [agentCoordinationSnapshot, setAgentCoordinationSnapshot] = useState<AgentCoordinationSnapshot>(
    EMPTY_AGENT_COORDINATION_SNAPSHOT,
  );
  const [connected, setConnected] = useState(false);
  const [authGeneration, setAuthGeneration] = useState(0);
  const [connectedSince, setConnectedSince] = useState<number | null>(null);
  const updateAvailable = isAppUpdateAvailable(appUpdateController.snapshot);
  const [sessions, setSessions] = useState<readonly SessionInfo[]>([]);
  const [activeRuns, setActiveRuns] = useState<ReadonlyMap<string, string>>(new Map());
  const [agentBootstraps, setAgentBootstraps] = useState<
    ReadonlyMap<string, AgentTerminalBootstrap>
  >(new Map());
  const themeReturnFocusRef = useRef<HTMLElement | null>(null);
  const sheetReturnFocusRef = useRef<HTMLElement | null>(null);
  const subPageReturnTargetRef = useRef('shell-tab-home');
  const restoreTabFocusRef = useRef(false);
  const cwdMapRef = useRef(new Map<string, string>());

  const openSubPage = useCallback((next: MobileSubPage, returnTarget: string) => {
    const loader = next === 'files'
      ? MOBILE_FEATURE_LOADERS.files
      : next === 'stats'
        ? MOBILE_FEATURE_LOADERS.stats
        : next === 'openclaw'
          ? MOBILE_FEATURE_LOADERS.openclaw
          : next === 'settings'
            ? MOBILE_FEATURE_LOADERS.settings
            : next === 'pc-control'
              ? MOBILE_FEATURE_LOADERS.pcControl
              : MOBILE_FEATURE_LOADERS.sessions;
    preloadOnIntent(loader);
    subPageReturnTargetRef.current = returnTarget;
    setSheet(null);
    setSubPage(next);
  }, []);

  const closeSubPage = useCallback(() => {
    restoreTabFocusRef.current = true;
    setSubPage(null);
  }, []);

  const selectTab = useCallback((next: MobileShellTab) => {
    if (next === 'agents') preloadOnIntent(MOBILE_FEATURE_LOADERS.agents);
    setSheet(null);
    setSubPage(null);
    setTab(next);
  }, []);

  useEffect(() => {
    if (subPage !== null || !restoreTabFocusRef.current) return;
    restoreTabFocusRef.current = false;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="${subPageReturnTargetRef.current}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [subPage]);

  useEffect(() => {
    const openTerminalKeySettings = (): void => {
      openSubPage('settings', 'shell-tab-more');
    };
    window.addEventListener(OPEN_TERMINAL_KEY_SETTINGS_EVENT, openTerminalKeySettings);
    return () => window.removeEventListener(OPEN_TERMINAL_KEY_SETTINGS_EVENT, openTerminalKeySettings);
  }, [openSubPage]);

  useEffect(() => transport.onAuthChange((authed) => {
    setConnected(authed);
    if (authed) {
      setAuthGeneration((generation) => generation + 1);
    } else {
      dispatch({ type: 'invalidateBindings' });
    }
    // First authentication of this link wins; a reconnect that never dropped
    // `connected` keeps the original start so the uptime doesn't reset.
    setConnectedSince((current) => authed ? current ?? Date.now() : null);
  }), [transport]);

  // Full session list (not just a count) — the Home tab's recent rows and the
  // terminal's session sheet both read it, and both need cwd for their labels.
  useEffect(() => {
    if (!connected) {
      setSessions([]);
      return;
    }
    let alive = true;
    type SessionDelta =
      | { readonly kind: 'added'; readonly session: SessionInfo }
      | { readonly kind: 'removed'; readonly sessionId: string };
    const pendingDeltas: SessionDelta[] = [];
    let seeded = false;
    const applyDelta = (
      current: readonly SessionInfo[],
      delta: SessionDelta,
    ): readonly SessionInfo[] => {
      if (delta.kind === 'removed') {
        return current.filter((entry) => entry.sessionId !== delta.sessionId);
      }
      const index = current.findIndex((entry) => entry.sessionId === delta.session.sessionId);
      if (index < 0) return [...current, delta.session];
      const next = [...current];
      next[index] = delta.session;
      return next;
    };
    const unsubscribeAdded = transport.onSessionAdded((session) => {
      if (!alive) return;
      const delta = { kind: 'added', session } as const;
      if (!seeded) pendingDeltas.push(delta);
      setSessions((current) => applyDelta(current, delta));
    });
    const unsubscribeRemoved = transport.onSessionRemoved((sessionId) => {
      if (!alive) return;
      const delta = { kind: 'removed', sessionId } as const;
      if (!seeded) pendingDeltas.push(delta);
      setSessions((current) => applyDelta(current, delta));
      dispatch({ type: 'sessionDied', sessionId });
      cwdMapRef.current.delete(sessionId);
      setAgentBootstraps((previous) => {
        if (!previous.has(sessionId)) return previous;
        const next = new Map(previous);
        next.delete(sessionId);
        return next;
      });
    });
    void transport.listSessions().then((list) => {
      if (!alive) return;
      seeded = true;
      setSessions(pendingDeltas.reduce<readonly SessionInfo[]>(applyDelta, list));
      pendingDeltas.length = 0;
    }).catch(() => {
      seeded = true;
      pendingDeltas.length = 0;
    });
    return () => {
      alive = false;
      unsubscribeAdded();
      unsubscribeRemoved();
    };
  }, [connected, transport]);

  // Which sessions are actually executing something. `listRuns` is the one
  // authority for that, and it is edge-triggered nowhere — a run can also end,
  // which nothing announces — so this looks again while the Home tab is up and
  // stops entirely when it is not.
  useEffect(() => {
    if (!connected || !pageVisible || tab !== 'home') {
      setActiveRuns(new Map());
      return undefined;
    }
    let alive = true;
    const read = async (): Promise<void> => {
      await transport.listRuns().then((runs) => {
        if (!alive) return;
        setActiveRuns(new Map(runs.map((run) => [run.sessionId, run.commandText])));
      }).catch(() => undefined);
    };
    const stopPoll = startAsyncPoll({
      task: read,
      intervalMs: () => observationalIntervalMs(
        ACTIVE_RUN_POLL_MS,
        uiPreferences.resourceProfile,
      ),
    });
    return () => {
      alive = false;
      stopPoll();
    };
  }, [connected, pageVisible, tab, transport, uiPreferences.resourceProfile]);

  useEffect(() => {
    let alive = true;
    const apply = (snapshot: AgentActivitySnapshot): void => {
      // The transport is the revision/epoch authority. It already suppresses
      // stale snapshots within one desktop process and deliberately accepts
      // the first lower revision after reconnect as a new process epoch.
      if (alive) setAgentSnapshot(snapshot);
    };
    const unsubscribe = transport.onAgentActivitySnapshot(apply);
    void transport.getAgentActivitySnapshot().then(apply).catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [transport]);

  useEffect(() => {
    let alive = true;
    const apply = (snapshot: AgentCoordinationSnapshot): void => {
      if (alive) setAgentCoordinationSnapshot(snapshot);
    };
    const unsubscribe = transport.onAgentCoordinationSnapshot(apply);
    void transport.getAgentCoordinationSnapshot().then(apply).catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [transport]);

  // ── OpenClaw tri-state visibility + status dot (openclaw-stabilization
  // M3/M4) ───────────────────────────────────────────────────────────────
  const [openclawMode, setOpenclawMode] = useState<OpenClawMode>(() => loadOpenClawMode());
  const [openclawAvailable, setOpenclawAvailable] = useState(false);
  const [openclawState, setOpenclawState] = useState<OpenClawStatus | null>(null);

  const handleOpenClawModeChange = useCallback((mode: OpenClawMode) => {
    saveOpenClawMode(mode);
    setOpenclawMode(mode);
  }, []);

  // `onOpenClawAvailability` is an unconditional push (no subscribe/
  // unsubscribe control message, see ws-ezterminal.ts) — always listened for,
  // independent of the derived visibility below (it's an INPUT to that
  // derivation, so it can't itself be gated on it).
  useEffect(() => {
    return transport.onOpenClawAvailability(setOpenclawAvailable);
  }, [transport]);

  const effectiveOpenClawVisible =
    openclawMode === 'on' ? true : openclawMode === 'off' ? false : openclawAvailable;
  // Background pause (openclaw-stabilization M6): the status push otherwise
  // keeps flowing over WS every 4s while the app sits backgrounded, burning
  // battery for nobody. Combined into the acquire/release effect below —
  // the M3/M4 refcount (see ws-ezterminal.ts's `openclawStatusRefcount` doc)
  // makes releasing on hide and re-acquiring on show safe.
  // Status subscription (for the entry-button/header dot) is owned HERE, at
  // workspace level, for as long as OpenClaw is effectively visible —
  // independent of whether the full MobileOpenClawView is open. The
  // transport's `setOpenClawStatusSubscribed` is REFCOUNTED specifically so
  // this persistent subscription and MobileOpenClawView's own mount/unmount
  // subscription (while the view itself is open) don't fight over the same
  // boolean (see ws-ezterminal.ts's `openclawStatusRefcount` doc).
  //
  // `openclawAvailable` is listed as a dep even though it doesn't change
  // `effectiveOpenClawVisible` under mode='on' (always true): the bridge
  // silently drops a status-subscribe sent while desktop-hidden (remote-
  // bridge.ts's `openclawVisible()` gate never attaches it), so without this
  // dep a desktop hidden->visible flip during mode='on' would never re-send
  // the subscribe — the entry dot would go stale forever. Listing it forces
  // a cleanup+resubscribe on every availability transition (refcount-safe).
  useEffect(() => {
    if (!effectiveOpenClawVisible || !pageVisible) return;
    const unsubscribe = transport.onOpenClawStatus(setOpenclawState);
    transport.setOpenClawStatusSubscribed(true);
    return () => {
      unsubscribe();
      transport.setOpenClawStatusSubscribed(false);
    };
  }, [effectiveOpenClawVisible, pageVisible, openclawAvailable, transport]);

  // File explorer (M4): the best-effort cwd snapshot each session's
  // MobileSessionView reports via `onCwdChange` — read ONCE when Files opens
  // (never live-followed), same locked requirement as the desktop drawer.
  const handleCwdChange = useCallback((sessionId: string, cwd: string) => {
    cwdMapRef.current.set(sessionId, cwd);
  }, []);

  const handleThemeSelect = useCallback((name: ThemeName) => {
    applyTheme(name);
    saveTheme(name);
    setCurrentTheme(name);
  }, []);

  const revealTerminal = useCallback(() => {
    setSheet(null);
    setSubPage(null);
    setTab('terminal');
  }, []);

  const acceptSurfaceBinding = useCallback((binding: SessionSurfaceBinding) => {
    dispatch({ type: 'open', binding });
    revealTerminal();
  }, [revealTerminal]);

  const createOwnedSurface = useCallback(async (cwd?: string): Promise<SessionSurfaceBinding> => {
    const intent: SessionSurfaceIntent = cwd === undefined
      ? { kind: 'create' }
      : { kind: 'create', cwd };
    const result = await transport.openSessionSurface(nextMobileSurfaceId(), intent);
    if (!result.ok) throw new Error(`Session surface open failed: ${result.reason}`);
    return result.binding;
  }, [transport]);

  const openOwnedTab = useCallback(async (cwd?: string): Promise<SessionSurfaceBinding> => {
    const binding = await createOwnedSurface(cwd);
    acceptSurfaceBinding(binding);
    return binding;
  }, [acceptSurfaceBinding, createOwnedSurface]);

  const pendingAdoptionsRef = useRef(new Map<string, Promise<void>>());
  const adoptAndOpenTab = useCallback((sessionId: string): Promise<void> => {
    const existing = tabsStateRef.current.tabs.find((entry) => entry.sessionId === sessionId);
    if (existing) {
      dispatch({ type: 'activate', sessionId });
      revealTerminal();
      return Promise.resolve();
    }
    const pending = pendingAdoptionsRef.current.get(sessionId);
    if (pending) return pending;

    const adoption = transport.openSessionSurface(nextMobileSurfaceId(), { kind: 'adopt', sessionId })
      .then((result) => {
        if (!result.ok) throw new Error(`Session surface adoption failed: ${result.reason}`);
        acceptSurfaceBinding(result.binding);
      })
      .finally(() => {
        if (pendingAdoptionsRef.current.get(sessionId) === adoption) {
          pendingAdoptionsRef.current.delete(sessionId);
        }
      });
    pendingAdoptionsRef.current.set(sessionId, adoption);
    return adoption;
  }, [acceptSurfaceBinding, revealTerminal, transport]);

  // A reconnect is a new host principal generation. Existing tabs keep their
  // client surface ids, but deliberately regain only adopted bindings.
  useEffect(() => {
    if (!connected || authGeneration === 0) return;
    const candidates = tabsStateRef.current.tabs.filter((entry) => entry.binding === null);
    for (const entry of candidates) {
      void transport.openSessionSurface(entry.surfaceId, {
        kind: 'adopt',
        sessionId: entry.sessionId,
      }).then((result) => {
        if (result.ok) {
          dispatch({ type: 'rebind', sessionId: entry.sessionId, binding: result.binding });
        } else if (result.reason === 'not-found') {
          dispatch({ type: 'sessionDied', sessionId: entry.sessionId });
        }
      });
    }
  }, [authGeneration, connected, transport]);

  useEffect(() => {
    return transport.onWorktreeOpenRequested((worktree) => {
      void openOwnedTab(worktree.path)
        .catch((err: unknown) => console.error('[mobile] worktree tab creation failed:', err));
    });
  }, [openOwnedTab, transport]);

  const activateTab = useCallback((sessionId: string) => {
    dispatch({ type: 'activate', sessionId });
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    dispatch({ type: 'close', sessionId });
    cwdMapRef.current.delete(sessionId);
    setAgentBootstraps((previous) => {
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const handleSessionDead = useCallback((sessionId: string) => {
    dispatch({ type: 'sessionDied', sessionId });
    cwdMapRef.current.delete(sessionId);
    setAgentBootstraps((previous) => {
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const startAgentBootstrap = useCallback(async (
    bootstrap: AgentTerminalBootstrap,
  ): Promise<void> => {
    // Providers without a "run in this directory" flag resolve their session
    // store from the process cwd, so the resumed shell starts in the root.
    const binding = await createOwnedSurface(bootstrap.cwd);
    setAgentBootstraps((previous) => {
      const next = new Map(previous);
      next.set(binding.session.sessionId, bootstrap);
      return next;
    });
    acceptSurfaceBinding(binding);
  }, [acceptSurfaceBinding, createOwnedSurface]);

  const quickNewTab = useCallback(() => {
    void openOwnedTab().catch((error: unknown) => {
      console.error('[mobile] terminal tab creation failed:', error);
    });
  }, [openOwnedTab]);

  // File-explorer drawer's "open terminal here" (M4): a fresh tab whose
  // session starts in `dirPath` — mirrors `quickNewTab`, cwd threaded through.
  const onOpenTerminalAt = useCallback(
    (dirPath: string) => {
      void openOwnedTab(dirPath).catch((error: unknown) => {
        console.error('[mobile] terminal tab creation failed:', error);
      });
    },
    [openOwnedTab],
  );

  // File-explorer drawer's "paste path into terminal" (M4): the active
  // session's command draft, via the same `pane-registry` sink
  // MobileSessionView registers (keyed by sessionId).
  const onPastePath = useCallback((path: string) => {
    if (!tabsState.activeSessionId) return;
    insertIntoPaneInput(tabsState.activeSessionId, quoteEzArgument(path));
  }, [tabsState.activeSessionId]);

  // Fires on every active-tab change, however it happened (open, explicit
  // activate, or a close that fell back to a neighbor) — a previously
  // display:none tab was just made visible, so any xterm inside it needs to
  // re-measure, and the e2e marker (mobile/e2e/parity.ts greps logcat) should
  // reflect the tab that is ACTUALLY active now, not just the action taken.
  useEffect(() => {
    if (!tabsState.activeSessionId) return;
    window.dispatchEvent(new Event(ACTIVE_MOBILE_TAB_CHANGE_EVENT));
    e2eLog('tab-active:', tabsState.activeSessionId);
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [tabsState.activeSessionId]);

  useEffect(() => {
    transport.setReattachPriority(tabsState.activeSessionId);
    return () => transport.setReattachPriority(null);
  }, [tabsState.activeSessionId, transport]);

  const activeSession = tabsState.tabs.find((tab) => tab.sessionId === tabsState.activeSessionId);
  const initialFilePath =
    (tabsState.activeSessionId && cwdMapRef.current.get(tabsState.activeSessionId))
    ?? activeSession?.cwd
    ?? '';

  // The bridge's session list, annotated with whether this device already has
  // it open as a tab. Tabs open HERE come first, in tab order, so the session
  // sheet and the mounted terminal layers agree on ordering; the remaining
  // desktop-side sessions follow. Locally-created tabs are folded in so a
  // session created here shows up before the next `session-list` broadcast.
  const sessionRows = useMemo<readonly HomeSessionRow[]>(() => {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const rows: HomeSessionRow[] = tabsState.tabs.map((entry) => ({
      session: byId.get(entry.sessionId) ?? { sessionId: entry.sessionId, cwd: entry.cwd },
      open: true,
    }));
    const openIds = new Set(tabsState.tabs.map((entry) => entry.sessionId));
    for (const session of sessions) {
      if (!openIds.has(session.sessionId)) rows.push({ session, open: false });
    }
    return rows;
  }, [sessions, tabsState.tabs]);

  const openSessionFromList = useCallback((session: SessionInfo) => {
    void adoptAndOpenTab(session.sessionId).catch((error: unknown) => {
      console.error('[mobile] session adoption failed:', error);
    });
  }, [adoptAndOpenTab]);

  const agentAttention = countAgentAttention(agentSnapshot);

  // Swipe-between-tabs used to live on the tab strip the session sheet
  // replaced. Keeping it on the terminal header preserves the gesture (and
  // `decideTabSwipe`'s scroll-suppression contract) rather than dropping a
  // capability the redesign never asked to remove.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const onHeaderTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    swipeStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);
  const onHeaderTouchEnd = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const decision = decideTabSwipe({
      dx: touch.clientX - start.x,
      dy: touch.clientY - start.y,
      scrollDelta: 0,
    });
    if (!decision) return;
    const index = tabsState.tabs.findIndex((entry) => entry.sessionId === tabsState.activeSessionId);
    if (index === -1) return;
    const next = decision === 'next' ? tabsState.tabs[index + 1] : tabsState.tabs[index - 1];
    if (next) activateTab(next.sessionId);
  }, [activateTab, tabsState.activeSessionId, tabsState.tabs]);

  const auxiliaryPageFallback = (
    <div className="status-loading mobile-auxiliary-page-loading" role="status" data-testid="mobile-auxiliary-page-loading">
      {t('common.loading')}
    </div>
  );

  let page: JSX.Element | undefined;
  if (subPage === 'pc-control') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.pcControl}
        componentProps={{ transport, hostLabel: formatEndpointHost(connectionUrl), onClose: closeSubPage }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={closeSubPage}
      />
    );
  } else if (subPage === 'openclaw') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.openclaw}
        componentProps={{ transport, onClose: closeSubPage, openclawAvailable }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={closeSubPage}
      />
    );
  } else if (subPage === 'settings') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.settings}
        componentProps={{
          connectionUrl,
          connectedSince,
          onClose: closeSubPage,
          onDisconnect,
          openclawMode,
          onOpenClawModeChange: handleOpenClawModeChange,
          openclawState: openclawState?.state,
          currentTheme,
          onOpenTheme: (trigger) => {
            themeReturnFocusRef.current = trigger;
            setThemeMenuOpen(true);
          },
          appUpdateController,
        }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={closeSubPage}
      />
    );
  } else if (subPage === 'files') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.files}
        componentProps={{ transport, initialPath: initialFilePath, onClose: closeSubPage, onOpenTerminalAt, onPastePath }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={closeSubPage}
      />
    );
  } else if (subPage === 'stats') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.stats}
        componentProps={{ onClose: closeSubPage }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={closeSubPage}
      />
    );
  } else if (subPage === 'sessions') {
    // The session SHEET is the fast switcher; this full manager is what still
    // owns create/destroy with the guarded close-risk flow, so the redesign
    // does not cost a capability.
    page = (
      <div className="mobile-destination mobile-sessions-destination">
        <MobilePageHeader
          title={t('mobile.sessions')}
          backLabel={t('common.back')}
          onBack={closeSubPage}
        />
        <div className="mobile-destination__body">
          <LazyFeature
            loader={MOBILE_FEATURE_LOADERS.sessions}
            componentProps={{
              transport,
              onSelect: (sessionId) => {
                void adoptAndOpenTab(sessionId);
              },
              onCreate: async () => {
                await openOwnedTab();
              },
              onDisconnect,
            }}
            loading={auxiliaryPageFallback}
            errorMessage={t('common.featureLoadFailed')}
            retryLabel={t('common.retry')}
            closeLabel={t('common.close')}
            onClose={closeSubPage}
          />
        </div>
      </div>
    );
  } else if (tab === 'home') {
    page = (
      <MobileHomeView
        connected={connected}
        connectionUrl={connectionUrl}
        desktopControlSupported={transport.supportsDesktopControl}
        sessions={sessionRows}
        activeSessionId={tabsState.activeSessionId}
        agentSnapshot={agentSnapshot}
        activeRuns={activeRuns}
        roundTripMs={roundTripMs}
        agentAttention={agentAttention}
        openclawVisible={effectiveOpenClawVisible}
        openclawState={openclawState?.state}
        onOpenPcControl={() => openSubPage('pc-control', 'shell-tab-pc')}
        onOpenSession={openSessionFromList}
        onOpenTerminal={() => selectTab('terminal')}
        onOpenAgents={() => selectTab('agents')}
        onOpenClaw={() => openSubPage('openclaw', 'shell-tab-home')}
      />
    );
  } else if (tab === 'agents') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.agents}
        componentProps={{
          snapshot: agentSnapshot,
          coordinationSnapshot: agentCoordinationSnapshot,
          disconnected: !connected,
          onBack: () => selectTab('home'),
          onSendFollowup: (activityId, text) => transport.sendAgentFollowup(activityId, text),
          onDecideApproval: (activityId, approvalId, decision) =>
            transport.decideAgentApproval(activityId, approvalId, decision),
          onLoadDiff: (directory) => transport.getGitDiff(directory),
          onReadGitStatus: (directory) => transport.getGitStatus(directory),
          onResumeHistory: startAgentBootstrap,
          onLaunchAgent: startAgentBootstrap,
          transport,
          onFocusSession: (sessionId) => {
            const activity = agentSnapshot.items.find((item) => item.sessionId === sessionId);
            if (activity) void transport.markAgentSeen(activity.id, activity.stateSeq);
            void adoptAndOpenTab(sessionId);
          },
        }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={() => selectTab('home')}
      />
    );
  }

  const immersive = subPage === 'pc-control';

  return (
    <MobileToastProvider>
      <MobileWorkbenchCoordinator
        terminalActive={tab === 'terminal' && subPage === null}
        destinationActive={subPage !== null}
        tabRootActive={tab !== 'home'}
        onRequestRoot={closeSubPage}
        onRequestTabRoot={() => setTab('home')}
        page={page}
        navigation={immersive ? undefined : (
          <MobileTabBar
            tab={tab}
            agentAttention={agentAttention}
            updateAvailable={updateAvailable}
            onSelectTab={selectTab}
            onOpenPcControl={() => openSubPage('pc-control', 'shell-tab-pc')}
            onOpenMore={() => {
              sheetReturnFocusRef.current = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
              setSheet('more');
            }}
            onOpenSettings={() => openSubPage('settings', 'shell-rail-settings')}
          />
        )}
        terminal={(
          <div className="mobile-workspace" data-testid="mobile-workspace">
            <header
              className="mob-term-head"
              onTouchStart={onHeaderTouchStart}
              onTouchEnd={onHeaderTouchEnd}
            >
              <button
                type="button"
                className="mob-icon-btn"
                onClick={() => selectTab('home')}
                aria-label={t('common.back')}
                data-testid="workspace-hub-btn"
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                className="mob-term-head__session"
                onClick={() => {
                  sheetReturnFocusRef.current = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                  setSheet('sessions');
                }}
                aria-haspopup="dialog"
                aria-label={t('mobile.sessions')}
                data-testid="menu-btn"
              >
                <span
                  className={activeSession ? 'mob-dot mob-dot--live' : 'mob-dot'}
                  aria-hidden="true"
                />
                <span className="mob-term-head__label">
                  {activeSession ? formatCwd(activeSession.cwd, 28) : t('mobile.noTerminalTabs')}
                </span>
                <ChevronsUpDown aria-hidden="true" />
              </button>
              <button
                type="button"
                className="mob-icon-btn mob-icon-btn--accent"
                onClick={quickNewTab}
                disabled={!connected}
                aria-label={t('mobile.newTab')}
                data-testid="tab-add-btn"
              >
                <Plus aria-hidden="true" />
              </button>
            </header>

            {tabsState.tabs.length === 0 && (
              <div className="mobile-terminal-empty" data-testid="mobile-terminal-empty">
                <div>
                  <h1>{t('mobile.noTerminalTabs')}</h1>
                  <p>{t('mobile.noTerminalTabsHint')}</p>
                </div>
                <div className="mobile-terminal-empty-actions">
                  <button type="button" className="mob-cta" onClick={quickNewTab} disabled={!connected}>
                    <Plus aria-hidden="true" /> {t('mobile.home.newSession')}
                  </button>
                </div>
              </div>
            )}

            {tabsState.tabs.map((entry) => (
              <div
                key={entry.sessionId}
                id={mobileTerminalPanelId(entry.sessionId)}
                className="tab-page"
                role="group"
                aria-label={entry.cwd}
                data-testid="terminal-tab-page"
                data-active={entry.sessionId === tabsState.activeSessionId ? 'true' : 'false'}
                style={{ display: entry.sessionId === tabsState.activeSessionId ? undefined : 'none' }}
              >
                <MobileSessionView
                  sessionId={entry.sessionId}
                  cwd={entry.cwd}
                  transport={transport}
                  surfaceBinding={entry.binding}
                  active={entry.sessionId === tabsState.activeSessionId}
                  presentationVisible={
                    appActive
                    && tab === 'terminal'
                    && subPage === null
                    && entry.sessionId === tabsState.activeSessionId
                  }
                  quickCommandSource={transport}
                  quickCommandsSupported={transport.supportsRemoteQuickCommands}
                  connected={connected}
                  agentBootstrap={agentBootstraps.get(entry.sessionId)}
                  onSessionDead={() => handleSessionDead(entry.sessionId)}
                  onCwdChange={handleCwdChange}
                  onReadGitStatus={(directory) => transport.getGitStatus(directory)}
                  roundTripMs={roundTripMs}
                  onCloseTab={() => closeTab(entry.sessionId)}
                />
              </div>
            ))}
          </div>
        )}
        overlays={(
          <>
            {sheet === 'more' && (
              <MobileMoreSheet
                currentTheme={currentTheme}
                openclawVisible={effectiveOpenClawVisible}
                openclawState={openclawState?.state}
                updateAvailable={updateAvailable}
                returnFocusRef={sheetReturnFocusRef}
                onClose={() => setSheet(null)}
                onOpenSessions={() => openSubPage('sessions', 'shell-tab-more')}
                onOpenFiles={() => openSubPage('files', 'shell-tab-more')}
                onOpenStats={() => openSubPage('stats', 'shell-tab-more')}
                onOpenClaw={() => openSubPage('openclaw', 'shell-tab-more')}
                onOpenTheme={(trigger) => {
                  themeReturnFocusRef.current = trigger;
                  setSheet(null);
                  setThemeMenuOpen(true);
                }}
                onOpenSettings={() => openSubPage('settings', 'shell-tab-more')}
              />
            )}
            {sheet === 'sessions' && (
              <MobileSessionSheet
                sessions={sessionRows}
                activeSessionId={tabsState.activeSessionId}
                canCreate={connected}
                returnFocusRef={sheetReturnFocusRef}
                onClose={() => setSheet(null)}
                onSelect={(session) => {
                  setSheet(null);
                  openSessionFromList(session);
                }}
                onCreate={() => {
                  setSheet(null);
                  quickNewTab();
                }}
              />
            )}
            <ThemeMenu
              open={themeMenuOpen}
              current={currentTheme}
              onSelect={handleThemeSelect}
              onClose={() => setThemeMenuOpen(false)}
              returnFocusRef={themeReturnFocusRef}
            />
          </>
        )}
      />
    </MobileToastProvider>
  );
}
