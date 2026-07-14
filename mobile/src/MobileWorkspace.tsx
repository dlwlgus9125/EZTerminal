import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { OpenClawMode, ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { EMPTY_AGENT_ACTIVITY_SNAPSHOT, type AgentActivitySnapshot } from '../../src/shared/agent';
import { AgentHub, countAgentAttention } from '../../src/renderer/AgentHub';
import { quoteEzArgument } from '../../src/shared/quote-ez-argument';
import { insertIntoPaneInput } from '../../src/renderer/pane-registry';
import { setUserFontId } from '../../src/renderer/theme-runtime';
import { MobileFileView } from './MobileFileView';
import { MobileHeaderMoreActions } from './MobileHeaderMoreActions';
import { MobileOpenClawView } from './MobileOpenClawView';
import { MobileSessionView } from './MobileSessionView';
import { MobileSettingsView } from './MobileSettingsView';
import { MobileStatsView } from './MobileStatsView';
import { loadOpenClawMode, saveOpenClawMode } from './openclaw-mode';
import { SessionSwitcher } from './SessionSwitcher';
import { TabStrip } from './TabStrip';
import { ThemeMenu } from './ThemeMenu';
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  OPEN_TERMINAL_KEY_SETTINGS_EVENT,
} from './terminal-accessory-layout';
import { applyTheme, loadCustomThemes, loadFont, loadTheme, saveTheme } from './theme';
import { initialTabsState, tabsReducer } from './tabs';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';
import { usePageVisible } from './use-page-visible';

// theme-effects-font Wave 3 boot init — MODULE TOP LEVEL, not inside the
// component: main.tsx's own top-level `applyTheme(loadTheme())` runs AFTER
// its full import graph is evaluated (App.tsx statically imports this file),
// so a bare call here beats that later statement — the same trick main.tsx
// itself relies on for its own boot-time applyTheme call. loadCustomThemes()
// registers any persisted custom theme mod so a persisted custom theme id
// resolves instead of silently falling back to 'dark' (AC-T4); setUserFontId
// seeds the persisted font override so PtyBlock's first render already uses it.
loadCustomThemes();
setUserFontId(loadFont());

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
// running PTY stream's UI state. `display:none` still lets a MutationObserver
// fire (the e2e output marker) and keeps React state alive; the one thing it
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
// header comment). The `☰`-opened variant is a fixed bottom sheet instead,
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
  const [tabsState, dispatch] = useReducer(tabsReducer, initialTabsState);
  const [view, setView] = useState<'terminal' | 'agents' | 'stats' | 'files' | 'settings' | 'openclaw'>('terminal');
  const [switcherOpen, setSwitcherOpen] = useState(false);
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
    setSwitcherOpen(false);
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
    console.log('[ez-e2e] tab-active:', tabsState.activeSessionId);
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [tabsState.activeSessionId]);

  useEffect(() => {
    transport.setReattachPriority(tabsState.activeSessionId);
    return () => transport.setReattachPriority(null);
  }, [tabsState.activeSessionId, transport]);

  if (view === 'stats') {
    return <MobileStatsView onClose={() => setView('terminal')} />;
  }

  if (view === 'agents') {
    return (
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
  }

  if (view === 'openclaw') {
    return (
      <MobileOpenClawView
        transport={transport}
        onClose={() => setView('terminal')}
        openclawAvailable={openclawAvailable}
      />
    );
  }

  if (view === 'settings') {
    return (
      <MobileSettingsView
        connectionUrl={connectionUrl}
        onClose={() => setView('terminal')}
        onDisconnect={onDisconnect}
        openclawMode={openclawMode}
        onOpenClawModeChange={handleOpenClawModeChange}
      />
    );
  }

  if (view === 'files') {
    const activeSession = tabsState.tabs.find((t) => t.sessionId === tabsState.activeSessionId);
    const initialPath =
      (tabsState.activeSessionId && cwdMapRef.current.get(tabsState.activeSessionId)) ??
      activeSession?.cwd ??
      '';
    return (
      <MobileFileView
        transport={transport}
        initialPath={initialPath}
        onClose={() => setView('terminal')}
        onOpenTerminalAt={onOpenTerminalAt}
        onPastePath={onPastePath}
      />
    );
  }

  if (tabsState.tabs.length === 0) {
    return (
      <SessionSwitcher
        variant="page"
        transport={transport}
        onSelect={openTab}
        onDisconnect={onDisconnect}
        onOpenClaw={effectiveOpenClawVisible ? () => setView('openclaw') : undefined}
        openclawState={effectiveOpenClawVisible ? (openclawState?.state ?? undefined) : undefined}
      />
    );
  }

  return (
    <div className="mobile-workspace" data-testid="mobile-workspace">
      <header className="workspace-header">
        <TabStrip
          tabs={tabsState.tabs}
          activeSessionId={tabsState.activeSessionId}
          onActivate={activateTab}
          onClose={closeTab}
        />
        <button
          type="button"
          className="btn workspace-new-tab-btn"
          onClick={quickNewTab}
          disabled={!connected}
          aria-label="New tab"
          data-testid="tab-add-btn"
        >
          +
        </button>
        <button
          type="button"
          className="btn workspace-menu-btn workspace-wide-action"
          onClick={() => setSwitcherOpen(true)}
          disabled={!connected}
          aria-label="Sessions"
          data-testid="menu-btn"
        >
          ☰
        </button>
        <button
          type="button"
          className="btn files-btn workspace-wide-action"
          onClick={() => setView('files')}
          disabled={!connected}
          aria-label="Files"
          data-testid="files-btn"
        >
          📁
        </button>
        <button
          type="button"
          className="btn agents-btn"
          onClick={() => setView('agents')}
          aria-label="Agents"
          data-testid="agents-btn"
        >
          Agents
          {countAgentAttention(agentSnapshot) > 0 && (
            <span className="agent-unread-badge">{countAgentAttention(agentSnapshot)}</span>
          )}
        </button>
        <button
          ref={moreButtonRef}
          type="button"
          className="btn workspace-more-btn"
          onClick={() => setMoreActionsOpen(true)}
          aria-label={
            effectiveOpenClawVisible && (!openclawState || openclawState.state === 'starting' || openclawState.state === 'unknown')
              ? 'More actions, OpenClaw status pending'
              : 'More actions'
          }
          aria-haspopup="dialog"
          aria-expanded={moreActionsOpen}
          aria-controls={moreActionsOpen ? 'workspace-more-actions' : undefined}
          data-testid="workspace-more-btn"
        >
          ⋯
          {effectiveOpenClawVisible
            && (!openclawState || openclawState.state === 'starting' || openclawState.state === 'unknown')
            && <span className="workspace-more-status-dot" aria-hidden="true" />}
        </button>
      </header>

      {tabsState.tabs.map((tab) => (
        <div
          key={tab.sessionId}
          className="tab-page"
          style={{ display: tab.sessionId === tabsState.activeSessionId ? undefined : 'none' }}
        >
          <MobileSessionView
            sessionId={tab.sessionId}
            quickCommandSource={transport}
            quickCommandsSupported={transport.supportsRemoteQuickCommands}
            connected={connected}
            onSessionDead={() => handleSessionDead(tab.sessionId)}
            onCwdChange={handleCwdChange}
          />
        </div>
      ))}

      {switcherOpen && (
        <SessionSwitcher
          variant="sheet"
          transport={transport}
          onSelect={openTab}
          onDisconnect={onDisconnect}
          onCloseSheet={() => setSwitcherOpen(false)}
        />
      )}

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
            onOpenSessions={() => setSwitcherOpen(true)}
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
      />
    </div>
  );
}
