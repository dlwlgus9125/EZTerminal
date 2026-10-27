import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronsUpDown, Plus } from 'lucide-react';

import type { OpenClawMode, ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import type { SessionInfo } from '../../src/shared/ipc';
import type { SessionSurfaceBinding, SessionSurfaceIntent } from '../../src/shared/session-surface';
import { EMPTY_AGENT_ACTIVITY_SNAPSHOT, type AgentActivitySnapshot } from '../../src/shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationSnapshot,
} from '../../src/shared/agent-coordination';
import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  orchestrationWorkerActivityIds,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import type { AgentTerminalBootstrap } from '../../src/shared/agent-history';
import { formatCwd } from '../../src/renderer/format-cwd';
import { formatEndpointHost } from './mobile-endpoint';
import { useAppTranslation } from '../../src/renderer/i18n';
import { quoteEzArgument } from '../../src/shared/quote-ez-argument';
import { insertIntoPaneInput } from '../../src/renderer/pane-registry';
import { e2eLog } from './e2e-telemetry';
import type { HomeSessionRow } from './MobileHomeView';
import { MobilePlanningNavigator } from './MobilePlanningNavigator';
import { MobilePageHeader } from './MobilePageHeader';
import { MobileSessionSheet } from './MobileSessionSheet';
import { MobileSessionView } from './MobileSessionView';
import { MobileToastProvider, useMobileToast } from './MobileToast';
import { createCapabilityAccess } from '../../src/renderer/capability-access';
import { createTerminalAiHost } from '../../src/renderer/terminal/terminal-ai-host';
import type { TerminalAiWiring } from '../../src/renderer/terminal/TerminalAiDock';
import { PHONE_PRINCIPAL, phoneChatStateAccess } from './phone-conversation-access';
import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';
import { Glyph, Menu, MenuItem, glyphIcon } from '../../src/renderer/ui';
import { useShellText } from '../../src/renderer/shell/shell-text';
import { MobileFeedView } from './feed/MobileFeedView';
import { decideFeedItem } from './feed/feed-actions';
import { feedBadgeCount, type FeedWaitingItem } from './feed/feed-model';
import { useFeedData } from './feed/use-feed-data';
import { lastSurfaceOf, launchSurface, type LastSurface } from './launch-surface';
import { MOBILE_BACKGROUND_SUSPEND_MS } from './mobile-app-lifecycle';
import { OPENCLAW_STATE_LABEL_KEY, loadOpenClawMode, saveOpenClawMode } from './openclaw-mode';
import { decideTabSwipe } from './tab-swipe';
import { ThemeMenu } from './ThemeMenu';
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  OPEN_TERMINAL_KEY_SETTINGS_EVENT,
} from './terminal-accessory-layout';
import { applyTheme, loadTheme, saveTheme } from './theme';
import { initialTabsState, mobileTerminalPanelId, tabsReducer } from './tabs';
import { readWorkspaceRestore, writeWorkspaceRestore } from './workspace-restore';
import type {
  DaemonRuntimeViewState,
  WsEzTerminalTransport,
} from './transport/ws-ezterminal';
import {
  MobileAgentCreateRecoveryStore,
  mobileAgentCreateAuthorityFingerprint,
  mobileAgentCreateRecoveryFromCommand,
  type MobileAgentCreateRecoveryController,
  type MobileAgentCreateRecoveryStatus,
  type MobileAgentCreateRecoveryStoreLike,
  type UncertainAgentCreate,
} from './mobile-agent-create-recovery-store';
import type { MobileWorkspaceTerminalResult } from './workspace-terminal';
import { MobileOfflineChatCacheStore, type MobileOfflineChatCache } from './mobile-offline-chat-cache';
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

export const MOBILE_SHEETS = ['sessions'] as const;
type MobileSheet = (typeof MOBILE_SHEETS)[number];

/**
 * The shell's roots (I4, layout A: no tab bar). The feed is the root and the first screen; the terminal, a project
 * and a conversation are opened from it (its header, ▾ and cards), and Back returns to it.
 */
export const MOBILE_TAB_ROOTS = ['feed', 'terminal', 'home', 'agents'] as const;
export type MobileShellTab = (typeof MOBILE_TAB_ROOTS)[number];
export const MOBILE_PRIMARY_DESTINATIONS = MOBILE_TAB_ROOTS;

/** A launch decision that is not ready this long after the connection stays unapplied (no late jump). */
const LAUNCH_DECISION_MS = 3_000;

const surfaceOf = (tab: MobileShellTab): LastSurface => tab === 'terminal' ? 'terminal' : tab === 'agents' ? 'chat' : 'feed';

/** The terminal AI input's "sent" notice and its way to a conversation, inside the toast provider. */
function TerminalAiNotices({ host, titleOf, openConversation }: {
  readonly host: ReturnType<typeof createTerminalAiHost>;
  readonly titleOf: (sessionId: string) => string;
  readonly openConversation: (sessionId: string) => void;
}): null {
  const showToast = useMobileToast();
  const { t } = useAppTranslation();
  host.setActions({
    openConversation,
    notifySent: (sessionId) => showToast(t('terminalAi.sent', { title: titleOf(sessionId) })),
  });
  return null;
}

