/**
 * Shared settings type definitions.
 * Persisted user preferences.
 */

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  scrollbackLimit: number;
  theme: "dark" | "light" | "custom";
}

export interface ShellSettings {
  /** Default shell path; undefined = auto-detect */
  defaultShell?: string;
  startupArgs: string[];
}

export interface UserSettings {
  terminal: TerminalSettings;
  shell: ShellSettings;
  /** UI language code e.g. "en", "ko" */
  language: string;
  /** Last saved timestamp ms */
  updatedAt: number;
}
