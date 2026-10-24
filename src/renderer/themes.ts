import type { ITheme } from '@xterm/xterm';
import { isBuiltinTheme, type ThemeName } from '../shared/layout-schema';
import type { UiThemeColors } from '../shared/theme-schema';
import { resolveAccessibleTheme } from './theme-contrast';

// Built-in themes (E1) — single source of truth for the renderer. Chrome colors
// are applied by setting `data-theme` on <html> and letting index.css's
// `[data-theme='...']` blocks override the --term-* vars declared here (CSS
// can't import this file, so the blocks mirror `cssVars` by hand). xterm has no
// concept of CSS variables, so PtyBlock reads `xterm`/`fontFamily`/`fontSize`
// straight from this object instead.
//
// theme-effects-font M0: `THEMES` now coexists with a runtime registry of
// externally-supplied theme mods (see `registerTheme`/`listThemes` below).
// `ThemeName` (shared/layout-schema.ts) is an open, validated string rather
// than a closed enum, so a custom mod can carry any id that passes
// `validateThemeMod` (shared/theme-schema.ts). `getActiveTheme()` is now THE
// single accessor that resolves either kind — see its own doc comment.

const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';
const FONT_SIZE = 13;

// Matrix theme (E1+): a monospace "digital rain / CRT" skin. Share Tech Mono is
// the primary face; it must be loaded by the renderer (see index.css — @import
// or self-hosted @font-face) or xterm silently falls back to the next in the
// stack. Kept slightly larger (14) so the lighter Share Tech Mono glyphs stay
// legible at terminal density.
const MATRIX_FONT_FAMILY = '"Share Tech Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace';
const MATRIX_FONT_SIZE = 14;

export interface ThemeDefinition {
  /** Stable identity — the `data-theme` attribute value / registry key. For a
   * built-in this equals its THEMES key; for a mod it's `ThemeMod.id`. */
  readonly id: string;
  /** Display name (theme picker / Settings dropdown). */
  readonly name: string;
  /** --term-* CSS variable overrides mirrored in index.css's [data-theme] block.
   * Empty for 'dark': its values ARE the :root defaults (no override needed). */
  readonly cssVars: Readonly<Record<string, string>>;
  /** Semantic application chrome. Optional only for directly registered
   * legacy definitions; resolution deterministically seeds it from terminal
   * colors before the theme is applied. */
  readonly ui?: UiThemeColors;
  readonly xterm: ITheme;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** Effect catalog ids (renderer/effects.ts) this theme opts into — an
   * effect not listed here never activates regardless of the user's toggle. */
  readonly effects?: readonly string[];
  /** Theme-picker swatch pair; independent of `cssVars`/`xterm` because a
   * picker wants ONE representative bg/accent, not the full palette. */
  readonly swatch?: { readonly bg: string; readonly accent: string };
}

export interface ThemeAdjustment {
  readonly role: keyof UiThemeColors | 'terminalForeground' | 'terminalCursor';
  readonly before: string;
  readonly after: string;
  readonly requiredRatio: number;
  readonly achievedRatio: number;
}

export interface ResolvedTheme {
  readonly requestedId: string;
  readonly effectiveId: string;
  readonly theme: ThemeDefinition;
  readonly adjustments: readonly ThemeAdjustment[];
  readonly fallbackReason?: 'missing-custom-theme' | 'invalid-custom-theme';
}

/** Cycle order for the theme button (E1) — also the theme picker's row order (M2). */
export const THEME_ORDER: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

