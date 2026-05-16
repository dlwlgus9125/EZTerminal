/**
 * Unit tests for layoutSlice.
 * Tests: tab CRUD, pane split/close/focus, constraints.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createLayoutStore } from "../../src/renderer/store/layout-slice";
import { createIsolatedStore } from "../helpers/store";

type LeafNode = { type: "leaf"; paneId: string };

function getLeafPaneId(layout: unknown): string {
  const node = layout as { type: string; paneId?: string };
  if (node.type === "leaf" && node.paneId) return node.paneId;
  throw new Error("Expected leaf node");
}

function collectIds(layout: unknown): string[] {
  const node = layout as { type: string; paneId?: string; children?: unknown[] };
  if (node.type === "leaf") return [node.paneId ?? ""];
  const children = node.children ?? [];
  return children.flatMap((c) => collectIds(c));
}

describe("layoutSlice", () => {
  let useStore: ReturnType<typeof createLayoutStore>;

  beforeEach(() => {
    useStore = createIsolatedStore(createLayoutStore);
  });

  describe("Store creation", () => {
    it("initializes with one default tab", () => {
      const state = useStore.getState();
      expect(Object.keys(state.tabs)).toHaveLength(1);
      expect(state.activeTabId).not.toBeNull();
    });

    it("default tab has a single leaf pane", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      expect(tab?.layout.type).toBe("leaf");
    });
  });

  describe("layoutSlice addTab", () => {
    it("creates a new tab and sets it as active", () => {
      useStore.getState().addTab();
      const state = useStore.getState();
      expect(Object.keys(state.tabs)).toHaveLength(2);
    });

    it("newly added tab has a single leaf pane", () => {
      useStore.getState().addTab();
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab?.layout.type).toBe("leaf");
    });

    it("new tab becomes the active tab", () => {
      const firstTabId = useStore.getState().activeTabId;
      useStore.getState().addTab();
      expect(useStore.getState().activeTabId).not.toBe(firstTabId);
    });
  });

  describe("layoutSlice closeTab", () => {
    it("removes a tab by id", () => {
      useStore.getState().addTab();
      const state = useStore.getState();
      const tabIdToClose = state.activeTabId ?? "";
      useStore.getState().closeTab(tabIdToClose);
      expect(useStore.getState().tabs[tabIdToClose]).toBeUndefined();
    });

    it("switches activeTabId when the active tab is closed", () => {
      useStore.getState().addTab();
      const closedId = useStore.getState().activeTabId ?? "";
      useStore.getState().closeTab(closedId);
      const { activeTabId, tabs } = useStore.getState();
      expect(activeTabId).not.toBe(closedId);
      expect(tabs[activeTabId ?? ""]).toBeDefined();
    });

    it("closeTab last tab — state unchanged", () => {
      const state = useStore.getState();
      const onlyTabId = state.activeTabId ?? "";
      useStore.getState().closeTab(onlyTabId);
      // Should be blocked — tab still exists
      expect(useStore.getState().tabs[onlyTabId]).toBeDefined();
      expect(useStore.getState().activeTabId).toBe(onlyTabId);
    });
  });

  describe("layoutSlice switchTab", () => {
    it("sets activeTabId to the given tabId", () => {
      useStore.getState().addTab();
      const { tabs } = useStore.getState();
      const tabIds = Object.keys(tabs);
      const firstTabId = tabIds[0] ?? "";
      useStore.getState().switchTab(firstTabId);
      expect(useStore.getState().activeTabId).toBe(firstTabId);
    });
  });

  describe("layoutSlice splitPane", () => {
    it("splits active pane horizontally", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "horizontal");
      const newTab = useStore.getState().tabs[tabId];
      expect(newTab?.layout.type).toBe("split");
    });

    it("split pane has correct direction", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "vertical");
      const newTab = useStore.getState().tabs[tabId];
      if (newTab?.layout.type === "split") {
        expect(newTab.layout.direction).toBe("vertical");
      }
    });

    it("split creates two leaf children", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "horizontal");
      const newTab = useStore.getState().tabs[tabId];
      if (newTab?.layout.type === "split") {
        expect(newTab.layout.children[0]?.type).toBe("leaf");
        expect(newTab.layout.children[1]?.type).toBe("leaf");
      }
    });

    it("split sets default ratio 0.5", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "horizontal");
      const newTab = useStore.getState().tabs[tabId];
      if (newTab?.layout.type === "split") {
        expect(newTab.layout.ratio).toBe(0.5);
      }
    });

    it("blocks split when tab already has 4 panes", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";

      const getPaneIds = (): string[] => {
        const tab = useStore.getState().tabs[tabId];
        return collectIds(tab?.layout);
      };

      useStore.getState().splitPane(tabId, getPaneIds()[0] ?? "", "horizontal");
      useStore.getState().splitPane(tabId, getPaneIds()[0] ?? "", "horizontal");
      useStore.getState().splitPane(tabId, getPaneIds()[0] ?? "", "horizontal");

      const countBefore = getPaneIds().length;
      useStore.getState().splitPane(tabId, getPaneIds()[0] ?? "", "horizontal");
      expect(getPaneIds().length).toBe(countBefore);
    });
  });

  describe("layoutSlice closePane", () => {
    it("removes a pane from split layout", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "horizontal");

      const tab2 = useStore.getState().tabs[tabId];
      if (tab2?.layout.type === "split") {
        const newPaneId = (tab2.layout.children[1] as LeafNode).paneId;
        useStore.getState().closePane(tabId, newPaneId);
        const tab3 = useStore.getState().tabs[tabId];
        expect(tab3?.layout.type).toBe("leaf");
      }
    });

    it("closePane last pane — state unchanged", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().closePane(tabId, paneId);
      const tabAfter = useStore.getState().tabs[tabId];
      expect(tabAfter?.layout.type).toBe("leaf");
    });
  });

  describe("layoutSlice focusPane", () => {
    it("sets activePaneId in the tab", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().focusPane(tabId, paneId);
      expect(useStore.getState().tabs[tabId]?.activePaneId).toBe(paneId);
    });
  });

  describe("layoutSlice getPaneIds", () => {
    it("returns all leaf pane ids from a tab layout", () => {
      const state = useStore.getState();
      const tabId = state.activeTabId ?? "";
      const tab = state.tabs[tabId];
      expect(tab).toBeDefined();
      const paneId = getLeafPaneId(tab?.layout);
      useStore.getState().splitPane(tabId, paneId, "horizontal");
      const paneIds = useStore.getState().getPaneIds(tabId);
      expect(paneIds).toHaveLength(2);
    });
  });
});
