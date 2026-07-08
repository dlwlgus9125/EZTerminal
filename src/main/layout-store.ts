/**
 * Layout persistence store (Track A ③, A-M2) — the main process's fs owner.
 *
 * Main owns the filesystem exclusively; the renderer only ever sees validated
 * envelopes over IPC. Electron-free (fs/path only): the base directory is
 * injected, so unit tests run against real temp dirs and `main.ts` wires
 * `app.getPath('userData')` (overridable via EZTERMINAL_USER_DATA_DIR for e2e).
 *
 * Write protocol (gate additional-finding: Windows atomicity made explicit):
 *  - atomic write = `<file>.tmp` then rename (same-volume atomic on NTFS;
 *    rename replaces an existing target).
 *  - rename failure (transient Windows lock): one immediate retry, then
 *    log + drop — the next debounced save retries naturally.
 *  - stale `*.tmp` from a crash mid-write is deleted on init().
 *  - layout saves are serialized: one in-flight write + latest-pending (a
 *    burst of layout changes collapses to the newest state; intermediates
 *    are droppable by design).
 * Corrupt policy: any unreadable/invalid file is renamed to `<file>.corrupt`
 * (overwriting the previous quarantine — policy: keep ONE latest evidence
 * file) and treated as absent.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

const LAYOUT_FILE = 'layout.json';
const PRESETS_FILE = 'presets.json';
const SETTINGS_FILE = 'settings.json';

export class LayoutStore {
  private readonly dir: string;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingLayout: unknown | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** Ensure the dir exists and clear crash-stale `*.tmp` remnants. */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const name of [LAYOUT_FILE, PRESETS_FILE, SETTINGS_FILE]) {
      await fs.unlink(`${this.file(name)}.tmp`).catch(() => undefined);
    }
  }

  // ── layout ──────────────────────────────────────────────────────────────

  /** Read + validate the persisted layout. Invalid/corrupt → quarantine + null. */
  async loadLayout(): Promise<LayoutEnvelope | null> {
    const raw = await this.readJson(LAYOUT_FILE);
    if (raw === undefined) return null; // absent
    const env = validateLayoutEnvelope(raw);
    if (env === null) {
      await this.quarantine(LAYOUT_FILE);
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
    this.writeChain = this.writeChain.then(() => this.drainLayoutSaves());
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
      await this.atomicWrite(LAYOUT_FILE, JSON.stringify(env));
    }
  }

  /** Await every queued write (renderer flush seam + quit path). */
  async flush(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.writeChain;
      await chain;
    } while (chain !== this.writeChain);
  }

  /** Awaitable quarantine (gate B3): callers suppress saves until this resolves. */
  async quarantineLayout(): Promise<void> {
    await this.quarantine(LAYOUT_FILE);
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
    const current = await this.loadPresetsFile();
    current.presets[name] = env;
    await this.enqueue(() => this.atomicWrite(PRESETS_FILE, JSON.stringify(current)));
    return true;
  }

  async deletePreset(name: string): Promise<void> {
    const current = await this.loadPresetsFile();
    if (!(name in current.presets)) return;
    delete current.presets[name];
    await this.enqueue(() => this.atomicWrite(PRESETS_FILE, JSON.stringify(current)));
  }

  private async loadPresetsFile(): Promise<PresetsFile> {
    const raw = await this.readJson(PRESETS_FILE);
    if (raw !== undefined) {
      const parsed = PresetsFileSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      await this.quarantine(PRESETS_FILE);
    }
    return { schemaVersion: LAYOUT_SCHEMA_VERSION, presets: {} };
  }

  // ── settings (startup pref — gate Q5; theme — E1) ───────────────────────
  // Both live in the single settings.json file, so every write is a
  // read-modify-write through `updateSettings` (queued on the write chain,
  // gate: a setStartup must never clobber a theme set moments earlier, or
  // vice versa).

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

  async getRemoteEnabled(): Promise<boolean> {
    return (await this.loadSettingsFile()).remoteEnabled ?? true;
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
    const raw = await this.readJson(SETTINGS_FILE);
    if (raw !== undefined) {
      const parsed = SettingsSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      await this.quarantine(SETTINGS_FILE);
    }
    return { schemaVersion: LAYOUT_SCHEMA_VERSION, startup: { mode: 'last' } };
  }

  /** Read-modify-write settings.json on the write chain: the read happens
   * only after any prior queued write has landed, so a setStartup/setTheme
   * pair issued back-to-back can never lose one field to the other. */
  private async updateSettings(
    mutate: (current: SettingsFile) => SettingsFile,
    label: string,
  ): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.loadSettingsFile();
      const parsed = SettingsSchema.safeParse(mutate(current));
      if (!parsed.success) {
        console.error(`[layout-store] dropped invalid ${label}`);
        return;
      }
      await this.atomicWrite(SETTINGS_FILE, JSON.stringify(parsed.data));
    });
  }

  // ── shared plumbing ─────────────────────────────────────────────────────

  /** undefined = file absent; unknown = parsed JSON; quarantines unparseable text. */
  private async readJson(name: string): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await fs.readFile(this.file(name), 'utf8');
    } catch {
      return undefined; // ENOENT and friends — treat as absent
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      await this.quarantine(name);
      return undefined;
    }
  }

  private async quarantine(name: string): Promise<void> {
    const target = this.file(name);
    try {
      await fs.rename(target, `${target}.corrupt`);
      console.error(`[layout-store] quarantined ${name} -> ${name}.corrupt`);
    } catch {
      // Already gone (double-quarantine race or ENOENT) — nothing to preserve.
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(op);
    return this.writeChain;
  }

  private async atomicWrite(name: string, data: string): Promise<void> {
    const target = this.file(name);
    const tmp = `${target}.tmp`;
    try {
      await fs.writeFile(tmp, data, 'utf8');
      try {
        await fs.rename(tmp, target);
      } catch {
        // Transient Windows lock — one immediate retry, then drop (the next
        // debounced save retries naturally).
        await fs.rename(tmp, target);
      }
    } catch (err) {
      console.error(`[layout-store] atomic write of ${name} failed:`, err);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
}
