/**
 * Zustand store combining all 4 slices.
 * Cross-slice coordination (WM-C-6): closeTab reads terminalSlice sessions
 * and calls window.electronAPI.pty.kill() for each pane's PTY before removing the tab.
 */

import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import type { LayoutSlice } from "./layout-slice";
import type { PanelSlice } from "./panel-slice";
import { createSettingsSlice, defaultSettings } from "./settings-slice";
import type { SettingsSlice } from "./settings-slice";
import type { TerminalSlice } from "./terminal-slice";

export type AppStore = TerminalSlice & LayoutSlice & PanelSlice & SettingsSlice;

// ---- helpers (duplicated here to avoid import from slice internals) ----

type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      children: [LayoutNode, LayoutNode];
      ratio: number;
    };

interface Tab {
  id: string;
  layout: LayoutNode;
  activePaneId: string;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newLeaf(): LayoutNode {
  return { type: "leaf", paneId: newId() };
}

function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
}

function countPanes(node: LayoutNode): number {
  if (node.type === "leaf") return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

function insertSplit(
  node: LayoutNode,
  targetPaneId: string,
  direction: "horizontal" | "vertical"
): LayoutNode | null {
  if (node.type === "leaf") {
    if (node.paneId !== targetPaneId) return null;
    const newPane = newLeaf();
    return { type: "split", direction, children: [node, newPane], ratio: 0.5 };
  }
  const left = insertSplit(node.children[0], targetPaneId, direction);
  if (left !== null) return { ...node, children: [left, node.children[1]] };
  const right = insertSplit(node.children[1], targetPaneId, direction);
  if (right !== null) return { ...node, children: [node.children[0], right] };
  return null;
}

function removePane(node: LayoutNode, targetPaneId: string): LayoutNode | null {
  if (node.type === "leaf") return node.paneId === targetPaneId ? null : node;
  const [left, right] = node.children;
  if (left.type === "leaf" && left.paneId === targetPaneId) return right;
  if (right.type === "leaf" && right.paneId === targetPaneId) return left;
  const newLeft = removePane(left, targetPaneId);
  if (newLeft !== null && newLeft !== left) return { ...node, children: [newLeft, right] };
  const newRight = removePane(right, targetPaneId);
  if (newRight !== null && newRight !== right) return { ...node, children: [left, newRight] };
  return node;
}

function makeDefaultTab(): Tab {
  const leaf = newLeaf();
  return {
    id: newId(),
    layout: leaf,
    activePaneId: (leaf as { type: "leaf"; paneId: string }).paneId,
  };
}

// -----------------------------------------------------------------------

export function createStore(): UseBoundStore<StoreApi<AppStore>> {
  const defaultTab = makeDefaultTab();

  return create<AppStore>((set, get) => ({
    // ---- TerminalSlice ----
    sessions: {},
    activeSessionId: null,

    addSession(paneId, sessionId) {
      set((s) => ({
        sessions: { ...s.sessions, [paneId]: sessionId },
        activeSessionId: s.activeSessionId ?? sessionId,
      }));
    },

    removeSession(paneId) {
      set((s) => {
        const removed = s.sessions[paneId];
        const sessions = { ...s.sessions };
        delete sessions[paneId];
        return {
          sessions,
          activeSessionId: s.activeSessionId === removed ? null : s.activeSessionId,
        };
      });
    },

    setActiveSession(sessionId) {
      set({ activeSessionId: sessionId });
    },

    getSessionsForPanes(paneIds) {
      const { sessions } = get();
      const result: string[] = [];
      for (const pid of paneIds) {
        const sid = sessions[pid];
        if (sid !== undefined) result.push(sid);
      }
      return result;
    },

    // ---- LayoutSlice ----
    tabs: { [defaultTab.id]: defaultTab },
    activeTabId: defaultTab.id,

    addTab() {
      const tab = makeDefaultTab();
      set((s) => ({ tabs: { ...s.tabs, [tab.id]: tab }, activeTabId: tab.id }));
    },

    closeTab(tabId) {
      const { tabs, sessions } = get();
      if (Object.keys(tabs).length <= 1) return;

      // Cross-slice: kill PTY for each pane in the tab (ASR-05, WM-C-6)
      const tab = tabs[tabId];
      if (tab) {
        const paneIds = collectPaneIds(tab.layout);
        for (const paneId of paneIds) {
          const sessionId = sessions[paneId];
          if (sessionId) {
            void window.electronAPI.pty.kill(sessionId);
          }
        }
      }

      const newTabs = { ...tabs };
      delete newTabs[tabId];
      let newActiveTabId = get().activeTabId;
      if (newActiveTabId === tabId) {
        newActiveTabId = Object.keys(newTabs)[0] ?? null;
      }
      set({ tabs: newTabs, activeTabId: newActiveTabId });
    },

    switchTab(tabId) {
      set({ activeTabId: tabId });
    },

    splitPane(tabId, paneId, direction) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return;
      if (countPanes(tab.layout) >= 4) return;
      const newLayout = insertSplit(tab.layout, paneId, direction);
      if (!newLayout) return;
      set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...tab, layout: newLayout } } }));
    },

    closePane(tabId, paneId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return;
      if (countPanes(tab.layout) <= 1) return;
      const newLayout = removePane(tab.layout, paneId);
      if (!newLayout) return;
      let { activePaneId } = tab;
      if (activePaneId === paneId) {
        const remaining = collectPaneIds(newLayout);
        activePaneId = remaining[0] ?? "";
      }
      set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...tab, layout: newLayout, activePaneId } } }));
    },

    focusPane(tabId, paneId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return;
      set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...tab, activePaneId: paneId } } }));
    },

    getPaneIds(tabId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return [];
      return collectPaneIds(tab.layout);
    },

    // ---- PanelSlice ----
    activePanelId: null,

    openPanel(panelId) {
      set((s) => ({
        activePanelId: s.activePanelId === panelId ? null : panelId,
      }));
    },

    closePanel() {
      set({ activePanelId: null });
    },

    // ---- SettingsSlice ----
    ...createSettingsSlice(set),
  }));
}

/**
 * Application-wide Zustand store instance.
 * Imported by renderer components via: import { useStore } from '../store'.
 */
export const useStore = createStore();
