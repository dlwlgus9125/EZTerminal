import { isBuiltinTheme } from '../shared/layout-schema';
import type { ThemeMod } from '../shared/theme-schema';
import { EFFECT_CATALOG, applyEffects, resolveActiveEffects, type EffectId } from './effects';
import { seedUiThemeColors, uiThemeColorsToCssVars } from './theme-contrast';
import { getActiveTheme, THEMES, type ThemeDefinition } from './themes';

// Theme runtime (theme-effects-font M2/Wave 2) — the platform-agnostic apply-path
// helper. BOTH desktop (App.tsx) and mobile (theme.ts) call this right after they
// set `document.documentElement.dataset.theme` (and BEFORE dispatching 'ez:theme')
// so the cssVars-injection + effects logic lives in exactly one place instead of
// drifting between the two callers (plan Critic NIT-2). `data-theme` itself and
// the 'ez:theme' event stay platform-owned — this module only reacts to them.

const THEME_VARS_STYLE_ID = 'ez-theme-vars';

// theme-effects-font M3 (Wave 3): the ThemeMod→ThemeDefinition converter, shared
// by desktop (App.tsx) and mobile (theme.ts) — both fed a validated ThemeMod
// (folder-scan or Import) here to fill in the fields ThemeDefinition requires
// but ThemeModSchema leaves optional. Built-ins ship with a fixed
// fontFamily/fontSize, so a mod that omits either falls back to the 'dark'
// built-in's — same "old settings.json without a field still works" spirit as
// fonts.ts's resolveFontFamily fallback.
export function themeModToDefinition(mod: ThemeMod): ThemeDefinition {
  const definition: ThemeDefinition = {
    id: mod.id,
    name: mod.name,
    cssVars: mod.cssVars,
    xterm: mod.xterm,
    fontFamily: mod.fontFamily ?? THEMES.dark.fontFamily,
    fontSize: mod.fontSize ?? THEMES.dark.fontSize,
    effects: mod.effects,
    swatch: mod.swatch,
  };
  return {
    ...definition,
    ui: mod.schemaVersion === 2 ? mod.ui : seedUiThemeColors(definition, THEMES.dark.ui!),
  };
}

/** Lazily create the single `#ez-theme-vars` <style> node and append it to
 * <head> AFTER index.css so its declarations win cascade ties against the
 * built-in `[data-theme]` blocks. Idempotent — a later call returns the same
 * node rather than creating a second one. */
export function ensureThemeVarsStyleEl(): HTMLStyleElement {
  const existing = document.getElementById(THEME_VARS_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement('style');
  style.id = THEME_VARS_STYLE_ID;
  document.head.appendChild(style);
  return style;
}

/** `resolveActiveEffects` wants a value for every catalog id; a caller's
 * `platformDefaults` only needs to name the ones it cares about defaulting on
 * (e.g. desktop passes the theme's own declared defaults, mobile passes none
 * — AC-E5), so anything absent here defaults to off. */
function normalizePlatformDefaults(partial: Partial<Record<EffectId, boolean>>): Record<EffectId, boolean> {
  const full = {} as Record<EffectId, boolean>;
  for (const id of Object.keys(EFFECT_CATALOG) as EffectId[]) {
    full[id] = partial[id] ?? false;
  }
  return full;
}

/**
 * The shared apply-path helper (plan: "Apply path (shared)"). Resolves the
 * theme already applied via `data-theme`, writes its `cssVars` into
 * `#ez-theme-vars` (built-ins clear the block — their vars live in index.css
 * instead), and applies its declared effects gated by `opts`.
 */
export function applyThemeVarsAndEffects(
  themeName: string,
  opts: { effectToggles: Record<string, boolean>; platformDefaults: Partial<Record<EffectId, boolean>> },
): void {
  const styleEl = ensureThemeVarsStyleEl();
  const theme = getActiveTheme();
  if (isBuiltinTheme(themeName)) {
    styleEl.textContent = '';
  } else {
    const effectiveVars = {
      ...theme.cssVars,
      ...(theme.ui ? uiThemeColorsToCssVars(theme.ui) : {}),
    };
    const decls = Object.entries(effectiveVars)
      .map(([key, value]) => `${key}:${value};`)
      .join('');
    // CSS.escape guards against a hostile id breaking out of this selector —
    // defense-in-depth on top of theme-schema.ts's ThemeIdSchema charset
    // restriction at registration time.
    styleEl.textContent = `[data-theme="${CSS.escape(themeName)}"] { ${decls} }`;
  }
  applyEffects(resolveActiveEffects(theme, opts.effectToggles, normalizePlatformDefaults(opts.platformDefaults)));
}

// ── user font override seam ──────────────────────────────────────────────────
// Module-scoped, in-memory only. Wave 3 calls `setUserFontId(persistedId)` at
// boot and on change (then dispatches 'ez:theme' to re-apply typography);
// PtyBlock's applyTypography reads it via `getUserFontId()`.

let userFontId: string | undefined;

export function getUserFontId(): string | undefined {
  return userFontId;
}

export function setUserFontId(id: string | undefined): void {
  userFontId = id;
}
