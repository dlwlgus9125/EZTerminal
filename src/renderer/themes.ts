import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../shared/layout-schema';

// Built-in themes (E1) — single source of truth for the renderer. Chrome colors
// are applied by setting `data-theme` on <html> and letting index.css's
// `[data-theme='...']` blocks override the --term-* vars declared here (CSS
// can't import this file, so the blocks mirror `cssVars` by hand). xterm has no
// concept of CSS variables, so PtyBlock reads `xterm`/`fontFamily`/`fontSize`
// straight from this object instead.

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
  /** --term-* CSS variable overrides mirrored in index.css's [data-theme] block.
   * Empty for 'dark': its values ARE the :root defaults (no override needed). */
  readonly cssVars: Readonly<Record<string, string>>;
  readonly xterm: ITheme;
  readonly fontFamily: string;
  readonly fontSize: number;
}

/** Cycle order for the theme button (E1) — also the theme picker's row order (M2). */
export const THEME_ORDER: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

export const THEMES: Readonly<Record<ThemeName, ThemeDefinition>> = {
  dark: {
    cssVars: {},
    // Exactly the values PtyBlock hardcoded pre-E1 — pixel-identical default.
    xterm: { background: '#0c0c0c', foreground: '#e6e6e6' },
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
  },
  light: {
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
  },
  'high-contrast': {
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
  },
  // Matrix (E1+) — near-black bg with a green phosphor foreground ramp. Mirror
  // these cssVars in index.css's [data-theme='matrix'] block by hand. The xterm
  // ITheme sets ONLY background/foreground/cursor/selection — the 16 ANSI colors
  // are intentionally left at xterm's defaults so an agent TUI (Claude Code /
  // Codex) keeps its own colour coding; the green "glow" over xterm is a CSS
  // filter in index.css, not an ANSI remap.
  matrix: {
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
  },
};

/** Read the theme currently applied to the document (App sets this attribute
 * before dispatching 'ez:theme'), defaulting to 'dark' for an absent/unknown
 * value. PtyBlock uses this both at mount and on every 'ez:theme' event. */
export function getActiveThemeName(): ThemeName {
  const attr = document.documentElement.dataset.theme;
  return attr === 'light' || attr === 'high-contrast' || attr === 'matrix' ? attr : 'dark';
}
