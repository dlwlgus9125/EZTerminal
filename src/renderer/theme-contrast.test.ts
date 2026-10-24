/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  calculateContrastRatio,
  cssColorToRgbChannels,
  resolveProviderIdentityColors,
  resolveAccessibleTheme,
  seedTerminalCssVars,
  seedUiThemeColors,
  uiThemeColorsToCssVars,
} from './theme-contrast';
import { THEMES, type ThemeDefinition } from './themes';

describe('theme contrast math', () => {
  it('implements WCAG relative-luminance contrast for supported CSS formats', () => {
    expect(calculateContrastRatio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(calculateContrastRatio('rgb(0, 0, 0)', 'hsl(0, 0%, 100%)')).toBeCloseTo(21, 5);
    expect(calculateContrastRatio('white', 'black')).toBeCloseTo(21, 5);
  });

  it('derives WebView-compatible RGB channels without extending theme data', () => {
    expect(cssColorToRgbChannels('#35e58f')).toBe('53, 229, 143');
    expect(cssColorToRgbChannels('rgb(8 120 71)')).toBe('8, 120, 71');
    expect(cssColorToRgbChannels('not-a-color')).toBeNull();
  });

  it('derives custom-theme provider colors with text contrast on every history surface', () => {
    for (const ui of [THEMES.dark.ui!, THEMES.light.ui!]) {
      const providers = resolveProviderIdentityColors(ui);
      for (const color of Object.values(providers)) {
        for (const surface of [ui.surface, ui.surfaceRaised, ui.surfaceInset]) {
          expect(calculateContrastRatio(color, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('minimally corrects functional roles and reports each before/after without mutating source', () => {
    const source: ThemeDefinition = {
      id: 'low-contrast',
      name: 'Low Contrast',
      cssVars: {},
      ui: {
        canvas: '#777777',
        surface: '#777777',
        surfaceRaised: '#777777',
        surfaceInset: '#777777',
        textPrimary: '#777777',
        textSecondary: '#777777',
        textMuted: '#777777',
        textInverse: '#000000',
        borderSubtle: '#777777',
        borderStrong: '#777777',
        accent: '#777777',
        onAccent: '#777777',
        focus: '#777777',
        info: '#777777',
        success: '#777777',
        warning: '#777777',
        danger: '#777777',
      },
      xterm: { background: '#777777', foreground: '#777777', cursor: '#777777' },
      fontFamily: 'monospace',
      fontSize: 13,
    };
    const snapshot = structuredClone(source);
    const resolved = resolveAccessibleTheme(source, THEMES.dark.ui!);

    expect(source).toEqual(snapshot);
    expect(resolved.adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'textPrimary', before: '#777777', requiredRatio: 4.5 }),
        expect.objectContaining({ role: 'focus', before: '#777777', requiredRatio: 3 }),
        expect.objectContaining({ role: 'terminalForeground', before: '#777777', requiredRatio: 4.5 }),
        expect.objectContaining({ role: 'terminalCursor', before: '#777777', requiredRatio: 3 }),
      ]),
    );
    expect(calculateContrastRatio(resolved.theme.ui!.textPrimary, resolved.theme.ui!.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(calculateContrastRatio(resolved.theme.ui!.focus, resolved.theme.ui!.surface)).toBeGreaterThanOrEqual(3);
    expect(calculateContrastRatio(resolved.theme.xterm.foreground!, resolved.theme.xterm.background!)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(calculateContrastRatio(resolved.theme.xterm.cursor!, resolved.theme.xterm.background!)).toBeGreaterThanOrEqual(3);
  });
});

describe('terminal-chrome seeding for custom themes', () => {
  it('takes the background from the xterm canvas and the rest from the ui palette', () => {
    const ui = THEMES.light.ui!;
    const vars = seedTerminalCssVars(ui, { background: '#fdfdfd' });
    expect(vars).toMatchObject({
      '--term-bg': '#fdfdfd',
      '--term-bg-raised': ui.surfaceRaised,
      '--term-bg-inset': ui.surfaceInset,
      '--term-border': ui.borderSubtle,
      '--term-fg': ui.textPrimary,
      '--term-fg-dim': ui.textSecondary,
      '--term-green': ui.success,
      '--term-red': ui.danger,
      '--term-amber': ui.warning,
      '--term-blue': ui.info,
    });
    expect(vars['--term-selection']).toMatch(/^rgba\(/u);
  });

  // Any --term-* colour the chrome reads must be seeded, or a ui-only custom theme
  // shows the :root dark value there while the rest of the app follows the theme.
  it('covers every --term-* colour the desktop and mobile foundation sheets read', () => {
    const read = (file: string): string => readFileSync(resolve(process.cwd(), 'src/renderer', file), 'utf8');
    const used = new Set(
      [...`${read('index.css')}\n${read('mobile-shared.css')}`.matchAll(/var\(\s*(--term-[a-z-]+)/gu)]
        .map((match) => match[1])
        .filter((name) => name !== '--term-font'),
    );
    const seeded = Object.keys(seedTerminalCssVars(THEMES.dark.ui!, {}));
    expect([...used].filter((name) => !seeded.includes(name))).toEqual([]);
  });
});

describe('legacy UI palette seeding', () => {
  it('maps known --term-* roles without changing the legacy definition', () => {
    const legacy: ThemeDefinition = {
      id: 'legacy',
      name: 'Legacy',
      cssVars: {
        '--term-bg': '#101010',
        '--term-bg-raised': '#181818',
        '--term-fg': '#eeeeee',
        '--term-green': '#00dd88',
        '--term-red': '#ff5566',
      },
      xterm: { background: '#101010', foreground: '#eeeeee' },
      fontFamily: 'monospace',
      fontSize: 13,
    };
    const ui = seedUiThemeColors(legacy, THEMES.dark.ui!);
    expect(ui).toMatchObject({
      canvas: '#101010',
      surface: '#181818',
      textPrimary: '#eeeeee',
      accent: '#00dd88',
      danger: '#ff5566',
    });
    expect(legacy.ui).toBeUndefined();
  });

  it('emits the complete stable --ui-* variable map', () => {
    const vars = uiThemeColorsToCssVars(THEMES.matrix.ui!);
    expect(vars['--ui-canvas']).toBe(THEMES.matrix.ui!.canvas);
    expect(vars['--ui-surface-raised']).toBe(THEMES.matrix.ui!.surfaceRaised);
    expect(vars['--ui-text-primary']).toBe(THEMES.matrix.ui!.textPrimary);
    expect(vars['--ui-on-accent']).toBe(THEMES.matrix.ui!.onAccent);
    expect(vars['--ui-danger']).toBe(THEMES.matrix.ui!.danger);
    expect(vars['--ui-accent-rgb']).toBe('58, 232, 148');
    expect(vars['--ui-info-rgb']).toBe('111, 214, 232');
    expect(vars['--ui-success-rgb']).toBe('143, 227, 180');
    expect(vars['--ui-warning-rgb']).toBe('243, 196, 91');
    expect(vars['--ui-danger-rgb']).toBe('255, 122, 106');
    expect(Object.keys(vars)).toHaveLength(22);
  });
});
