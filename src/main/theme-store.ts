/**
 * Custom theme mod persistence (theme-effects-font M3, Wave 3 desktop) — main's
 * fs authority for `.ezterminal/themes/*.json`, mirroring layout-store.ts's
 * atomic tmp+rename write discipline. Every mod, whether folder-scanned at
 * startup or Imported later, is validated through the SHARED `validateThemeMod`
 * (shared/theme-schema.ts) before it's ever handed to the renderer — the
 * renderer's `registerTheme` call only ever sees pre-validated `ThemeMod`s.
 *
 * `EZTERMINAL_THEMES_DIR` mirrors main.ts's `EZTERMINAL_USER_DATA_DIR` test
 * seam (grep main.ts ~line 56) so e2e can point this at a fixture dir; unlike
 * userData there's no `app.setPath` equivalent for a themes folder, so the
 * override is read directly here instead.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { validateThemeMod, type ThemeMod } from '../shared/theme-schema';

function themesDir(): string {
  return process.env.EZTERMINAL_THEMES_DIR ?? path.join(app.getPath('home'), '.ezterminal', 'themes');
}

/** Scan the themes dir for `*.json`, validating each through `validateThemeMod`.
 * A missing dir is not an error (nothing imported yet) — returns an empty list.
 * An unreadable/invalid file is skipped with a console.warn: one bad mod must
 * never block the rest from loading. */
export async function getAvailableThemes(): Promise<ThemeMod[]> {
  const dir = themesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // dir absent — nothing scanned yet
  }
  const themes: ThemeMod[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      console.warn(`[theme-store] failed to read ${entry}:`, err);
      continue;
    }
    const result = validateThemeMod(text);
    if (!result.ok) {
      console.warn(`[theme-store] skipping invalid theme mod ${entry}: ${result.error}`);
      continue;
    }
    themes.push(result.theme);
  }
  return themes;
}

/**
 * Validate + persist an imported theme mod as `<id>.json` (atomic tmp+rename,
 * one retry on a transient Windows lock — same protocol as layout-store.ts's
 * `atomicWrite`) so it reappears on the next launch's folder-scan. Writes the
 * VALIDATED/normalized form (not the raw input), matching layout-store's
 * write-what-was-validated discipline.
 */
export async function importTheme(json: string): Promise<{ ok: boolean; error?: string }> {
  const result = validateThemeMod(json);
  if (!result.ok) return { ok: false, error: result.error };
  const dir = themesDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${result.theme.id}.json`);
  const tmp = `${target}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(result.theme), 'utf8');
    try {
      await fs.rename(tmp, target);
    } catch {
      await fs.rename(tmp, target); // transient Windows lock — one retry, then drop
    }
  } catch (err) {
    console.error('[theme-store] failed to persist imported theme:', err);
    await fs.unlink(tmp).catch(() => undefined);
    return { ok: false, error: `failed to write theme file: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}
