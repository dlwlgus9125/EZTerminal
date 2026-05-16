/**
 * SettingsPanel — T10 implementation.
 * Form UI for shell, font, theme settings.
 * save → IPC settings:save → immediate apply via settings:applied broadcast.
 */

import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import type { UserSettings } from "../../../../shared/settings-types";
import styles from "./SettingsPanel.module.css";

interface SettingsPanelProps {
  isVisible: boolean;
}

const THEMES = ["dark", "light", "custom"] as const;

function makeDefault(): UserSettings {
  return {
    terminal: {
      fontSize: 14,
      fontFamily: "monospace",
      scrollbackLimit: 1000,
      theme: "dark",
    },
    shell: {
      defaultShell: "",
      startupArgs: [],
    },
    language: "en",
    updatedAt: Date.now(),
  };
}

export function SettingsPanel({ isVisible }: SettingsPanelProps): ReactElement {
  const [settings, setSettings] = useState<UserSettings>(makeDefault());
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [validationError, setValidationError] = useState<string>("");

  // Load settings when panel becomes visible
  useEffect(() => {
    if (!isVisible) return;
    void window.electronAPI.settings.load().then((result) => {
      if (result.ok && result.data) {
        setSettings(result.data as UserSettings);
      }
    });
  }, [isVisible]);

  const validate = (s: UserSettings): string => {
    if (s.terminal.fontSize <= 0 || !Number.isFinite(s.terminal.fontSize)) {
      return "Font size must be a positive number";
    }
    if (!s.terminal.fontFamily.trim()) {
      return "Font family cannot be empty";
    }
    if (!THEMES.includes(s.terminal.theme)) {
      return "Invalid theme value";
    }
    return "";
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setValidationError("");

    const err = validate(settings);
    if (err) {
      setValidationError(err);
      return;
    }

    setStatus("saving");
    const updated: UserSettings = { ...settings, updatedAt: Date.now() };
    const result = await window.electronAPI.settings.save(updated);
    if (result.ok) {
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } else {
      setStatus("error");
      setErrorMsg(result.error ?? "Save failed");
    }
  };

  const updateTerminal = <K extends keyof UserSettings["terminal"]>(
    key: K,
    value: UserSettings["terminal"][K]
  ) => {
    setSettings((s) => ({ ...s, terminal: { ...s.terminal, [key]: value } }));
  };

  const updateShell = (value: string) => {
    setSettings((s) => ({ ...s, shell: { ...s.shell, defaultShell: value } }));
  };

  return (
    <div className={styles.panel} data-testid="settings-panel">
      <h2 className={styles.title}>Settings</h2>

      {validationError && (
        <div className={styles.validationError} data-testid="settings-validation-error">
          {validationError}
        </div>
      )}

      <form onSubmit={handleSubmit} data-testid="settings-form">
        {/* Shell section */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Shell</h3>
          <label className={styles.field}>
            <span className={styles.label}>Default Shell</span>
            <input
              type="text"
              className={styles.input}
              data-testid="settings-shell"
              value={settings.shell.defaultShell ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => updateShell(e.target.value)}
              placeholder="Auto-detect"
            />
          </label>
        </section>

        {/* Font section */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Font</h3>
          <label className={styles.field}>
            <span className={styles.label}>Font Size</span>
            <input
              type="number"
              className={styles.input}
              data-testid="settings-font-size"
              value={settings.terminal.fontSize}
              min={6}
              max={72}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateTerminal("fontSize", Number(e.target.value))
              }
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Font Family</span>
            <input
              type="text"
              className={styles.input}
              data-testid="settings-font-family"
              value={settings.terminal.fontFamily}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateTerminal("fontFamily", e.target.value)
              }
            />
          </label>
        </section>

        {/* Theme section */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Theme</h3>
          <label className={styles.field}>
            <span className={styles.label}>Theme</span>
            <select
              className={styles.select}
              data-testid="settings-theme"
              value={settings.terminal.theme}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                updateTerminal("theme", e.target.value as UserSettings["terminal"]["theme"])
              }
            >
              {THEMES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </section>

        {/* Scrollback section */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Terminal</h3>
          <label className={styles.field}>
            <span className={styles.label}>Scrollback Lines</span>
            <input
              type="number"
              className={styles.input}
              data-testid="settings-scrollback"
              value={settings.terminal.scrollbackLimit}
              min={100}
              max={100000}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateTerminal("scrollbackLimit", Number(e.target.value))
              }
            />
          </label>
        </section>

        <div className={styles.footer}>
          <button
            type="submit"
            className={styles.saveButton}
            data-testid="settings-save"
            disabled={status === "saving"}
          >
            {status === "saving" ? "Saving..." : "Save"}
          </button>
          {status === "saved" && (
            <span className={styles.statusSaved} data-testid="settings-status-saved">
              Saved
            </span>
          )}
          {status === "error" && (
            <span className={styles.statusError} data-testid="settings-status-error">
              {errorMsg}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
