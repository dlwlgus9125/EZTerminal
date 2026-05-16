/**
 * Cross-slice integration tests.
 * Tests: closeTab → PTY kill, store combines all 4 slices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../src/renderer/store/index";
import { createIsolatedStore } from "../helpers/store";

// Mock window.electronAPI.pty.kill
const mockPtyKill = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockPtyKill.mockClear();
  // Install mock electronAPI on global
  (globalThis as unknown as Record<string, unknown>).window = {
    electronAPI: {
      pty: {
        create: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: mockPtyKill,
        onData: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {}),
      },
    },
  };
});

describe("Store creation", () => {
  it("creates store with all 4 slices", () => {
    const useStore = createIsolatedStore(createStore);
    const state = useStore.getState();
    // terminalSlice
    expect(state).toHaveProperty("sessions");
    expect(state).toHaveProperty("activeSessionId");
    expect(state).toHaveProperty("addSession");
    expect(state).toHaveProperty("removeSession");
    // layoutSlice
    expect(state).toHaveProperty("tabs");
    expect(state).toHaveProperty("activeTabId");
    expect(state).toHaveProperty("addTab");
    expect(state).toHaveProperty("closeTab");
    // panelSlice (stub)
    expect(state).toHaveProperty("activePanelId");
    expect(state).toHaveProperty("openPanel");
    expect(state).toHaveProperty("closePanel");
    // settingsSlice (stub)
    expect(state).toHaveProperty("settings");
    expect(state).toHaveProperty("updateSettings");
  });
});

describe("cross-slice closeTab", () => {
  it("calls PTY kill for each session in the closed tab's panes", () => {
    const useStore = createIsolatedStore(createStore);
    const state = useStore.getState();

    // Get the initial tab's pane id
    const tabId = state.activeTabId;
    expect(tabId).not.toBeNull();
    const tab = tabId ? state.tabs[tabId] : undefined;
    expect(tab).toBeDefined();
    const paneId = tab ? (tab.layout as { type: "leaf"; paneId: string }).paneId : "";

    // Register a session for that pane
    useStore.getState().addSession(paneId, "sess-kill-me");

    // Add a second tab so the first can be closed
    useStore.getState().addTab();
    useStore.getState().switchTab(tabId);
    // Now close the first tab (which has sess-kill-me)
    useStore.getState().closeTab(tabId);

    expect(mockPtyKill).toHaveBeenCalledWith("sess-kill-me");
  });

  it("closeTab last tab — state unchanged, PTY kill not called", () => {
    const useStore = createIsolatedStore(createStore);
    const state = useStore.getState();
    const onlyTabId = state.activeTabId;
    expect(onlyTabId).not.toBeNull();
    const tab = onlyTabId ? state.tabs[onlyTabId] : undefined;
    expect(tab).toBeDefined();
    const paneId = tab ? (tab.layout as { type: "leaf"; paneId: string }).paneId : "";

    useStore.getState().addSession(paneId, "sess-safe");
    if (onlyTabId) useStore.getState().closeTab(onlyTabId);

    // Tab still exists
    expect(useStore.getState().tabs[onlyTabId ?? ""]).toBeDefined();
    expect(mockPtyKill).not.toHaveBeenCalled();
  });
});
