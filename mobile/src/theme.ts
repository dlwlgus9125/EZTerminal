import type { ThemeName } from '../../src/shared/layout-schema';
import { EFFECT_CATALOG, type EffectId } from '../../src/renderer/effects';
import {
  DEFAULT_ROLLBAR_PARAMS,
  applyInterferenceParams,
  applyRollbarParams,
  clampInterferenceParams,
  clampRollbarParams,
  type InterferenceParams,
  type RollbarParams,
} from '../../src/renderer/effect-params';
import { applyThemeVarsAndEffects, themeModToDefinition } from '../../src/renderer/theme-runtime';
import { listThemes, registerTheme } from '../../src/renderer/themes';
import { validateThemeMod } from '../../src/shared/theme-schema';

// Mobile's own theme choice — independent of the desktop's settings.json
// persistence (no bridge protocol extension per the mobile-parity plan D6).
// `applyTheme` mirrors the desktop App.tsx's `applyTheme`/`ez:theme` pattern so
// the reused PtyBlock (which listens for `ez:theme` and re-skins its xterm
// instance via `getActiveTheme()`) needs no mobile-specific code.
//
// theme-effects-font Wave 3 (mobile): layers a mobile-only CUSTOM-THEME
// registry (Import-paste/-file only — there's no filesystem to folder-scan on
// a phone, unlike desktop's theme-store.ts) plus font/effect persistence on
// top of Wave 1/2's shared renderer/themes.ts + renderer/theme-runtime.ts,
// all under their own `ezterminal-mobile-*` localStorage keys.

const THEME_KEY = 'ezterminal-mobile-theme';
const CUSTOM_THEMES_KEY = 'ezterminal-mobile-custom-themes';
const FONT_KEY = 'ezterminal-mobile-font';
const EFFECTS_KEY = 'ezterminal-mobile-effects';
const ROLLBAR_KEY = 'ezterminal-mobile-rollbar';
const EFFECT_PARAMS_KEY = 'ezterminal-mobile-effect-params';

export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

/** Accepts any REGISTERED theme id — built-in ∪ custom, not just the 4
 * built-ins — so a persisted custom theme selection survives reload (AC-T4).
 * Requires `loadCustomThemes()` to have already registered the custom half of
 * that union; see its own doc comment for the boot-ordering requirement. */
function isThemeName(value: string): value is ThemeName {
  return listThemes().some((t) => t.id === value);
}

/** Reads the persisted choice, defaulting to 'dark' for anything absent,
 * unrecognized, or on a storage error (private browsing / quota). */
export function loadTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw !== null && isThemeName(raw) ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(name: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, name);
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

// ── custom theme registry (Import only — no folder-scan on mobile) ──────────

function readCustomThemeMods(): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function writeCustomThemeMods(mods: readonly Record<string, unknown>[]): void {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(mods));
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

/** Boot-time hydration: re-validates every stored mod through the SAME
 * `validateThemeMod` pipeline Import uses (defense-in-depth against a
 * tampered/corrupt localStorage entry, not just trust-on-read) and registers
 * each one that still passes. MUST run before the first `applyTheme(loadTheme())`
 * — see MobileWorkspace.tsx's module-top-level call for why that ordering is
 * guaranteed — or a persisted custom theme id would resolve to nothing yet
 * registered and silently fall back to 'dark' (AC-T4). */
export function loadCustomThemes(): void {
  for (const mod of readCustomThemeMods()) {
    const result = validateThemeMod(JSON.stringify(mod));
    if (result.ok) registerTheme(themeModToDefinition(result.theme));
  }
}

/** Import path (mobile has no folder to scan, so this is the ONLY way to add
 * a custom theme, from either the paste textarea or the file picker in
 * ThemeMenu.tsx): validate, persist (deduped by id, last import wins), then
 * register it live so it shows up in `listThemes()` immediately. */
export function importCustomTheme(json: string): { ok: boolean; error?: string } {
  const result = validateThemeMod(json);
  if (!result.ok) return { ok: false, error: result.error };
  const existing = readCustomThemeMods().filter((m) => m.id !== result.theme.id);
  writeCustomThemeMods([...existing, result.theme]);
  registerTheme(themeModToDefinition(result.theme));
  return { ok: true };
}

/** Applies `name` to the document, layers in its cssVars/effects via the
 * shared apply-path helper, and notifies open PtyBlocks to re-theme. Also
 * logs an `[ez-e2e]` marker (mirrors MobileSessionView's output marker) —
 * Android's WebView forwards console.log to logcat, which `mobile/e2e/parity.ts`
 * greps to assert a theme switch actually took effect. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  applyThemeVarsAndEffects(name, { effectToggles: loadEffectToggles(), platformDefaults: MOBILE_EFFECT_DEFAULTS });
  applyRollbarParams(clampRollbarParams(loadRollbar()));
  applyInterferenceParams(clampInterferenceParams(loadEffectParams()));
  window.dispatchEvent(new Event('ez:theme'));
  console.log('[ez-e2e] theme:', name);
}

// ── font override (Wave 3) ───────────────────────────────────────────────────

export function loadFont(): string | undefined {
  try {
    return localStorage.getItem(FONT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveFont(id: string): void {
  try {
    localStorage.setItem(FONT_KEY, id);
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

// ── effect toggles (Wave 3) ──────────────────────────────────────────────────
// Mobile's default is OFF for every effect (AC-E5) — unlike desktop, which
// defaults an unset toggle to the active theme's own declared default. Built
// from EFFECT_CATALOG rather than hand-listed so a future catalog entry is
// off by default here with no edit needed.

export const MOBILE_EFFECT_DEFAULTS: Partial<Record<EffectId, boolean>> = Object.fromEntries(
  Object.values(EFFECT_CATALOG).map((entry) => [entry.id, false]),
);

export function loadEffectToggles(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EFFECTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveEffectToggles(toggles: Record<string, boolean>): void {
  try {
    localStorage.setItem(EFFECTS_KEY, JSON.stringify(toggles));
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

// ── crt-rollbar line params (rollbar-params) ─────────────────────────────────
// Same localStorage lifecycle as effect toggles above; clamping/defaulting
// happens in effect-params.ts's clampRollbarParams (shared with desktop), not
// here — a corrupt/partial stored value is handed to it as-is.

export function loadRollbar(): Partial<RollbarParams> {
  try {
    const raw = localStorage.getItem(ROLLBAR_KEY);
    if (!raw) return DEFAULT_ROLLBAR_PARAMS;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Partial<RollbarParams>) : DEFAULT_ROLLBAR_PARAMS;
  } catch {
    return DEFAULT_ROLLBAR_PARAMS;
  }
}

export function saveRollbar(params: Partial<RollbarParams>): void {
  try {
    localStorage.setItem(ROLLBAR_KEY, JSON.stringify(params));
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

// ── CRT-interference params (crt-interference) ───────────────────────────────
// Same localStorage lifecycle as rollbar above; the loose return type is
// deliberate — effect-params.ts's clampInterferenceParams is the single
// clamp/default authority and swallows any corrupt/partial stored shape.

export function loadEffectParams(): unknown {
  try {
    const raw = localStorage.getItem(EFFECT_PARAMS_KEY);
    return raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return {};
  }
}

export function saveEffectParams(params: InterferenceParams): void {
  try {
    localStorage.setItem(EFFECT_PARAMS_KEY, JSON.stringify(params));
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}