// MobileWorkspace — the authed shell. I4 (layout A) has no tab bar: the feed is the root, its header opens the
// terminal, PC Control and a ⋯ menu (history, sessions, files, monitor, OpenClaw, theme, settings).
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
  agentCreateRecoveryStore,
  offlineChatCache = null,
}: {
  transport: WsEzTerminalTransport;
  /** Capacitor activity, independent of WebView visibility quirks. */
  appActive?: boolean;
  connectionUrl?: string;
  /** Smoothed link latency, or null before the first probe answers. */
  roundTripMs?: number | null;
  onDisconnect: () => void;
  readonly appUpdateController?: MobileAppUpdateController;
  /** Injectable Android Keystore-backed escrow; MobileWorkspace owns its lifecycle. */
  readonly agentCreateRecoveryStore?: MobileAgentCreateRecoveryStoreLike;
  readonly offlineChatCache?: MobileOfflineChatCache | null;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { text } = useShellText();
  const { preferences: uiPreferences } = useMobileUiPreferences();
  const pageVisible = usePageVisible();
  useProfileFeaturePreload(MOBILE_PRELOAD_LOADERS, uiPreferences.resourceProfile, true);
  const [tabsState, dispatch] = useReducer(tabsReducer, initialTabsState);
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  const [tab, setTab] = useState<MobileShellTab>('feed');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workflowNavigationTarget, setWorkflowNavigationTarget] = useState<{ subprojectId: string; nodeId?: string; runId?: string; key: string }>();
  // A project opened straight from the feed (▾, a flow card) goes back to the feed, not to the project list.
  const [projectDirect, setProjectDirect] = useState(false);
  // Where leaving a conversation opened from somewhere else goes (null: back to the conversation list).
  const [agentsExitTo, setAgentsExitTo] = useState<MobileShellTab | null>(null);
  // Counts the person's own moves, so a launch decision that arrives late never overrides one.
  const navigationCountRef = useRef(0);
  // The terminal agents the launch rule counts as waiting (set where they are filtered, below).
  const launchAgentsRef = useRef<AgentActivitySnapshot['items']>([]);
  const [restoreAuthority, setRestoreAuthority] = useState<string | null>(null);
  const restoredAuthorityRef = useRef<string | null>(null);
  const userNavigatedRef = useRef(false);
  const lastWorkTabRef = useRef<'terminal' | 'agents'>('terminal');
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<string | null>(null);
  // The terminal's AI input (I4): the app's conversations as a small store the terminal reads, and the
  // phone's own draft storage, PC access and principal for the box it shows.
  const terminalAiHostRef = useRef<ReturnType<typeof createTerminalAiHost> | null>(null);
  terminalAiHostRef.current ??= createTerminalAiHost({ openConversation: () => undefined, notifySent: () => undefined });
  const terminalAiHost = terminalAiHostRef.current;
  const terminalAiWiring = useMemo<TerminalAiWiring | undefined>(() => (typeof transport.getRemoteToken === 'function' ? {
    chatStateAccess: phoneChatStateAccess(transport),
    capabilities: createCapabilityAccess({ readCore: () => transport, readDesktop: () => undefined }),
    principal: PHONE_PRINCIPAL,
    start: {
      access: { history: transport, getSnapshot: () => transport.getDaemonSnapshot(), sendCommand: (command) => transport.sendDaemonCommand(command), principal: PHONE_PRINCIPAL },
      storage: phoneChatStateAccess(transport),
      capabilityClient: { list: transport.agentCapabilitiesList.bind(transport), manage: transport.agentCapabilitiesManage.bind(transport) },
    },
  } : undefined), [transport]);
  const [newConversationRequest, setNewConversationRequest] = useState(0);
  const [conversationHistoryRequest, setConversationHistoryRequest] = useState<{ readonly conversationId?: string; readonly projectId?: string; readonly key: string }>();
  const conversationHistoryReturnTab = useRef<'home' | 'feed'>('feed');
  const [terminalOpenError, setTerminalOpenError] = useState(false);
  const terminalOpeningRef = useRef(false);
  const [subPage, setSubPage] = useState<MobileSubPage | null>(null);
  const [sheet, setSheet] = useState<MobileSheet | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(() => loadTheme());
  const [agentSnapshot, setAgentSnapshot] = useState<AgentActivitySnapshot>(EMPTY_AGENT_ACTIVITY_SNAPSHOT);
  const [agentCoordinationSnapshot, setAgentCoordinationSnapshot] = useState<AgentCoordinationSnapshot>(
    EMPTY_AGENT_COORDINATION_SNAPSHOT,
  );
  const [agentOrchestrationSnapshot, setAgentOrchestrationSnapshot] = useState<AgentOrchestrationSnapshot>(
    EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  );
  const [daemonRuntimeState, setDaemonRuntimeState] = useState<DaemonRuntimeViewState>({
    status: offlineChatCache ? 'recovering' : 'loading',
    snapshot: offlineChatCache?.snapshot ?? null,
  });
  const recoveryStoreRef = useRef<MobileAgentCreateRecoveryStoreLike | null>(null);
  if (recoveryStoreRef.current === null) {
    recoveryStoreRef.current = agentCreateRecoveryStore ?? new MobileAgentCreateRecoveryStore();
  }
  const [agentCreateRecoveryState, setAgentCreateRecoveryState] = useState<{
    readonly status: MobileAgentCreateRecoveryStatus;
    readonly recovery: UncertainAgentCreate | null;
  }>({ status: 'loading', recovery: null });
  const agentCreateRecoveryStateRef = useRef(agentCreateRecoveryState);
  agentCreateRecoveryStateRef.current = agentCreateRecoveryState;
  const agentCreateRecoveryAuthorityRef = useRef<string | null>(null);
  const agentCreateRecoveryLoadGenerationRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [authGeneration, setAuthGeneration] = useState(0);
  const [connectedSince, setConnectedSince] = useState<number | null>(null);
  const updateAvailable = isAppUpdateAvailable(appUpdateController.snapshot);
  const [sessions, setSessions] = useState<readonly SessionInfo[]>([]);
  const [agentBootstraps, setAgentBootstraps] = useState<
    ReadonlyMap<string, AgentTerminalBootstrap>
  >(new Map());
  const themeReturnFocusRef = useRef<HTMLElement | null>(null);
  const sheetReturnFocusRef = useRef<HTMLElement | null>(null);
  const subPageReturnTargetRef = useRef('mobile-feed-more');
  const subPageReturnElementRef = useRef<HTMLElement | null>(null);
  const restoreTabFocusRef = useRef(false);
  const cwdMapRef = useRef(new Map<string, string>());

  const updateAgentCreateRecoveryState = useCallback((next: {
    readonly status: MobileAgentCreateRecoveryStatus;
    readonly recovery: UncertainAgentCreate | null;
  }): void => {
    agentCreateRecoveryStateRef.current = next;
    setAgentCreateRecoveryState(next);
  }, []);

  const reloadAgentCreateRecovery = useCallback<
    MobileAgentCreateRecoveryController['reload']
  >(async () => {
    const generation = agentCreateRecoveryLoadGenerationRef.current + 1;
    agentCreateRecoveryLoadGenerationRef.current = generation;
    agentCreateRecoveryAuthorityRef.current = null;
    updateAgentCreateRecoveryState({ status: 'loading', recovery: null });
    if (!connected || !transport.isAuthed) return false;
    try {
      const token = await transport.getRemoteToken();
      const authorityFingerprint = await mobileAgentCreateAuthorityFingerprint(token);
      agentCreateRecoveryAuthorityRef.current = authorityFingerprint;
      const result = await recoveryStoreRef.current!.load(authorityFingerprint);
      if (agentCreateRecoveryLoadGenerationRef.current !== generation) return false;
      if (!result.available) {
        updateAgentCreateRecoveryState({
          status: result.reason === 'invalid-record' ? 'invalid' : 'unavailable',
          recovery: null,
        });
        return false;
      }
      updateAgentCreateRecoveryState({ status: 'ready', recovery: result.recovery });
      if (result.recovery) {
        preloadOnIntent(MOBILE_FEATURE_LOADERS.agents);
        setSheet(null);
        setSubPage(null);
        setAgentsExitTo('feed');
        setTab('agents');
      }
      return true;
    } catch {
      if (agentCreateRecoveryLoadGenerationRef.current === generation) {
        updateAgentCreateRecoveryState({ status: 'unavailable', recovery: null });
      }
      return false;
    }
  }, [connected, transport, updateAgentCreateRecoveryState]);

  useEffect(() => {
    void reloadAgentCreateRecovery();
    return () => {
      agentCreateRecoveryLoadGenerationRef.current += 1;
      agentCreateRecoveryAuthorityRef.current = null;
    };
  }, [reloadAgentCreateRecovery]);

  const prepareAgentCreateRecovery = useCallback<
    MobileAgentCreateRecoveryController['prepare']
  >(async (command, draft) => {
    const authorityFingerprint = agentCreateRecoveryAuthorityRef.current;
    if (agentCreateRecoveryStateRef.current.status !== 'ready' || !authorityFingerprint) return false;
    try {
      const recovery = mobileAgentCreateRecoveryFromCommand(command, draft);
      await recoveryStoreRef.current!.save(recovery, authorityFingerprint);
      if (agentCreateRecoveryAuthorityRef.current !== authorityFingerprint) return false;
      updateAgentCreateRecoveryState({ status: 'ready', recovery });
      return true;
    } catch {
      if (agentCreateRecoveryAuthorityRef.current === authorityFingerprint) {
        const reconciled = await recoveryStoreRef.current!.load(authorityFingerprint).catch(() => null);
        if (agentCreateRecoveryAuthorityRef.current === authorityFingerprint) {
          updateAgentCreateRecoveryState(reconciled?.available
            ? { status: 'ready', recovery: reconciled.recovery }
            : {
                status: reconciled?.reason === 'invalid-record' ? 'invalid' : 'unavailable',
                recovery: null,
              });
        }
      }
      return false;
    }
  }, [updateAgentCreateRecoveryState]);

  const clearAgentCreateRecovery = useCallback<
    MobileAgentCreateRecoveryController['clear']
  >(async () => {
    const authorityFingerprint = agentCreateRecoveryAuthorityRef.current;
    if (!authorityFingerprint) return false;
    try {
      await recoveryStoreRef.current!.clear(authorityFingerprint);
      if (agentCreateRecoveryAuthorityRef.current !== authorityFingerprint) return false;
      updateAgentCreateRecoveryState({ status: 'ready', recovery: null });
      return true;
    } catch {
      if (agentCreateRecoveryAuthorityRef.current === authorityFingerprint) {
        const reconciled = await recoveryStoreRef.current!.load(authorityFingerprint).catch(() => null);
        if (agentCreateRecoveryAuthorityRef.current === authorityFingerprint) {
          updateAgentCreateRecoveryState(reconciled?.available
            ? { status: 'ready', recovery: reconciled.recovery }
            : {
                status: reconciled?.reason === 'invalid-record' ? 'invalid' : 'unavailable',
                recovery: null,
              });
        }
      }
      return false;
    }
  }, [updateAgentCreateRecoveryState]);

  const agentCreateRecovery = useMemo<MobileAgentCreateRecoveryController>(() => ({
    ...agentCreateRecoveryState,
    prepare: prepareAgentCreateRecovery,
    clear: clearAgentCreateRecovery,
    reload: reloadAgentCreateRecovery,
    discard: clearAgentCreateRecovery,
  }), [
    agentCreateRecoveryState,
    clearAgentCreateRecovery,
    prepareAgentCreateRecovery,
    reloadAgentCreateRecovery,
  ]);

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
    // The opener gets focus back; a menu item is gone by then, so its menu's trigger (returnTarget) does.
    subPageReturnElementRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;
    setSheet(null);
    setSubPage(next);
  }, []);

  const closeSubPage = useCallback(() => {
    restoreTabFocusRef.current = true;
    setSubPage(null);
  }, []);

  const selectTab = useCallback((next: MobileShellTab) => {
    userNavigatedRef.current = true;
    navigationCountRef.current += 1;
    if (next === 'agents') preloadOnIntent(MOBILE_FEATURE_LOADERS.agents);
    setSheet(null);
    setSubPage(null);
    setTab(next);
  }, []);

  useEffect(() => {
    if (subPage !== null || !restoreTabFocusRef.current) return;
    restoreTabFocusRef.current = false;
    const frame = requestAnimationFrame(() => {
      const opener = subPageReturnElementRef.current;
      subPageReturnElementRef.current = null;
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
      else document.querySelector<HTMLElement>(`[data-testid="${subPageReturnTargetRef.current}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [subPage]);

  useEffect(() => {
    const openTerminalKeySettings = (): void => {
      openSubPage('settings', 'mobile-feed-more');
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

  useEffect(() => {
    let alive = true;
    const apply = (snapshot: AgentActivitySnapshot): void => {
      // The transport is the revision/epoch authority. It already suppresses
      // stale snapshots within one desktop process and deliberately accepts
      // the first lower revision after reconnect as a new process epoch.
      if (alive) setAgentSnapshot(snapshot);
    };
    const unsubscribe = transport.onAgentActivitySnapshot(apply);
    // The subscription emits the cached state and every accepted response.
    // A pending read can resolve with the old cache during disconnect, then
    // run its Promise callback after a new desktop seed has already arrived.
    // Refresh through the transport without applying that result a second time.
    void transport.getAgentActivitySnapshot().catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [transport]);

  useEffect(() => {
    let alive = true;
    const unsubscribe = transport.onDaemonRuntimeState((state) => {
      if (alive) setDaemonRuntimeState((previous) => {
        // Authentication precedes the first daemon seed after a cold offline
        // restore. Keep the mounted project and its active editor through that
        // loading gap; an authoritative snapshot (including an empty one)
        // still replaces the cache immediately.
        const awaitingSeed = state.status === 'loading' || state.status === 'recovering';
        return !state.snapshot && previous.snapshot && (!transport.isAuthed || awaitingSeed)
          ? { ...state, status: 'recovering', snapshot: previous.snapshot } : state;
      });
      if (state.snapshot && state.status === 'ready' && transport.isAuthed) {
        void transport.getRemoteToken().then(mobileAgentCreateAuthorityFingerprint)
          .then((authority) => new MobileOfflineChatCacheStore().saveSnapshot(authority, state.snapshot!))
          .catch(() => undefined);
      }
    });
    transport.setDaemonEventsSubscribed(true);
    return () => {
      alive = false;
      unsubscribe();
      transport.setDaemonEventsSubscribed(false);
    };
  }, [transport]);

  useEffect(() => {
    if (!offlineChatCache || transport.isAuthed) return;
    setDaemonRuntimeState((previous) => previous.snapshot ? previous
      : { status: 'recovering', snapshot: offlineChatCache.snapshot });
    if (userNavigatedRef.current) return;
    const saved = readWorkspaceRestore(offlineChatCache.authorityFingerprint);
    if (saved?.activeAgentSessionId && lastSurfaceOf(saved) === 'chat'
      && offlineChatCache.snapshot.agents.some((agent) => agent.sessionId === saved.activeAgentSessionId)) {
      setActiveAgentSessionId(saved.activeAgentSessionId);
      setAgentsExitTo('feed');
      setTab('agents');
    }
  }, [offlineChatCache, transport]);

  useEffect(() => {
    let alive = true;
    const apply = (snapshot: AgentOrchestrationSnapshot): void => {
      if (alive) setAgentOrchestrationSnapshot(snapshot);
    };
    const unsubscribe = transport.onAgentOrchestrationSnapshot(apply);
    void transport.getAgentOrchestrationSnapshot().catch(() => undefined);
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
    void transport.getAgentCoordinationSnapshot().catch(() => undefined);
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
    userNavigatedRef.current = true;
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

  const createWorkspaceTerminal = useCallback(async (
    workspaceId: string,
  ): Promise<MobileWorkspaceTerminalResult> => {
    let snapshot: Awaited<ReturnType<WsEzTerminalTransport['getDaemonSnapshot']>>;
    try {
      snapshot = await transport.getDaemonSnapshot();
    } catch {
      return { ok: false, reason: 'authority-refresh-failed' };
    }
    if (!snapshot) {
      return { ok: false, reason: 'authority-unavailable' };
    }

    const workspace = snapshot.workspaces.find((entry) => (
      entry.id === workspaceId && entry.archivedAt === undefined
    ));
    const projectIsActive = workspace !== undefined && snapshot.projects.some((entry) => (
      entry.id === workspace.projectId && entry.archivedAt === undefined
    ));
    if (!workspace || !projectIsActive) {
      return { ok: false, reason: 'workspace-unavailable' };
    }
    if (workspace.rootPath.trim().length === 0) {
      return { ok: false, reason: 'workspace-root-unavailable' };
    }

    try {
      await openOwnedTab(workspace.rootPath);
    } catch {
      return { ok: false, reason: 'surface-open-failed' };
    }
    return { ok: true };
  }, [openOwnedTab, transport]);

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
    if (terminalOpeningRef.current) return;
    terminalOpeningRef.current = true;
    setTerminalOpenError(false);
    void openOwnedTab().catch(() => setTerminalOpenError(true))
      .finally(() => { terminalOpeningRef.current = false; });
  }, [openOwnedTab]);

  const openNewSession = quickNewTab;

  useEffect(() => {
    if (!connected || !transport.isAuthed) return;
    let cancelled = false;
    const connectedAt = Date.now();
    const movesAtStart = navigationCountRef.current;
    void (async () => {
      const authority = await mobileAgentCreateAuthorityFingerprint(await transport.getRemoteToken());
      if (cancelled || restoredAuthorityRef.current === authority) return;
      const saved = readWorkspaceRestore(authority);
      if (saved) {
        const restoredIds = new Set<string>();
        for (const sessionId of saved.terminalSessionIds) {
          if (cancelled) return;
          if (tabsStateRef.current.tabs.some((entry) => entry.sessionId === sessionId)) { restoredIds.add(sessionId); continue; }
          const result = await transport.openSessionSurface(nextMobileSurfaceId(), { kind: 'adopt', sessionId }).catch(() => null);
          if (cancelled) {
            if (result?.ok) void transport.releaseSessionSurface(result.binding.bindingId).catch(() => undefined);
            return;
          }
          if (result?.ok) { restoredIds.add(sessionId); dispatch({ type: 'open', binding: result.binding }); }
        }
        if (!userNavigatedRef.current && saved.activeTerminalSessionId) dispatch({ type: 'activate', sessionId: saved.activeTerminalSessionId });
        // The PC answers at once; one that does not within the launch budget leaves the app on the feed.
        let budget: ReturnType<typeof setTimeout> | undefined;
        const snapshot = await Promise.race([
          transport.getDaemonSnapshot().catch(() => null),
          new Promise<null>((resolve) => { budget = setTimeout(() => resolve(null), Math.max(0, LAUNCH_DECISION_MS - (Date.now() - connectedAt))); }),
        ]).finally(() => clearTimeout(budget));
        if (cancelled) return;
        const agentId = snapshot?.agents.some((agent) => agent.sessionId === saved.activeAgentSessionId)
          ? saved.activeAgentSessionId : null;
        if (!userNavigatedRef.current && !agentCreateRecoveryStateRef.current.recovery) {
          setActiveAgentSessionId(agentId);
          // What waits first, then the terminal or conversation left; a decision ready too late is not applied.
          const next = launchSurface({
            waiting: feedBadgeCount(snapshot, launchAgentsRef.current),
            last: lastSurfaceOf(saved),
            terminalRestored: saved.activeTerminalSessionId ? restoredIds.has(saved.activeTerminalSessionId) : restoredIds.size > 0,
            conversationExists: agentId !== null,
          });
          if (navigationCountRef.current === movesAtStart && Date.now() - connectedAt <= LAUNCH_DECISION_MS) {
            if (next === 'agents') setAgentsExitTo('feed');
            setTab(next);
          }
        }
      }
      if (!cancelled) { restoredAuthorityRef.current = authority; setRestoreAuthority(authority); }
    })().catch(() => { /* Terminal creation remains available when optional restoration fails. */ });
    return () => { cancelled = true; };
  }, [connected, transport]);

  useEffect(() => {
    if (tab === 'terminal' || tab === 'agents') lastWorkTabRef.current = tab;
    const authority = restoreAuthority ?? offlineChatCache?.authorityFingerprint;
    if (!authority) return;
    const previous = readWorkspaceRestore(authority);
    // Until this run has restored (or the person moved), the surface left last time is kept, not the feed shown meanwhile.
    const settled = restoreAuthority !== null || userNavigatedRef.current;
    writeWorkspaceRestore(authority, {
      terminalSessionIds: connected ? tabsState.tabs.map((entry) => entry.sessionId) : previous?.terminalSessionIds ?? [],
      activeTerminalSessionId: connected ? tabsState.activeSessionId : previous?.activeTerminalSessionId ?? null,
      activeAgentSessionId,
      destination: lastWorkTabRef.current,
      lastSurface: settled || !previous ? surfaceOf(tab) : lastSurfaceOf(previous),
    });
  }, [restoreAuthority, offlineChatCache?.authorityFingerprint, connected, tabsState, tab, activeAgentSessionId]);

  // Back from a suspend (30 s or more in the background drops the link): when something waits, the feed shows it once
  // the link is back, unless the person moved first. A short trip to another app changes nothing.
  const backgroundSinceRef = useRef<number | null>(null);
  const resumedFromSuspendRef = useRef(false);
  useEffect(() => {
    if (!appActive) { backgroundSinceRef.current ??= Date.now(); return; }
    const since = backgroundSinceRef.current;
    backgroundSinceRef.current = null;
    if (since !== null && Date.now() - since >= MOBILE_BACKGROUND_SUSPEND_MS) resumedFromSuspendRef.current = true;
  }, [appActive]);
  useEffect(() => {
    if (!connected || !transport.isAuthed || !resumedFromSuspendRef.current) return;
    resumedFromSuspendRef.current = false;
    const reconnectedAt = Date.now();
    const movesAtStart = navigationCountRef.current;
    let cancelled = false;
    void transport.getDaemonSnapshot().catch(() => null).then((snapshot) => {
      if (cancelled || navigationCountRef.current !== movesAtStart || Date.now() - reconnectedAt > LAUNCH_DECISION_MS) return;
      if (feedBadgeCount(snapshot, launchAgentsRef.current) === 0) return;
      setSheet(null);
      setSubPage(null);
      setTab('feed');
    });
    return () => { cancelled = true; };
  }, [authGeneration, connected, transport]);

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

  const orchestrationWorkerIds = useMemo(
    () => orchestrationWorkerActivityIds(agentOrchestrationSnapshot),
    [agentOrchestrationSnapshot],
  );
  const userFacingAgentSnapshot = useMemo<AgentActivitySnapshot>(() => ({
    ...agentSnapshot,
    items: agentSnapshot.items.filter((item) => !orchestrationWorkerIds.has(item.id)),
  }), [agentSnapshot, orchestrationWorkerIds]);
  // What waits is read from the connected PC only (a cached approval cannot be answered); the badge counts the feed's
  // cards, the same rule as the desktop board's (an older PC: conversation approvals and blocked terminal agents).
  const liveDaemon = connected && transport.isAuthed ? daemonRuntimeState.snapshot : null;
  launchAgentsRef.current = userFacingAgentSnapshot.items;
  const [feedAuthority, setFeedAuthority] = useState<string | null>(offlineChatCache?.authorityFingerprint ?? null);
  useEffect(() => {
    if (!connected || !transport.isAuthed) return;
    let alive = true;
    void transport.getRemoteToken().then(mobileAgentCreateAuthorityFingerprint)
      .then((authority) => { if (alive) setFeedAuthority(authority); }).catch(() => undefined);
    return () => { alive = false; };
  }, [connected, transport]);
  const feed = useFeedData({
    transport,
    daemon: daemonRuntimeState.snapshot,
    liveDaemon,
    terminalAgents: userFacingAgentSnapshot.items,
    connected: connected && transport.isAuthed,
    active: tab === 'feed' && subPage === null && appActive,
    authority: feedAuthority,
  });
  const waitingCount = feed.waiting.length;
  // The AI input needs a PC that lists conversations and starts them from the phone (protocol 16), the
  // phone's secure storage and a live connection; otherwise the terminal stays a shell.
  const terminalAiReady = Boolean(terminalAiWiring) && connected && transport.isAuthed
    && (transport.negotiatedRemoteProtocolVersion ?? 0) >= 16;
  useEffect(() => {
    terminalAiHost.set(terminalAiReady ? daemonRuntimeState.snapshot ?? null : null);
  }, [daemonRuntimeState.snapshot, terminalAiHost, terminalAiReady]);

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

  /** A conversation (or, with null, the list); leaving it returns to `from`. */
  const openConversation = (sessionId: string | null, from: MobileShellTab | null): void => {
    setActiveAgentSessionId(sessionId);
    setAgentsExitTo(from);
    selectTab('agents');
  };
  const openNewConversation = (projectId: string | null): void => {
    setSelectedProjectId(projectId);
    setActiveAgentSessionId(null);
    setNewConversationRequest(Date.now());
    setAgentsExitTo('feed');
    selectTab('agents');
  };
  /** A project's screen (or, with null, the project list), at a flow and its stage or run when given. */
  const openProjectScreen = (projectId: string | null, target?: { subprojectId: string; nodeId?: string; runId?: string }): void => {
    setSelectedProjectId(projectId);
    setProjectDirect(projectId !== null);
    setWorkflowNavigationTarget(target ? { ...target, key: crypto.randomUUID() } : undefined);
    selectTab('home');
  };
  const openFeedWaiting = (item: FeedWaitingItem): void => {
    if (item.kind === 'flow-approval' && item.projectId && item.flow) {
      openProjectScreen(item.projectId, item.flow);
      return;
    }
    if (item.kind === 'terminal-agent') {
      const activity = agentSnapshot.items.find((entry) => entry.id === item.activityId);
      if (activity) void transport.markAgentSeen(activity.id, activity.stateSeq);
      if (activity?.sessionId) void adoptAndOpenTab(activity.sessionId).catch(() => setTerminalOpenError(true));
      return;
    }
    if (item.sessionId) openConversation(item.sessionId, 'feed');
  };
  const openFeedHistory = (): void => {
    conversationHistoryReturnTab.current = 'feed';
    setConversationHistoryRequest({ key: crypto.randomUUID() });
    openConversation(null, null);
  };
  const feedMoreTrigger = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="mobile-feed-more"]');
  const hostLabel = [formatEndpointHost(connectionUrl), connected && roundTripMs !== null ? `${Math.round(roundTripMs)}ms` : null]
    .filter(Boolean).join(' · ') || text('PC', 'PC');
  const feedHeaderActions = (
    <span className="mob-feed__actions">
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" onClick={() => selectTab('terminal')}
        aria-label={t('mobile.terminal')} data-testid="mobile-feed-terminal"><Glyph name="term" size={20} /></button>
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" onClick={() => openSubPage('pc-control', 'mobile-feed-pc')}
        aria-label={t('mobile.tabs.pc')} data-testid="mobile-feed-pc"><Glyph name="pc" size={20} /></button>
      <Menu
        label={t('mobile.tabs.more')}
        placement="bottom-end"
        trigger={(
          <button type="button" className="mob-icon-btn mob-icon-btn--plate mob-feed__more-btn" data-testid="mobile-feed-more"
            aria-label={updateAvailable ? `${t('mobile.tabs.more')}. ${t('settings.update.badge')}` : t('mobile.tabs.more')}>
            <Glyph name="more" size={20} />
            {updateAvailable && <span className="mob-feed__update-dot" aria-hidden="true" />}
          </button>
        )}
      >
        <MenuItem icon={glyphIcon('clock')} onSelect={openFeedHistory} data-testid="more-history">{text('이전 대화 · CLI 기록', 'Past conversations · CLI history')}</MenuItem>
        <MenuItem icon={glyphIcon('list')} onSelect={() => openSubPage('sessions', 'mobile-feed-more')} data-testid="more-sessions">{t('mobile.sessions')}</MenuItem>
        <MenuItem icon={glyphIcon('file')} onSelect={() => openSubPage('files', 'mobile-feed-more')} data-testid="more-files">{t('mobile.files')}</MenuItem>
        <MenuItem icon={glyphIcon('mon')} onSelect={() => openSubPage('stats', 'mobile-feed-more')} data-testid="more-stats">{t('mobile.moreActions.stats')}</MenuItem>
        {effectiveOpenClawVisible && (
          <MenuItem icon={glyphIcon('claw')} onSelect={() => openSubPage('openclaw', 'mobile-feed-more')} data-testid="more-openclaw">
            OpenClaw · <span data-testid="more-openclaw-state">{openclawState ? t(OPENCLAW_STATE_LABEL_KEY[openclawState.state]) : t('mobile.moreActions.checking')}</span>
          </MenuItem>
        )}
        <MenuItem icon={glyphIcon('palette')} onSelect={() => { themeReturnFocusRef.current = feedMoreTrigger(); setThemeMenuOpen(true); }} data-testid="more-theme">{t('mobile.moreActions.theme')}</MenuItem>
        <MenuItem icon={glyphIcon('set')} onSelect={() => openSubPage('settings', 'mobile-feed-more')} data-testid="more-settings">
          {updateAvailable ? `${t('common.settings')} · ${t('settings.update.badge')}` : t('common.settings')}
        </MenuItem>
      </Menu>
    </span>
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
  } else if (tab === 'agents') {
    page = (
      <LazyFeature
        loader={MOBILE_FEATURE_LOADERS.agents}
        componentProps={{
          snapshot: agentSnapshot,
          coordinationSnapshot: agentCoordinationSnapshot,
          orchestrationSnapshot: agentOrchestrationSnapshot,
          daemonRuntimeState,
          structuredTranscripts: offlineChatCache?.transcripts,
          disconnected: !connected,
          onBack: () => selectTab('feed'),
          onSendFollowup: (activityId, text) => transport.sendAgentFollowup(activityId, text),
          onDecideApproval: (activityId, approvalId, decision) =>
            transport.decideAgentApproval(activityId, approvalId, decision),
          onLoadDiff: (directory) => transport.getGitDiff(directory),
          onReadGitStatus: (directory) => transport.getGitStatus(directory),
          onResumeHistory: startAgentBootstrap,
          onLaunchAgent: startAgentBootstrap,
          onCreateWorkspaceTerminal: createWorkspaceTerminal,
          onCreateLocalTerminal: async () => {
            try { await openOwnedTab(); return { ok: true as const }; }
            catch { return { ok: false as const, message: t('sessionNavigation.openFailed') }; }
          },
          agentCreateRecovery,
          initialSessionId: activeAgentSessionId,
          newSessionRequest: newConversationRequest,
          onNewSessionRequestConsumed: () => setNewConversationRequest(0),
          historyRequest: conversationHistoryRequest,
          onHistoryRequestConsumed: () => setConversationHistoryRequest(undefined),
          onHistoryRequestClosed: () => selectTab(conversationHistoryReturnTab.current),
          ...(agentsExitTo ? { onDetailExit: () => selectTab(agentsExitTo) } : {}),
          projectId: selectedProjectId,
          onOpenWorkflow: (projectId: string, subprojectId: string, nodeId?: string) => {
            openProjectScreen(projectId, { subprojectId, ...(nodeId ? { nodeId } : {}) });
          },
          onProjectFilterChange: setSelectedProjectId,
          flatConversations: true,
          onActiveSessionChange: setActiveAgentSessionId,
          transport,
          onFocusSession: (sessionId) => {
            const activity = agentSnapshot.items.find((item) => item.sessionId === sessionId);
            if (activity) void transport.markAgentSeen(activity.id, activity.stateSeq);
            const structuredSession = daemonRuntimeState.snapshot?.sessions.find((session) => (
              session.id === sessionId && session.kind === 'agent' && session.source === 'structured'
            ));
            if (structuredSession) return;
            void adoptAndOpenTab(sessionId);
          },
        }}
        loading={auxiliaryPageFallback}
        errorMessage={t('common.featureLoadFailed')}
        retryLabel={t('common.retry')}
        closeLabel={t('common.close')}
        onClose={() => selectTab('feed')}
      />
    );
  } else if (tab === 'feed') {
    page = (
      <MobileFeedView
        projects={feed.projects}
        scope={feed.scope}
        onScopeChange={feed.setScope}
        host={{ tone: connected && transport.isAuthed ? 'on' : 'idle', label: hostLabel }}
        headerActions={feedHeaderActions}
        waiting={feed.waiting}
        flows={feed.flows}
        flowsAvailable={feed.flowsAvailable}
        conversations={feed.conversations}
        usage={feed.usage}
        onDecide={(item, decision) => decideFeedItem(transport, item, decision)}
        onOpenWaiting={openFeedWaiting}
        onOpenConversation={(sessionId) => openConversation(sessionId, 'feed')}
        onOpenFlow={(flow) => openProjectScreen(flow.projectId, { subprojectId: flow.subprojectId })}
        onSeeAllConversations={() => { setSelectedProjectId(feed.scope); openConversation(null, null); }}
        onNewConversation={() => openNewConversation(feed.scope)}
        onOpenProjectScreen={(projectId) => openProjectScreen(projectId)}
      />
    );
  }

  return (
    <MobileToastProvider>
      <TerminalAiNotices
        host={terminalAiHost}
        titleOf={(sessionId) => daemonRuntimeState.snapshot?.sessions.find((session) => session.id === sessionId)?.title ?? ''}
        openConversation={(sessionId) => openConversation(sessionId, 'terminal')}
      />
      <MobileWorkbenchCoordinator
        terminalActive={tab === 'terminal' && subPage === null}
        destinationActive={subPage !== null}
        tabRootActive={tab !== 'feed'}
        onRequestRoot={closeSubPage}
        onRequestTabRoot={() => setTab('feed')}
        page={<>
          <div hidden={subPage !== null || tab !== 'home'} className="mobile-workflow-persistent">
            <MobilePlanningNavigator state={daemonRuntimeState} transport={transport} connected={connected}
              active={subPage === null && tab === 'home'}
              navigationTarget={workflowNavigationTarget}
              mode="projects" projectId={selectedProjectId}
              onSelectProject={(projectId) => { setSelectedProjectId(projectId); setProjectDirect(false); }}
              onBack={() => selectTab('feed')}
              {...(projectDirect ? { onProjectExit: () => selectTab('feed') } : {})}
              onOpenChat={sessionId => {
                if (!sessionId) setNewConversationRequest(Date.now());
                openConversation(sessionId ?? null, 'home');
              }}
              onOpenConversationHistory={entry => {
                conversationHistoryReturnTab.current = 'home';
                setConversationHistoryRequest({ conversationId: entry.conversationId, projectId: entry.projectId, key: crypto.randomUUID() });
                openConversation(null, null);
              }}
              onOpenHistory={projectId => {
                conversationHistoryReturnTab.current = 'home';
                setConversationHistoryRequest({ projectId, key: crypto.randomUUID() });
                openConversation(null, null);
              }}
              onOpenFiles={() => openSubPage('files', 'mobile-feed-more')}
              onOpenTerminal={workspaceId => { if (workspaceId) return createWorkspaceTerminal(workspaceId); selectTab('terminal'); }}
              onOpenPcControl={() => openSubPage('pc-control', 'mobile-feed-pc')}
            />
          </div>
          {page}
        </>}
        terminal={(
          <div className="mobile-workspace" data-testid="mobile-workspace">
            <header
              className="mob-term-head"
              onTouchStart={onHeaderTouchStart}
              onTouchEnd={onHeaderTouchEnd}
            >
              <button
                type="button"
                className="mob-icon-btn mob-term-head__feed"
                onClick={() => selectTab('feed')}
                aria-label={waitingCount > 0
                  ? text(`피드 · 기다리는 것 ${waitingCount}`, `Feed · ${waitingCount} waiting`)
                  : text('피드', 'Feed')}
                data-testid="workspace-hub-btn"
              >
                <Glyph name="back" size={20} />
                {waitingCount > 0 && <span className="mob-term-head__badge" data-testid="mobile-waiting-badge" aria-hidden="true">{waitingCount}</span>}
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
            {terminalOpenError && <p role="alert">{t('sessionNavigation.openFailed')} <button type="button" className="mob-cta" onClick={quickNewTab}>{t('common.retry')}</button></p>}
            {tabsState.tabs.length === 0 && (
              <div className="mobile-terminal-empty" data-testid="mobile-terminal-empty">
                <div>
                  <h1>{t('mobile.noTerminalTabs')}</h1>
                  <p>{t('mobile.noTerminalTabsHint')}</p>
                </div>
                <div className="mobile-terminal-empty-actions">
                  <button type="button" className="mob-cta" onClick={openNewSession} disabled={!connected}>
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
                  agentActivitySnapshot={agentSnapshot}
                  agentOrchestrationSnapshot={agentOrchestrationSnapshot}
                  onSessionDead={() => handleSessionDead(entry.sessionId)}
                  onCwdChange={handleCwdChange}
                  onReadGitStatus={(directory) => transport.getGitStatus(directory)}
                  roundTripMs={roundTripMs}
                  aiHost={terminalAiReady ? terminalAiHost : null}
                  {...(terminalAiWiring ? { aiWiring: terminalAiWiring } : {})}
                  onCloseTab={() => closeTab(entry.sessionId)}
                />
              </div>
            ))}
          </div>
        )}
        overlays={(
          <>
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
                  openNewSession();
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
