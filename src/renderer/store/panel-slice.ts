/**
 * Panel slice stub — implemented in T7 (Rail + Visibility Lifecycle).
 * Tracks which side panel is currently open.
 */

export interface PanelSliceState {
  activePanelId: string | null;
}

export interface PanelSliceActions {
  openPanel: (panelId: string) => void;
  closePanel: () => void;
}

export type PanelSlice = PanelSliceState & PanelSliceActions;

export function createPanelSlice(): PanelSlice {
  return {
    activePanelId: null,
    openPanel: () => {},
    closePanel: () => {},
  };
}
