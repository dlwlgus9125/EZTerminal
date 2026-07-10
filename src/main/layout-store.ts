/**
 * Layout persistence store (Track A ③, A-M2) — the main process's fs owner.
 *
 * Main owns the filesystem exclusively; the renderer only ever sees validated
 * envelopes over IPC. Electron-free (fs/path only via JsonFile): the base
 * directory is injected, so unit tests run against real temp dirs and `main.ts`
 * wires `app.getPath('userData')` (overridable via EZTERMINAL_USER_DATA_DIR for
 * e2e).
 *
 * Each of the three files (layout / presets / settings) is a composed JsonFile
 * that owns the atomic-write / .corrupt-quarantine / write-chain protocol:
 *  - atomic write = `<file>.tmp` then rename (same-volume atomic on NTFS;
 *    rename replaces an existing target); one retry on a transient Windows lock.
 *  - stale `*.tmp` from a crash mid-write is deleted on init().
 *  - each file serializes its own writes; a corrupt/invalid file is quarantined
 *    to `<file>.corrupt` (keep ONE latest evidence file) and treated as absent.
 * LayoutStore keeps the cross-file policy on top: layout saves debounce to the
 * newest state (latest-wins), settings are a read-modify-write so a
 * setStartup/setTheme pair never loses a field, and flush() drains all three.
 */
import {
  LAYOUT_SCHEMA_VERSION,
  PresetNameSchema,
  PresetsFileSchema,
  SettingsSchema,
  buildLayoutEnvelope,
  validateLayoutEnvelope,
  type EffectParamsSettings,
  type LayoutEnvelope,
  type PresetsFile,
  type RollbarSettings,
  type SettingsFile,
  type StartupPref,
  type ThemeName,
} from '../shared/layout-schema';
import { JsonFile } from './json-file';

const LAYOUT_FILE = 'layout.json';
const PRESETS_FILE = 'presets.json';
const SETTINGS_FILE = 'settings.json';

const validatePresets = (raw: unknown): PresetsFile | null => {
  const p = PresetsFileSchema.safeParse(raw);
  return p.success ? p.data : null;
};
const validateSettings = (raw: unknown): SettingsFile | null => {
  const p = SettingsSchema.safeParse(raw);
  return p.success ? p.data : null;
};
const emptyPresets = (): PresetsFile => ({ schemaVersion: LAYOUT_SCHEMA_VERSION, presets: {} });
const emptySettings = (): SettingsFile => ({ schemaVersion: LAYOUT_SCHEMA_VERSION, startup: { mode: 'last' } });

export class LayoutStore {
  private readonly layoutFile: JsonFile;
  private readonly presetsFile: JsonFile;
  private readonly settingsFile: JsonFile;
  private pendingLayout: unknown | undefined;

  constructor(dir: string) {
    this.layoutFile = new JsonFile(dir, LAYOUT_FILE);
    this.presetsFile = new JsonFile(dir, PRESETS_FILE);
    this.settingsFile = new JsonFile(dir, SETTINGS_FILE);
  }

  /** Ensure the dir exists and clear crash-stale `*.tmp` remnants. */
  async init(): Promise<void> {
    await Promise.all([this.layoutFile.init(), this.presetsFile.init(), this.settingsFile.init()]);
  }

  // ── layout ──────────────────────────────────────────────────────────────

  /** Read + validate the persisted layout. Invalid/corrupt → quarantine + null. */
  async loadLayout(): Promise<LayoutEnvelope | null> {
    const raw = await this.layoutFile.read();
    if (raw === undefined) return null; // absent
    const env = validateLayoutEnvelope(raw);
    if (env === null) {
      await this.layoutFile.quarantine();
      return null;
    }
    return env;
  }

  /**
   * Queue a layout save (latest-wins, serialized). Invalid payloads are a
   * programming error upstream: logged and dropped, never written.
   */
  saveLayout(rawLayout: unknown): void {
    const hadPending = this.pendingLayout !== undefined;
    this.pendingLayout = rawLayout;
    if (hadPending) return; // the queued drain will pick up the newest value
    void this.layoutFile.enqueue(() => this.drainLayoutSaves());
  }

  private async drainLayoutSaves(): Promise<void> {
    while (this.pendingLayout !== undefined) {
      const raw = this.pendingLayout;
      this.pendingLayout = undefined;
      const env = buildLayoutEnvelope(raw, new Date().toISOString());
      if (env === null) {
        console.error('[layout-store] dropped invalid layout save (validation failed)');
        continue;
      }
      await this.layoutFile.writeAtomic(JSON.stringify(env));
    }
  }

  /** Await every queued write (renderer flush seam + quit path). */
  async flush(): Promise<void> {
    await Promise.all([this.layoutFile.flush(), this.presetsFile.flush(), this.settingsFile.flush()]);
  }

  /** Awaitable quarantine (gate B3): callers suppress saves until this resolves. */
  async quarantineLayout(): Promise<void> {
    await this.layoutFile.quarantine();
  }

  // ── presets ─────────────────────────────────────────────────────────────

  async listPresets(): Promise<string[]> {
    return Object.keys((await this.loadPresetsFile()).presets);
  }

