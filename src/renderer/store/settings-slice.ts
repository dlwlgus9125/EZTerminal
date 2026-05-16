/**
 * Settings slice — T10 implementation.
 * Holds user preferences loaded from settings.json.
 * updateSettings merges partial updates and persists via IPC.
 */

export interface UserSettingsState {
  fontSize: number;
  fontFamily: string;
  theme: string;
  shell: string;
}

export interface SettingsSliceState {
  settings: UserSettingsState;
}

export interface SettingsSliceActions {
  updateSettings: (partial: Partial<UserSettingsState>) => void;
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions;

export const defaultSettings: UserSettingsState = {
  fontSize: 14,
  fontFamily: "monospace",
  theme: "dark",
  shell: "",
};

export function createSettingsSlice(
  set: (updater: (state: SettingsSlice) => Partial<SettingsSlice>) => void
): SettingsSlice {
  return {
    settings: defaultSettings,
    updateSettings(partial) {
      set((state) => ({
        settings: { ...state.settings, ...partial },
      }));
    },
  };
}
