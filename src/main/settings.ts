/**
 * SettingsManager — T10 implementation.
 * load: JSON parse from settings file.
 * save: atomic .tmp → rename write.
 * defaults: create file with defaults when missing.
 * corrupt recovery: on parse failure, restore defaults.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { UserSettings } from "../shared/settings-types";

const DEFAULT_SETTINGS: UserSettings = {
  terminal: {
    fontSize: 14,
    fontFamily: "monospace",
    scrollbackLimit: 1000,
    theme: "dark",
  },
  shell: {
    defaultShell: undefined,
    startupArgs: [],
  },
  language: "en",
  updatedAt: 0,
};

export class SettingsManager {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  defaults(): UserSettings {
    return structuredClone(DEFAULT_SETTINGS);
  }

  async load(): Promise<UserSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File missing — create with defaults
        const d = this.defaults();
        await this.save(d);
        return d;
      }
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as UserSettings;
      // Basic validation: must have terminal and shell keys
      if (typeof parsed !== "object" || parsed === null || !parsed.terminal || !parsed.shell) {
        throw new Error("Invalid settings structure");
      }
      return parsed;
    } catch {
      // Corrupt JSON — restore defaults
      const d = this.defaults();
      await this.save(d);
      return d;
    }
  }

  async save(settings: UserSettings): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    const data = JSON.stringify(settings, null, 2);

    await fs.writeFile(tmpPath, data, "utf-8");
    await fs.rename(tmpPath, this.filePath);
  }

  validate(settings: unknown): settings is UserSettings {
    if (typeof settings !== "object" || settings === null) return false;
    const s = settings as Record<string, unknown>;

    // terminal section
    if (typeof s.terminal !== "object" || s.terminal === null) return false;
    const t = s.terminal as Record<string, unknown>;
    if (typeof t.fontSize !== "number" || t.fontSize <= 0) return false;
    if (typeof t.fontFamily !== "string" || t.fontFamily.trim() === "") return false;
    if (!["dark", "light", "custom"].includes(t.theme as string)) return false;

    // shell section
    if (typeof s.shell !== "object" || s.shell === null) return false;

    return true;
  }
}
