/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  calculateContrastRatio,
  cssColorToRgbChannels,
  resolveProviderIdentityColors,
  resolveAccessibleTheme,
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
    expect(vars['--ui-accent-rgb']).toBe('53, 229, 143');
    expect(vars['--ui-info-rgb']).toBe('98, 216, 255');
    expect(vars['--ui-success-rgb']).toBe('53, 229, 143');
    expect(vars['--ui-warning-rgb']).toBe('255, 209, 102');
    expect(vars['--ui-danger-rgb']).toBe('255, 107, 122');
    expect(Object.keys(vars)).toHaveLength(22);
  });
});