  async getPreset(name: string): Promise<LayoutEnvelope | null> {
    return (await this.loadPresetsFile()).presets[name] ?? null;
  }

  /** Persist a preset from a raw api.toJSON() layout. False = invalid input. */
  async savePreset(name: string, rawLayout: unknown): Promise<boolean> {
    if (!PresetNameSchema.safeParse(name).success) return false;
    const env = buildLayoutEnvelope(rawLayout, new Date().toISOString());
    if (env === null) return false;
    await this.presetsFile.update(
      validatePresets,
      emptyPresets(),
      (current) => {
        current.presets[name] = env;
        return current;
      },
      'preset save',
    );
    return true;
  }

  async deletePreset(name: string): Promise<void> {
    await this.presetsFile.update(
      validatePresets,
      emptyPresets(),
      (current) => {
        delete current.presets[name];
        return current;
      },
      'preset delete',
    );
  }

  /** Read + validate presets.json, defaulting to `{ presets: {} }` when absent/corrupt. */
  private async loadPresetsFile(): Promise<PresetsFile> {
    return this.presetsFile.readValidated(validatePresets, emptyPresets());
  }

  // ── settings (startup pref — gate Q5; theme — E1) ───────────────────────
  // Both live in the single settings.json file, so every write is a
  // read-modify-write through `updateSettings` (queued on the settings file's
  // write chain, gate: a setStartup must never clobber a theme set moments
  // earlier, or vice versa).

  async getStartup(): Promise<StartupPref> {
    return (await this.loadSettingsFile()).startup;
  }

  async setStartup(pref: StartupPref): Promise<void> {
    await this.updateSettings((current) => ({ ...current, startup: pref }), 'startup pref');
  }

  async getTheme(): Promise<ThemeName> {
    return (await this.loadSettingsFile()).theme ?? 'dark';
  }

  async setTheme(theme: ThemeName): Promise<void> {
    await this.updateSettings((current) => ({ ...current, theme }), 'theme');
  }

  async getUiScale(): Promise<number> {
    return (await this.loadSettingsFile()).uiScale ?? 100;
  }

  async setUiScale(uiScale: number): Promise<void> {
    await this.updateSettings((current) => ({ ...current, uiScale }), 'uiScale');
  }

  async getScrollback(): Promise<number> {
    return (await this.loadSettingsFile()).scrollback ?? 5000;
  }

  async setScrollback(scrollback: number): Promise<void> {
    await this.updateSettings((current) => ({ ...current, scrollback }), 'scrollback');
  }

  async getRemoteEnabled(): Promise<boolean> {
    // Default OFF (opt-in): the remote-control WS bridge grants a paired device
    // full command execution + filesystem access to this host, so it must not
    // listen until the user explicitly enables it (public-repo security review).
    return (await this.loadSettingsFile()).remoteEnabled ?? false;
  }

  async setRemoteEnabled(remoteEnabled: boolean): Promise<void> {
    await this.updateSettings((current) => ({ ...current, remoteEnabled }), 'remoteEnabled');
  }

  /** The persisted FONT_CATALOG id (theme-effects-font M3) — undefined means
   * "use the active theme's own fontFamily" (resolveFontFamily). */
  async getFont(): Promise<string | undefined> {
    return (await this.loadSettingsFile()).fontFamily;
  }

  async setFont(id: string): Promise<void> {
    await this.updateSettings((current) => ({ ...current, fontFamily: id }), 'fontFamily');
  }

  async getEffectToggles(): Promise<Record<string, boolean>> {
    return (await this.loadSettingsFile()).effectToggles ?? {};
  }

  async setEffectToggles(effectToggles: Record<string, boolean>): Promise<void> {
    await this.updateSettings((current) => ({ ...current, effectToggles }), 'effectToggles');
  }

  async getRollbar(): Promise<RollbarSettings> {
    return (await this.loadSettingsFile()).rollbar ?? {};
  }

  async setRollbar(rollbar: RollbarSettings): Promise<void> {
    await this.updateSettings((current) => ({ ...current, rollbar }), 'rollbar');
  }

  async getEffectParams(): Promise<EffectParamsSettings> {
    return (await this.loadSettingsFile()).effectParams ?? {};
  }

  async setEffectParams(effectParams: EffectParamsSettings): Promise<void> {
    await this.updateSettings((current) => ({ ...current, effectParams }), 'effectParams');
  }

  /** Read + validate settings.json, defaulting to `{ startup: {mode:'last'} }`
   * when absent/corrupt (quarantining the latter). Shared by every getter. */
  private async loadSettingsFile(): Promise<SettingsFile> {
    return this.settingsFile.readValidated(validateSettings, emptySettings());
  }

  /** Read-modify-write settings.json on the settings file's write chain: the
   * read happens only after any prior queued write has landed, so a
   * setStartup/setTheme pair issued back-to-back can never lose one field to
   * the other. */
  private async updateSettings(
    mutate: (current: SettingsFile) => SettingsFile,
    label: string,
  ): Promise<void> {
    await this.settingsFile.update(validateSettings, emptySettings(), mutate, label);
  }
}
