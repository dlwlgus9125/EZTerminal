// tabs.ts — pure reducer for the mobile workspace's open-tab state (M5,
// mobile-parity plan D5). No React/DOM — MobileWorkspace.tsx is the only
// consumer, so keep-alive/resize/e2e-marker side effects live there, not
// here. Every tab is one host-authorized session surface. The surface id
// survives reconnects, while its host-issued binding is invalidated and
// re-opened as an adopted view on the next authenticated connection.

import type { SessionSurfaceBinding } from '../../src/shared/session-surface';

export interface Tab {
  readonly sessionId: string;
  readonly cwd: string;
  readonly surfaceId: string;
  readonly binding: SessionSurfaceBinding | null;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeSessionId: string | null;
}

export type TabsAction =
  | { readonly type: 'open'; readonly binding: SessionSurfaceBinding }
  | { readonly type: 'rebind'; readonly sessionId: string; readonly binding: SessionSurfaceBinding }
  | { readonly type: 'invalidateBindings' }
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
      const sessionId = action.binding.session.sessionId;
      const existing = state.tabs.some((t) => t.sessionId === sessionId);
      const tabs = existing
        ? state.tabs
        : [...state.tabs, {
            sessionId,
            cwd: action.binding.session.cwd,
            surfaceId: action.binding.surfaceId,
            binding: action.binding,
          }];
      return { tabs, activeSessionId: sessionId };
    }
    case 'rebind': {
      if (
        action.binding.session.sessionId !== action.sessionId
        || action.binding.surfaceId !== state.tabs.find((tab) => tab.sessionId === action.sessionId)?.surfaceId
      ) {
        return state;
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) => tab.sessionId === action.sessionId
          ? { ...tab, cwd: action.binding.session.cwd, binding: action.binding }
          : tab),
      };
    }
    case 'invalidateBindings': {
      if (state.tabs.every((tab) => tab.binding === null)) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({ ...tab, binding: null })),
      };
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

/**
 * DOM ids for a terminal tab's panel.
 *
 * These outlived the TabStrip component that introduced them: the workspace
 * still needs a stable, unique element id per session for the keep-alive
 * wrapper it toggles. A session id can contain anything, so it is reduced to
 * characters an id selector can address.
 */
function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/gu, '-');
}

export function mobileTerminalPanelId(sessionId: string): string {
  return `mobile-terminal-panel-${safeSessionId(sessionId)}`;
}
