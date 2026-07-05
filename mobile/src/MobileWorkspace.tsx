import { useCallback, useEffect, useReducer, useState } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import { MobileSessionView } from './MobileSessionView';
import { MobileStatsView } from './MobileStatsView';
import { SessionSwitcher } from './SessionSwitcher';
import { TabStrip } from './TabStrip';
import { ThemeMenu } from './ThemeMenu';
import { applyTheme, loadTheme, saveTheme } from './theme';
import { initialTabsState, tabsReducer } from './tabs';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

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
// again. (No PtyBlock/xterm view is wired up yet as of M5 — TerminalPane's
// pty-shape rendering hasn't landed on mobile — but this keeps the tab
// mechanism correct for when it does, per the mobile-parity plan's risk #1.)
//
// Zero-tab state: renders `SessionSwitcher variant="page"` as the ENTIRE
// screen (no workspace header above it) — it must stay in normal document
// flow, not a fixed overlay, so Android's uiautomator accessibility dump can
// see '+ New Session' with no real DOM access (see mobile/e2e/smoke.ts's
// header comment). The `☰`-opened variant is a fixed bottom sheet instead,
// a convenience surface used only once tabs already exist.
export function MobileWorkspace({
  transport,
  onDisconnect,
}: {
  transport: WsEzTerminalTransport;
  onDisconnect: () => void;
}): JSX.Element {
  const [tabsState, dispatch] = useReducer(tabsReducer, initialTabsState);
  const [view, setView] = useState<'terminal' | 'stats'>('terminal');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(() => loadTheme());

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

  const activateTab = useCallback((sessionId: string) => {
    dispatch({ type: 'activate', sessionId });
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    dispatch({ type: 'close', sessionId });
  }, []);

  const handleSessionDead = useCallback((sessionId: string) => {
    dispatch({ type: 'sessionDied', sessionId });
  }, []);

  const quickNewTab = useCallback(() => {
    void transport.createSession().then((info) => openTab(info.sessionId, info.cwd));
  }, [transport, openTab]);

  // Fires on every active-tab change, however it happened (open, explicit
  // activate, or a close that fell back to a neighbor) — a previously
  // display:none tab was just made visible, so any xterm inside it needs to
  // re-measure, and the e2e marker (mobile/e2e/parity.ts greps logcat) should
  // reflect the tab that is ACTUALLY active now, not just the action taken.
  useEffect(() => {
    if (!tabsState.activeSessionId) return;
    console.log('[ez-e2e] tab-active:', tabsState.activeSessionId);
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [tabsState.activeSessionId]);

  if (view === 'stats') {
    return <MobileStatsView onClose={() => setView('terminal')} />;
  }

  if (tabsState.tabs.length === 0) {
    return (
      <SessionSwitcher
        variant="page"
        transport={transport}
        onSelect={openTab}
        onDisconnect={onDisconnect}
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
          aria-label="New tab"
          data-testid="tab-add-btn"
        >
          +
        </button>
        <button
          type="button"
          className="btn workspace-menu-btn"
          onClick={() => setSwitcherOpen(true)}
          aria-label="Sessions"
          data-testid="menu-btn"
        >
          ☰
        </button>
        <button
          type="button"
          className="btn stats-btn"
          onClick={() => setView('stats')}
          aria-label="Stats"
          data-testid="stats-btn"
        >
          📊
        </button>
        <button
          type="button"
          className="btn theme-btn"
          onClick={() => setThemeMenuOpen(true)}
          aria-label="Theme"
          data-testid="theme-btn"
        >
          🎨
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
            onSessionDead={() => handleSessionDead(tab.sessionId)}
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

      <ThemeMenu
        open={themeMenuOpen}
        current={currentTheme}
        onSelect={handleThemeSelect}
        onClose={() => setThemeMenuOpen(false)}
      />
    </div>
  );
}