export const THEMES: Readonly<Record<ThemeName, ThemeDefinition>> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    cssVars: {},
    ui: {
      canvas: '#1b1a18',
      surface: '#22211f',
      surfaceRaised: '#2b2a27',
      surfaceInset: '#161513',
      textPrimary: '#ecebe6',
      textSecondary: '#bdbab1',
      textMuted: '#9e9b92',
      textInverse: '#1b1a18',
      borderSubtle: '#363430',
      borderStrong: '#78756d',
      accent: '#7aa7ff',
      onAccent: '#0a1730',
      focus: '#9dbdff',
      info: '#7aa7ff',
      success: '#62c08f',
      warning: '#e2ae58',
      danger: '#f47a74',
    },
    // Terminal panes sit on the same warm canvas as the rest of the workbench.
    xterm: {
      background: '#1b1a18',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
      cursorAccent: '#1b1a18',
    },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    swatch: { bg: '#1b1a18', accent: '#7aa7ff' },
  },
  light: {
    id: 'light',
    name: 'Light',
    cssVars: {
      '--term-bg': '#faf9f6',
      '--term-bg-raised': '#ffffff',
      '--term-bg-inset': '#f2f0eb',
      '--term-bg-hover': 'rgba(0, 0, 0, 0.05)',
      '--term-border': '#e4e1da',
      '--term-border-faint': '#eeebe5',
      '--term-fg': '#1c1c1c',
      '--term-fg-bright': '#000000',
      '--term-fg-dim': '#5f5f5f',
      '--term-fg-faint': '#8f8f8f',
      '--term-green': '#0e8a4b',
      '--term-red': '#c62839',
      '--term-amber': '#9a6a00',
      '--term-cyan': '#0f7c8c',
      '--term-blue': '#1857c4',
      '--term-selection': 'rgba(47, 95, 208, 0.18)',
    },
    ui: {
      canvas: '#faf9f6',
      surface: '#ffffff',
      surfaceRaised: '#ffffff',
      surfaceInset: '#f2f0eb',
      textPrimary: '#1c1b19',
      textSecondary: '#4a4843',
      textMuted: '#6b6861',
      textInverse: '#ffffff',
      borderSubtle: '#e4e1da',
      borderStrong: '#7d7a72',
      accent: '#2f5fd0',
      onAccent: '#ffffff',
      focus: '#2f5fd0',
      info: '#2f5fd0',
      success: '#1a7a4f',
      warning: '#8a5a00',
      danger: '#b42d38',
    },
    // cursor/cursorAccent explicit (unlike dark): a default white cursor would
    // be invisible on this light background.
    xterm: {
      background: '#faf9f6',
      foreground: '#1c1c1c',
      cursor: '#1c1c1c',
      cursorAccent: '#faf9f6',
    },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    swatch: { bg: '#faf9f6', accent: '#2f5fd0' },
  },
  'high-contrast': {
    id: 'high-contrast',
    name: 'High Contrast',
    cssVars: {
      '--term-bg': '#000000',
      '--term-bg-raised': '#000000',
      '--term-bg-inset': '#000000',
      '--term-bg-hover': 'rgba(255, 255, 255, 0.15)',
      '--term-border': '#ffffff',
      '--term-border-faint': '#808080',
      '--term-fg': '#ffffff',
      '--term-fg-bright': '#ffffff',
      '--term-fg-dim': '#d0d0d0',
      '--term-fg-faint': '#a0a0a0',
      '--term-green': '#00ff66',
      '--term-red': '#ff3b3b',
      '--term-amber': '#ffcc00',
      '--term-cyan': '#00e5ff',
      '--term-blue': '#66b2ff',
      '--term-selection': 'rgba(0, 255, 102, 0.35)',
    },
    ui: {
      canvas: '#000000',
      surface: '#000000',
      surfaceRaised: '#000000',
      surfaceInset: '#000000',
      textPrimary: '#ffffff',
      textSecondary: '#ffffff',
      textMuted: '#d0d0d0',
      textInverse: '#000000',
      borderSubtle: '#808080',
      borderStrong: '#ffffff',
      accent: '#00ff66',
      onAccent: '#000000',
      focus: '#00e5ff',
      info: '#66b2ff',
      success: '#00ff66',
      warning: '#ffcc00',
      danger: '#ff5c5c',
    },
    xterm: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#000000',
    },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    swatch: { bg: '#000000', accent: '#00ff66' },
  },
  // Matrix (E1+) — near-black bg with a green phosphor foreground ramp. Mirror
  // these cssVars in index.css's [data-theme='matrix'] block by hand. The xterm
  // ITheme sets ONLY background/foreground/cursor/selection — the 16 ANSI colors
  // are intentionally left at xterm's defaults so an agent TUI (Claude Code /
  // Codex) keeps its own colour coding; the green "glow" over xterm is a CSS
  // filter in index.css, not an ANSI remap.
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    cssVars: {
      '--term-bg': '#040806',
      '--term-bg-raised': '#0c1511',
      '--term-bg-inset': '#020504',
      '--term-bg-hover': 'rgba(58, 232, 148, 0.08)',
      '--term-border': '#26392f',
      '--term-border-faint': '#18261f',
      '--term-fg': '#c4f2d8',
      '--term-fg-bright': '#e8faf0',
      '--term-fg-dim': '#8fb7a1',
      '--term-fg-faint': '#88a897',
      '--term-green': '#3ae894',
      '--term-red': '#ff7a6a',
      '--term-amber': '#f3c45b',
      '--term-cyan': '#6fd6e8',
      '--term-blue': '#66a8ff',
      '--term-selection': 'rgba(58, 232, 148, 0.28)',
    },
    ui: {
      canvas: '#070d0a',
      surface: '#0c1511',
      surfaceRaised: '#111d17',
      surfaceInset: '#020504',
      textPrimary: '#dcefe4',
      textSecondary: '#a6c4b3',
      textMuted: '#88a897',
      textInverse: '#04120b',
      borderSubtle: '#18261f',
      borderStrong: '#4b6e5b',
      accent: '#3ae894',
      onAccent: '#001c0d',
      focus: '#8affba',
      info: '#6fd6e8',
      success: '#8fe3b4',
      warning: '#f3c45b',
      danger: '#ff7a6a',
    },
    xterm: {
      background: '#040806',
      foreground: '#c4f2d8',
      cursor: '#8affba',
      cursorAccent: '#040806',
      selectionBackground: 'rgba(58, 232, 148, 0.3)',
    },
    fontFamily: MATRIX_FONT_FAMILY,
    fontSize: MATRIX_FONT_SIZE,
    effects: [
      'scanlines',
      'phosphor-glow',
      'crt-rollbar',
      'scanline-scroll',
      'flicker',
      'jitter-burst',
      'micro-jitter',
      'static-noise',
    ],
    swatch: { bg: '#070d0a', accent: '#3ae894' },
  },
};

