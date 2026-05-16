/**
 * Unit tests for terminalSlice.
 * Tests: session CRUD, activeSessionId management.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTerminalStore } from "../../src/renderer/store/terminal-slice";
import { createIsolatedStore } from "../helpers/store";

describe("terminalSlice", () => {
  let useStore: ReturnType<typeof createTerminalStore>;

  beforeEach(() => {
    useStore = createIsolatedStore(createTerminalStore);
  });

  describe("Store creation", () => {
    it("initializes with empty sessions and null activeSessionId", () => {
      const state = useStore.getState();
      expect(state.sessions).toEqual({});
      expect(state.activeSessionId).toBeNull();
    });
  });

  describe("terminalSlice addSession", () => {
    it("adds a session and sets it as active", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      const state = useStore.getState();
      expect(state.sessions["pane-1"]).toBe("sess-abc");
      expect(state.activeSessionId).toBe("sess-abc");
    });

    it("adding a second session does not change activeSessionId", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().addSession("pane-2", "sess-def");
      const state = useStore.getState();
      expect(state.sessions["pane-1"]).toBe("sess-abc");
      expect(state.sessions["pane-2"]).toBe("sess-def");
      expect(state.activeSessionId).toBe("sess-abc");
    });
  });

  describe("terminalSlice removeSession", () => {
    it("removes a session by paneId", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().removeSession("pane-1");
      const state = useStore.getState();
      expect(state.sessions["pane-1"]).toBeUndefined();
    });

    it("clears activeSessionId when the active session is removed", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().removeSession("pane-1");
      expect(useStore.getState().activeSessionId).toBeNull();
    });

    it("does not affect activeSessionId when a non-active session is removed", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().addSession("pane-2", "sess-def");
      useStore.getState().setActiveSession("sess-def");
      useStore.getState().removeSession("pane-1");
      expect(useStore.getState().activeSessionId).toBe("sess-def");
    });
  });

  describe("terminalSlice setActiveSession", () => {
    it("sets activeSessionId to given sessionId", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().addSession("pane-2", "sess-def");
      useStore.getState().setActiveSession("sess-def");
      expect(useStore.getState().activeSessionId).toBe("sess-def");
    });
  });

  describe("terminalSlice getSessionsForPanes", () => {
    it("returns sessionIds for a given list of paneIds", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      useStore.getState().addSession("pane-2", "sess-def");
      const sessions = useStore.getState().getSessionsForPanes(["pane-1", "pane-2"]);
      expect(sessions).toEqual(["sess-abc", "sess-def"]);
    });

    it("skips paneIds with no session", () => {
      useStore.getState().addSession("pane-1", "sess-abc");
      const sessions = useStore.getState().getSessionsForPanes(["pane-1", "pane-unknown"]);
      expect(sessions).toEqual(["sess-abc"]);
    });
  });
});
