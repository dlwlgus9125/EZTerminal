// tabs.ts — pure reducer for the mobile workspace's open-tab state (M5,
// mobile-parity plan D5). No React/DOM — MobileWorkspace.tsx is the only
// consumer, so keep-alive/resize/e2e-marker side effects live there, not
// here. A "tab" is a UI-level pointer at an ALREADY-EXISTING desktop session
// (SessionSwitcher/`transport.createSession()` own session lifecycle);
// closing a tab never destroys its session.

export interface Tab {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeSessionId: string | null;
}

export type TabsAction =
  | { readonly type: 'open'; readonly sessionId: string; readonly cwd: string }
  | { readonly type: 'activate'; readonly sessionId: string }
  | { readonly type: 'close'; readonly sessionId: string }
  | { readonly type: 'sessionDied'; readonly sessionId: string };

export const initialTabsState: TabsState = { tabs: [], activeSessionId: null };

/** Removes `sessionId`'s tab (shared by 'close' and 'sessionDied'). If it was
 * the active tab, activates its LEFT neighbor, falling back to the new first
 * tab (i.e. the old right neighbor) when the closed tab was leftmost, or
 * `null` once the last tab is gone. */
function removeTab(state: TabsState, sessionId: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.sessionId === sessionId);
  if (idx === -1) return state;

  const tabs = state.tabs.filter((_, i) => i !== idx);
  if (state.activeSessionId !== sessionId) {
    return { tabs, activeSessionId: state.activeSessionId };
  }
  if (tabs.length === 0) {
    return { tabs, activeSessionId: null };
  }
  const neighborIdx = idx > 0 ? idx - 1 : 0;
  return { tabs, activeSessionId: tabs[neighborIdx].sessionId };
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      const existing = state.tabs.some((t) => t.sessionId === action.sessionId);
      const tabs = existing
        ? state.tabs
        : [...state.tabs, { sessionId: action.sessionId, cwd: action.cwd }];
      return { tabs, activeSessionId: action.sessionId };
    }
    case 'activate': {
      if (!state.tabs.some((t) => t.sessionId === action.sessionId)) return state;
      return { ...state, activeSessionId: action.sessionId };
    }
    case 'close':
    case 'sessionDied':
      return removeTab(state, action.sessionId);
    default:
      return state;
  }
}
