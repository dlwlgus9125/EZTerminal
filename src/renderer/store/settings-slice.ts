/**
 * Settings slice stub — implemented in T10 (Files + Preview + Settings).
 * Holds user preferences loaded from settings.json.
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

export function createSettingsSlice(): SettingsSlice {
  return {
    settings: defaultSettings,
    updateSettings: () => {},
  };
}
