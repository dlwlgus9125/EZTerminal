import type { ITheme } from '@xterm/xterm';
import { isBuiltinTheme, type ThemeName } from '../shared/layout-schema';

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

/** Cycle order for the theme button (E1) — also the theme picker's row order (M2). */
export const THEME_ORDER: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

export const THEMES: Readonly<Record<ThemeName, ThemeDefinition>> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    cssVars: {},
    // Exactly the values PtyBlock hardcoded pre-E1 — pixel-identical default.
    xterm: { background: '#0c0c0c', foreground: '#e6e6e6' },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    swatch: { bg: '#0c0c0c', accent: '#29d398' },
  },
  light: {
    id: 'light',
    name: 'Light',
    cssVars: {
      '--term-bg': '#f5f5f5',
      '--term-bg-raised': '#ffffff',
      '--term-bg-inset': '#ececec',
      '--term-bg-hover': 'rgba(0, 0, 0, 0.05)',
      '--term-border': '#d0d0d0',
      '--term-border-faint': '#e2e2e2',
      '--term-fg': '#1c1c1c',
      '--term-fg-bright': '#000000',
      '--term-fg-dim': '#5f5f5f',
      '--term-fg-faint': '#8f8f8f',
      '--term-green': '#0e8a4b',
      '--term-red': '#c62839',
      '--term-amber': '#9a6a00',
      '--term-cyan': '#0f7c8c',
      '--term-blue': '#1857c4',
      '--term-selection': 'rgba(14, 138, 75, 0.18)',
    },
    // cursor/cursorAccent explicit (unlike dark): a default white cursor would
    // be invisible on this light background.
    xterm: {
      background: '#f5f5f5',
      foreground: '#1c1c1c',
      cursor: '#1c1c1c',
      cursorAccent: '#f5f5f5',
    },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    swatch: { bg: '#f5f5f5', accent: '#0e8a4b' },
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
      '--term-bg': '#010301',
      '--term-bg-raised': '#071007',
      '--term-bg-inset': '#020402',
      '--term-bg-hover': 'rgba(41, 211, 152, 0.08)',
      '--term-border': '#12492a',
      '--term-border-faint': '#0a2a15',
      '--term-fg': '#5fe7ac',
      '--term-fg-bright': '#c7ffe4',
      '--term-fg-dim': '#1c9d6c',
      '--term-fg-faint': '#0f6a48',
      '--term-green': '#29d398',
      '--term-red': '#ff4d5e',
      '--term-amber': '#f5c451',
      '--term-cyan': '#1fb6c9',
      '--term-blue': '#4db8ff',
      '--term-selection': 'rgba(41, 211, 152, 0.25)',
    },
    xterm: {
      background: '#010301',
      foreground: '#5fe7ac',
      cursor: '#7dffb0',
      cursorAccent: '#010301',
      selectionBackground: 'rgba(41, 211, 152, 0.28)',
    },
    fontFamily: MATRIX_FONT_FAMILY,
    fontSize: MATRIX_FONT_SIZE,
    effects: ['scanlines', 'phosphor-glow', 'crt-rollbar', 'scanline-scroll'],
    swatch: { bg: '#010301', accent: '#5fe7ac' },
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

/**
 * THE single theme accessor (theme-effects-font M0) — resolves the DOM's raw
 * `data-theme` attribute against built-ins ∪ the custom registry, falling
 * back to 'dark' for an absent/unknown value (a deleted-mod-on-relaunch, or a
 * value set before its registerTheme() call has run). Both theming channels
 * should read through this: chrome CSS vars and the terminal (xterm).
 * PtyBlock.tsx resolves through this accessor too — the old
 * `THEMES[getActiveThemeName()]` indexing (unsound for a custom theme id) was
 * migrated away in the same wave that added this function.
 */
export function getActiveTheme(): ThemeDefinition {
  const attr = document.documentElement.dataset.theme;
  if (attr !== undefined) {
    const builtin = THEMES[attr];
    if (builtin) return builtin;
    const custom = customThemes.get(attr);
    if (custom) return custom;
  }
  return THEMES.dark;
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
