/**
 * Layout slice — tab and pane management using a binary tree (LayoutNode).
 * Max 4 panes per tab. Last tab / last pane close is blocked.
 */

import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

export type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      children: [LayoutNode, LayoutNode];
      ratio: number;
    };

export interface Tab {
  id: string;
  layout: LayoutNode;
  activePaneId: string;
}

export interface LayoutSliceState {
  tabs: Record<string, Tab>;
  activeTabId: string | null;
}

export interface LayoutSliceActions {
  addTab: () => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  splitPane: (tabId: string, paneId: string, direction: "horizontal" | "vertical") => void;
  closePane: (tabId: string, paneId: string) => void;
  focusPane: (tabId: string, paneId: string) => void;
  getPaneIds: (tabId: string) => string[];
}

export type LayoutSlice = LayoutSliceState & LayoutSliceActions;

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

/**
 * Replace the leaf with paneId with a split node containing the original leaf
 * plus a new leaf. Returns null if the target is not found.
 */
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
  if (left !== null) {
    return { ...node, children: [left, node.children[1]] };
  }
  const right = insertSplit(node.children[1], targetPaneId, direction);
  if (right !== null) {
    return { ...node, children: [node.children[0], right] };
  }
  return null;
}

/**
 * Remove the leaf with paneId, collapsing the sibling split up.
 * Returns null if the node itself is the target (caller handles blocking).
 */
function removePane(node: LayoutNode, targetPaneId: string): LayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === targetPaneId ? null : node;
  }
  const [left, right] = node.children;

  if (left.type === "leaf" && left.paneId === targetPaneId) return right;
  if (right.type === "leaf" && right.paneId === targetPaneId) return left;

  const newLeft = removePane(left, targetPaneId);
  if (newLeft !== null && newLeft !== left) {
    return { ...node, children: [newLeft, right] };
  }
  const newRight = removePane(right, targetPaneId);
  if (newRight !== null && newRight !== right) {
    return { ...node, children: [left, newRight] };
  }
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

export function createLayoutStore(): UseBoundStore<StoreApi<LayoutSlice>> {
  const defaultTab = makeDefaultTab();
  return create<LayoutSlice>((set, get) => ({
    tabs: { [defaultTab.id]: defaultTab },
    activeTabId: defaultTab.id,

    addTab() {
      const tab = makeDefaultTab();
      set((s) => ({
        tabs: { ...s.tabs, [tab.id]: tab },
        activeTabId: tab.id,
      }));
    },

    closeTab(tabId) {
      const { tabs } = get();
      // Block if only one tab remains
      if (Object.keys(tabs).length <= 1) return;

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

      // Block at max 4 panes
      if (countPanes(tab.layout) >= 4) return;

      const newLayout = insertSplit(tab.layout, paneId, direction);
      if (!newLayout) return;

      set((s) => ({
        tabs: { ...s.tabs, [tabId]: { ...tab, layout: newLayout } },
      }));
    },

    closePane(tabId, paneId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return;

      // Block if only one pane
      if (countPanes(tab.layout) <= 1) return;

      const newLayout = removePane(tab.layout, paneId);
      if (!newLayout) return;

      // Update activePaneId if the closed pane was active
      let { activePaneId } = tab;
      if (activePaneId === paneId) {
        const remaining = collectPaneIds(newLayout);
        activePaneId = remaining[0] ?? "";
      }

      set((s) => ({
        tabs: { ...s.tabs, [tabId]: { ...tab, layout: newLayout, activePaneId } },
      }));
    },

    focusPane(tabId, paneId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return;
      set((s) => ({
        tabs: { ...s.tabs, [tabId]: { ...tab, activePaneId: paneId } },
      }));
    },

    getPaneIds(tabId) {
      const { tabs } = get();
      const tab = tabs[tabId];
      if (!tab) return [];
      return collectPaneIds(tab.layout);
    },
  }));
}
