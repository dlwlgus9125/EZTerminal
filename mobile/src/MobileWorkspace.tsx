import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Bot, Ellipsis, Files, List, Plus } from 'lucide-react';

import type { OpenClawMode, ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { EMPTY_AGENT_ACTIVITY_SNAPSHOT, type AgentActivitySnapshot } from '../../src/shared/agent';
import { useAppTranslation } from '../../src/renderer/i18n';
import { quoteEzArgument } from '../../src/shared/quote-ez-argument';
import { insertIntoPaneInput } from '../../src/renderer/pane-registry';
import { Button, IconButton } from '../../src/renderer/ui/Button';
import { e2eLog } from './e2e-telemetry';
import { MobileHeaderMoreActions } from './MobileHeaderMoreActions';
import { MobileSessionView } from './MobileSessionView';
import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';
import { loadOpenClawMode, saveOpenClawMode } from './openclaw-mode';
import { mobileTerminalPanelId, mobileTerminalTabId, TabStrip } from './TabStrip';
import { ThemeMenu } from './ThemeMenu';
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  OPEN_TERMINAL_KEY_SETTINGS_EVENT,
} from './terminal-accessory-layout';
import { applyTheme, loadTheme, saveTheme } from './theme';
import { initialTabsState, tabsReducer } from './tabs';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';
import { usePageVisible } from './use-page-visible';

const AgentHub = lazy(async () => ({ default: (await import('../../src/renderer/AgentHub')).AgentHub }));
const MobileFileView = lazy(async () => ({ default: (await import('./MobileFileView')).MobileFileView }));
const MobileOpenClawView = lazy(async () => ({ default: (await import('./MobileOpenClawView')).MobileOpenClawView }));
const MobileSettingsView = lazy(async () => ({ default: (await import('./MobileSettingsView')).MobileSettingsView }));
const MobileStatsView = lazy(async () => ({ default: (await import('./MobileStatsView')).MobileStatsView }));
const SessionSwitcher = lazy(async () => ({ default: (await import('./SessionSwitcher')).SessionSwitcher }));

function countAgentAttention(snapshot: AgentActivitySnapshot): number {
  return snapshot.items.filter((item) => item.status === 'blocked' || item.status === 'error' || item.status === 'waiting').length;
}