// ── custom-theme registry (theme-effects-font M0) ────────────────────────────
// Mods registered at runtime (desktop folder-scan / Import, mobile Import).
// Built-ins are NOT stored here; they live in `THEMES` and always win an id
// collision (registerTheme warns+no-ops rather than letting a mod shadow
// one). Module-level Map — one registry per renderer process, matching how
// `THEMES` itself is a module singleton.
const customThemes = new Map<string, ThemeDefinition>();

/** Register a validated custom theme (desktop folder-scan / Import path —
 * callers pass the ThemeDefinition built from a `validateThemeMod` result).
 * Silently rejects (console.warn, no-op) an id that collides with a built-in
 * — built-ins always win. `validateThemeMod` already blocks this at the
 * mod-authoring stage, so this is defense-in-depth for direct callers. */
export function registerTheme(def: ThemeDefinition): void {
  if (isBuiltinTheme(def.id)) {
    console.warn(`registerTheme: "${def.id}" collides with a built-in theme id — ignoring`);
    return;
  }
  customThemes.set(def.id, def);
}

/** All themes available to pick from: built-ins first (THEME_ORDER), then
 * registered mods in registration order. */
export function listThemes(): ThemeDefinition[] {
  return [...THEME_ORDER.map((name) => THEMES[name]), ...customThemes.values()];
}

/** Resolve against built-ins and the custom registry, applying contrast
 * correction to an effective copy. Missing custom ids intentionally fall back
 * to Dark without replacing the requested/persisted identity. */
export function resolveTheme(
  requestedId: string,
  missingReason: ResolvedTheme['fallbackReason'] = 'missing-custom-theme',
): ResolvedTheme {
  const builtin = isBuiltinTheme(requestedId) ? THEMES[requestedId] : undefined;
  const registered = builtin ?? customThemes.get(requestedId);
  const source = registered ?? THEMES.dark;
  const accessible = resolveAccessibleTheme(source, THEMES.dark.ui!);
  return {
    requestedId,
    effectiveId: source.id,
    theme: accessible.theme,
    adjustments: accessible.adjustments,
    ...(registered ? {} : { fallbackReason: missingReason }),
  };
}

export function getResolvedTheme(): ResolvedTheme {
  const requestedId = document.documentElement.dataset.theme;
  return resolveTheme(requestedId ?? 'dark');
}

export function getActiveTheme(): ThemeDefinition {
  return getResolvedTheme().theme;
}

/** Read the theme name currently applied to the document (App sets this
 * attribute before dispatching 'ez:theme'). Post-M0 this returns the RAW
 * attribute string (dropped the old 4-literal narrowing) — resolve an actual
 * ThemeDefinition through `getActiveTheme()`, not by indexing `THEMES` with
 * this value (see its doc comment). Retained for raw-attribute reads that only
 * need the id, not a resolved ThemeDefinition (e.g.
 * mobile/src/MobileSettingsView.tsx reading the active theme id) — xterm
 * resolution goes through `getActiveTheme()` instead. */
export function getActiveThemeName(): string {
  return document.documentElement.dataset.theme ?? 'dark';
}
