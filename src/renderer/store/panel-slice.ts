/**
 * Panel slice — T7 implementation.
 * Tracks which side panel is currently open.
 * openPanel toggles: calling with the active panel closes it.
 */

import type { StateCreator } from "zustand";

export interface PanelSliceState {
  activePanelId: string | null;
}

export interface PanelSliceActions {
  openPanel: (panelId: string) => void;
  closePanel: () => void;
}

export type PanelSlice = PanelSliceState & PanelSliceActions;

// For use inside the combined store creator
export function createPanelSlice(): StateCreator<PanelSlice> {
  return (set, _get) => ({
    activePanelId: null,

    openPanel(panelId: string) {
      set((s) => ({
        activePanelId: s.activePanelId === panelId ? null : panelId,
      }));
    },

    closePanel() {
      set({ activePanelId: null });
    },
  });
}