// MobileWorkspace — the authed shell (M5, mobile-parity plan D5). Replaces
// App.tsx's old direct SessionSwitcher <-> MobileSessionView switching: this
// owns multi-tab state (tabsReducer), which of possibly several open
// sessions is active, the full-screen stats overlay, and the theme menu
// (moved here from MobileSessionView/SessionSwitcher so there's exactly one
// owner for the whole authed shell).
//
// KEEP-ALIVE: every open tab's MobileSessionView stays MOUNTED for as long as
// its tab exists — switching tabs only toggles `display: none` on the
// wrapper div, it never unmounts. This is deliberate: a fresh mount would
// tear down that tab's BlockController(s)/FakeMessagePort and lose the
// running PTY stream's UI state. `display:none` keeps React state alive (and
// the compile-time E2E output probe active); the one thing it
// breaks is xterm's internal measurement of a now-zero-size container, which
// is why activating a tab dispatches a `resize` event on the next animation
// frame — xterm/any ResizeObserver-driven view re-measures once it's visible
// again. (Mobile renders PtyBlock/xterm too, via the shared Block.tsx — this
// keep-alive is what makes that survive tab switches, per the mobile-parity
// plan's risk #1.)
//
// Zero-tab state: renders `SessionSwitcher variant="page"` as the ENTIRE
// screen (no workspace header above it) — it must stay in normal document
// flow, not a fixed overlay, so Android's uiautomator accessibility dump can
// see '+ New Session' with no real DOM access (see mobile/e2e/smoke.ts's
// header comment). The More-actions variant is a fixed bottom sheet instead,
// a convenience surface used only once tabs already exist.
export function MobileWorkspace({
  transport,
  connectionUrl = '',
  onDisconnect,
}: {
  transport: WsEzTerminalTransport;
  connectionUrl?: string;
  onDisconnect: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [tabsState, dispatch] = useReducer(tabsReducer, initialTabsState);
  const [view, setView] = useState<'terminal' | 'sessions' | 'agents' | 'stats' | 'files' | 'settings' | 'openclaw'>('terminal');
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [wideHeader, setWideHeader] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 600);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(() => loadTheme());
  const [agentSnapshot, setAgentSnapshot] = useState<AgentActivitySnapshot>(EMPTY_AGENT_ACTIVITY_SNAPSHOT);
  const [connected, setConnected] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const update = (): void => setWideHeader(window.innerWidth >= 600);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const openTerminalKeySettings = (): void => {
      setMoreActionsOpen(false);
      setView('settings');
    };
    window.addEventListener(OPEN_TERMINAL_KEY_SETTINGS_EVENT, openTerminalKeySettings);
    return () => window.removeEventListener(OPEN_TERMINAL_KEY_SETTINGS_EVENT, openTerminalKeySettings);
  }, []);

  useEffect(() => transport.onAuthChange(setConnected), [transport]);

  useEffect(() => {
    let alive = true;
    const apply = (snapshot: AgentActivitySnapshot): void => {
      if (alive) setAgentSnapshot((current) => snapshot.revision >= current.revision ? snapshot : current);
    };
    const unsubscribe = transport.onAgentActivitySnapshot(apply);
    void transport.getAgentActivitySnapshot().then(apply).catch(() => undefined);
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
  const openClawStatusPending = effectiveOpenClawVisible
    && (!openclawState || openclawState.state === 'starting' || openclawState.state === 'unknown');

  // Background pause (openclaw-stabilization M6): the status push otherwise
  // keeps flowing over WS every 4s while the app sits backgrounded, burning
  // battery for nobody. Combined into the acquire/release effect below —
  // the M3/M4 refcount (see ws-ezterminal.ts's `openclawStatusRefcount` doc)
  // makes releasing on hide and re-acquiring on show safe.
  const pageVisible = usePageVisible();

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
  const cwdMapRef = useRef(new Map<string, string>());
  const handleCwdChange = useCallback((sessionId: string, cwd: string) => {
    cwdMapRef.current.set(sessionId, cwd);
  }, []);

  const handleThemeSelect = useCallback((name: ThemeName) => {
    applyTheme(name);
    saveTheme(name);
    setCurrentTheme(name);
  }, []);

  const openTab = useCallback((sessionId: string, cwd: string) => {
    dispatch({ type: 'open', sessionId, cwd });
    setView('terminal');
  }, []);

  useEffect(() => {
    return transport.onWorktreeOpenRequested((worktree) => {
      void transport
        .createSession(worktree.path)
        .then((info) => openTab(info.sessionId, info.cwd))
        .catch((err: unknown) => console.error('[mobile] worktree tab creation failed:', err));
    });
  }, [openTab, transport]);

  const activateTab = useCallback((sessionId: string) => {
    dispatch({ type: 'activate', sessionId });
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    dispatch({ type: 'close', sessionId });
    cwdMapRef.current.delete(sessionId);
  }, []);

  const handleSessionDead = useCallback((sessionId: string) => {
    dispatch({ type: 'sessionDied', sessionId });
    cwdMapRef.current.delete(sessionId);
  }, []);

  const quickNewTab = useCallback(() => {
    void transport.createSession().then((info) => openTab(info.sessionId, info.cwd));
  }, [transport, openTab]);

  // File-explorer drawer's "open terminal here" (M4): a fresh tab whose
  // session starts in `dirPath` — mirrors `quickNewTab`, cwd threaded through.
  const onOpenTerminalAt = useCallback(
    (dirPath: string) => {
      void transport.createSession(dirPath).then((info) => openTab(info.sessionId, info.cwd));
    },
    [transport, openTab],
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

  const auxiliaryPageFallback = (
    <div className="status-loading mobile-auxiliary-page-loading" role="status" data-testid="mobile-auxiliary-page-loading">
      {t('common.loading')}
    </div>
  );

  let page: JSX.Element | undefined;
  if (view === 'sessions') {
    page = (
      <SessionSwitcher
        variant="page"
        transport={transport}
        onSelect={openTab}
        onDisconnect={onDisconnect}
      />
    );
  } else if (view === 'stats') {
    page = <MobileStatsView onClose={() => setView('terminal')} />;
  } else if (view === 'agents') {
    page = (
      <AgentHub
        mobile
        snapshot={agentSnapshot}
        disconnected={!connected}
        onClose={() => setView('terminal')}
        onSendFollowup={(activityId, text) => transport.sendAgentFollowup(activityId, text)}
        onFocusSession={(sessionId) => {
          const activity = agentSnapshot.items.find((item) => item.sessionId === sessionId);
          openTab(sessionId, activity?.cwd ?? '');
        }}
      />
    );
  } else if (view === 'openclaw') {
    page = (
      <MobileOpenClawView
        transport={transport}
        onClose={() => setView('terminal')}
        openclawAvailable={openclawAvailable}
      />
    );
  } else if (view === 'settings') {
    page = (
      <MobileSettingsView
        connectionUrl={connectionUrl}
        onClose={() => setView('terminal')}
        onDisconnect={onDisconnect}
        openclawMode={openclawMode}
        onOpenClawModeChange={handleOpenClawModeChange}
      />
    );
  } else if (view === 'files') {
    page = (
      <MobileFileView
        transport={transport}
        initialPath={initialFilePath}
        onClose={() => setView('terminal')}
        onOpenTerminalAt={onOpenTerminalAt}
        onPastePath={onPastePath}
      />
    );
  }

  return (
    <MobileWorkbenchCoordinator
      onRequestTerminal={() => setView('terminal')}
      page={page ? <Suspense fallback={auxiliaryPageFallback}>{page}</Suspense> : undefined}
      terminal={<div className="mobile-workspace" data-testid="mobile-workspace">
      <header className="workspace-header">
        <TabStrip
          tabs={tabsState.tabs}
          activeSessionId={tabsState.activeSessionId}
          onActivate={activateTab}
          onClose={closeTab}
        />
        <Button
          type="button"
          className="workspace-new-tab-btn"
          size="sm"
          variant="secondary"
          leadingIcon={<Plus />}
          onClick={quickNewTab}
          disabled={!connected}
          aria-label={t('mobile.newTab')}
          data-testid="tab-add-btn"
        >
          <span className="workspace-action-label">{t('mobile.newTerminal')}</span>
        </Button>
        <Button
          type="button"
          className="workspace-menu-btn workspace-wide-action"
          size="sm"
          variant="secondary"
          leadingIcon={<List />}
          onClick={() => setView('sessions')}
          disabled={!connected}
          aria-label={t('mobile.sessions')}
          data-testid="menu-btn"
        >
          <span className="workspace-action-label">{t('mobile.sessions')}</span>
        </Button>
        <Button
          type="button"
          className="files-btn workspace-wide-action"
          size="sm"
          variant="secondary"
          leadingIcon={<Files />}
          onClick={() => setView('files')}
          disabled={!connected}
          aria-label={t('mobile.files')}
          data-testid="files-btn"
        >
          <span className="workspace-action-label">{t('mobile.files')}</span>
        </Button>
        <Button
          type="button"
          className="agents-btn"
          size="sm"
          variant="secondary"
          leadingIcon={<Bot />}
          onClick={() => setView('agents')}
          aria-label={t('mobile.agents')}
          data-testid="agents-btn"
        >
          <span className="workspace-action-label">{t('mobile.agents')}</span>
          {countAgentAttention(agentSnapshot) > 0 && (
            <span className="agent-unread-badge">{countAgentAttention(agentSnapshot)}</span>
          )}
        </Button>
        <span className="workspace-more-control">
          <IconButton
            ref={moreButtonRef}
            type="button"
            className="workspace-more-btn"
            size="sm"
            variant="secondary"
            icon={Ellipsis}
            onClick={() => setMoreActionsOpen(true)}
            aria-label={openClawStatusPending ? t('mobile.openMorePending') : t('mobile.openMore')}
            title={t('mobile.openMore')}
            aria-haspopup="dialog"
            aria-expanded={moreActionsOpen}
            aria-controls={moreActionsOpen ? 'workspace-more-actions' : undefined}
            data-testid="workspace-more-btn"
          />
          {openClawStatusPending && <span className="workspace-more-status-dot" aria-hidden="true" />}
        </span>
      </header>

      {tabsState.tabs.length === 0 && (
        <div className="mobile-terminal-empty" data-testid="mobile-terminal-empty">
          <div>
            <h1>{t('mobile.noTerminalTabs')}</h1>
            <p>{t('mobile.noTerminalTabsHint')}</p>
          </div>
          <div className="mobile-terminal-empty-actions">
            <button type="button" className="btn btn-run" onClick={quickNewTab} disabled={!connected}>
              <Plus aria-hidden="true" /> {t('mobile.newTerminal')}
            </button>
            <button type="button" className="btn" onClick={() => setView('sessions')}>
              <List aria-hidden="true" /> {t('mobile.sessions')}
            </button>
            <button type="button" className="btn" onClick={() => setView('settings')}>
              {t('common.settings')}
            </button>
          </div>
        </div>
      )}

      {tabsState.tabs.map((tab) => (
        <div
          key={tab.sessionId}
          id={mobileTerminalPanelId(tab.sessionId)}
          className="tab-page"
          role="tabpanel"
          aria-labelledby={mobileTerminalTabId(tab.sessionId)}
          tabIndex={0}
          style={{ display: tab.sessionId === tabsState.activeSessionId ? undefined : 'none' }}
        >
          <MobileSessionView
            sessionId={tab.sessionId}
            active={tab.sessionId === tabsState.activeSessionId}
            quickCommandSource={transport}
            quickCommandsSupported={transport.supportsRemoteQuickCommands}
            connected={connected}
            onSessionDead={() => handleSessionDead(tab.sessionId)}
            onCwdChange={handleCwdChange}
          />
        </div>
      ))}

      </div>}
      overlays={<>
      {moreActionsOpen && (
        <div id="workspace-more-actions">
          <MobileHeaderMoreActions
            wide={wideHeader}
            connected={connected}
            themeName={currentTheme}
            openclawVisible={effectiveOpenClawVisible}
            openclawState={openclawState?.state}
            triggerRef={moreButtonRef}
            onClose={() => setMoreActionsOpen(false)}
            onOpenSessions={() => setView('sessions')}
            onOpenFiles={() => setView('files')}
            onOpenStats={() => setView('stats')}
            onOpenTheme={() => setThemeMenuOpen(true)}
            onOpenClaw={() => setView('openclaw')}
            onOpenSettings={() => setView('settings')}
          />
        </div>
      )}

      <ThemeMenu
        open={themeMenuOpen}
        current={currentTheme}
        onSelect={handleThemeSelect}
        onClose={() => setThemeMenuOpen(false)}
        returnFocusRef={moreButtonRef}
      />
      </>}
    />
  );
}
