/**
 * Terminal slice — pane→session mapping and activeSessionId tracking.
 * paneId (string UUID) maps 1:1 to a PTY session ID (string UUID).
 */

import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

export interface TerminalSliceState {
  /** Map of paneId → sessionId */
  sessions: Record<string, string>;
  activeSessionId: string | null;
}

export interface TerminalSliceActions {
  addSession: (paneId: string, sessionId: string) => void;
  removeSession: (paneId: string) => void;
  setActiveSession: (sessionId: string) => void;
  /** Returns sessionIds for the given list of paneIds (skips missing entries). */
  getSessionsForPanes: (paneIds: string[]) => string[];
}

export type TerminalSlice = TerminalSliceState & TerminalSliceActions;

const initialState: TerminalSliceState = {
  sessions: {},
  activeSessionId: null,
};

export function createTerminalStore(): UseBoundStore<StoreApi<TerminalSlice>> {
  return create<TerminalSlice>((set, get) => ({
    ...initialState,

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
      for (const paneId of paneIds) {
        const sid = sessions[paneId];
        if (sid !== undefined) result.push(sid);
      }
      return result;
    },
  }));
}
