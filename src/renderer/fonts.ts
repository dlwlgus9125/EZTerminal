import type { ThemeDefinition } from './themes';

// Bundled font catalog (theme-effects-font M0/M2) — a curated, CSP-safe
// (`font-src 'self'`) list surfaced as a Settings dropdown (desktop +
// mobile). Every entry but `cascadia` (already shipped as the app's default,
// no @font-face needed) ships a self-hosted woff2 under
// `src/renderer/fonts/` — verifying that presence is the CSS/font wave's job
// (the plan's M3 FONT_CATALOG guard test), not this module's.

export interface FontCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly fontFamily: string;
  readonly systemDefault?: boolean;
}

export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  {
    id: 'cascadia',
    label: 'Cascadia Code',
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
    systemDefault: true,
  },
  {
    id: 'share-tech-mono',
    label: 'Share Tech Mono',
    fontFamily: '"Share Tech Mono", "Cascadia Code", Consolas, monospace',
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    fontFamily: '"Fira Code", "Cascadia Code", Consolas, monospace',
  },
];

/** User font override, layered on top of the active theme's own font (plan:
 * `userFont ?? themeFont`). An unrecognized or absent id falls back to the
 * theme's font — an old settings.json (no fontFamily) or a typo'd id keeps
 * working instead of rendering with no font at all. */
export function resolveFontFamily(userFontId: string | undefined, theme: ThemeDefinition): string {
  const entry = userFontId === undefined ? undefined : FONT_CATALOG.find((f) => f.id === userFontId);
  return entry ? entry.fontFamily : theme.fontFamily;
}
