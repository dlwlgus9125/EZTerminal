import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FONT_CATALOG, resolveFontFamily } from './fonts';
import type { ThemeDefinition } from './themes';

const THEME_FONT = '"Theme Font", monospace';

// Non-systemDefault catalog entry id -> its self-hosted woff2 filename under
// ./fonts (mirrors the @font-face src paths in index.css). A future catalog
// entry that forgets to ship/declare its woff2 fails HERE instead of silently
// falling back to the next font in the CSS stack at runtime (MAJOR-2 / M3).
const CATALOG_WOFF2: Readonly<Record<string, string>> = {
  'share-tech-mono': 'share-tech-mono-latin.woff2',
  'jetbrains-mono': 'jetbrains-mono-latin.woff2',
  'fira-code': 'fira-code-latin.woff2',
};

function theme(): ThemeDefinition {
  return { id: 't', name: 'T', cssVars: {}, xterm: {}, fontFamily: THEME_FONT, fontSize: 13 };
}

describe('FONT_CATALOG', () => {
  it('lists the 4 spec-d entries with exact fontFamily strings', () => {
    expect(FONT_CATALOG.map((f) => f.id)).toEqual(['cascadia', 'share-tech-mono', 'jetbrains-mono', 'fira-code']);
    expect(FONT_CATALOG.find((f) => f.id === 'jetbrains-mono')?.fontFamily).toBe(
      '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    );
    expect(FONT_CATALOG.find((f) => f.id === 'fira-code')?.fontFamily).toBe(
      '"Fira Code", "Cascadia Code", Consolas, monospace',
    );
  });

  it('only cascadia is marked systemDefault', () => {
    expect(FONT_CATALOG.filter((f) => f.systemDefault).map((f) => f.id)).toEqual(['cascadia']);
  });

  it('every non-systemDefault entry has its bundled woff2 present on disk', () => {
    for (const entry of FONT_CATALOG) {
      if (entry.systemDefault) continue;
      const file = CATALOG_WOFF2[entry.id];
      expect(file).toBeDefined(); // catalog entry with no known woff2 filename mapped above
      expect(existsSync(path.join(__dirname, 'fonts', file))).toBe(true);
    }
  });
});

describe('resolveFontFamily — precedence', () => {
  it('a known userFontId wins over the theme font', () => {
    expect(resolveFontFamily('fira-code', theme())).toBe('"Fira Code", "Cascadia Code", Consolas, monospace');
  });

  it('an unknown userFontId falls back to the theme font', () => {
    expect(resolveFontFamily('nonexistent', theme())).toBe(THEME_FONT);
  });

  it('an absent userFontId falls back to the theme font', () => {
    expect(resolveFontFamily(undefined, theme())).toBe(THEME_FONT);
  });
});
