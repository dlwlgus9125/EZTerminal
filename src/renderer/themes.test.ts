/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  THEMES,
  THEME_ORDER,
  getActiveTheme,
  getActiveThemeName,
  getResolvedTheme,
  listThemes,
  registerTheme,
  resolveTheme,
  type ThemeDefinition,
} from './themes';

function customTheme(id: string, overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return {
    id,
    name: id,
    cssVars: { '--term-bg': '#111111' },
    xterm: { background: '#111111', foreground: '#eeeeee' },
    fontFamily: '"Test Mono", monospace',
    fontSize: 13,
    ...overrides,
  };
}

describe('themes — built-ins', () => {
  it('THEME_ORDER lists exactly the 4 built-ins', () => {
    expect(THEME_ORDER).toEqual(['dark', 'light', 'high-contrast', 'matrix']);
  });

  it('matrix declares the CRT effect set incl. the interference quartet (AC-E1, crt-interference)', () => {
    expect(THEMES.matrix.effects).toEqual([
      'scanlines',
      'phosphor-glow',
      'crt-rollbar',
      'scanline-scroll',
      'flicker',
      'jitter-burst',
      'micro-jitter',
      'static-noise',
    ]);
  });

  it('dark/light/high-contrast declare no effects', () => {
    expect(THEMES.dark.effects).toBeUndefined();
    expect(THEMES.light.effects).toBeUndefined();
    expect(THEMES['high-contrast'].effects).toBeUndefined();
  });

  it('each built-in has a swatch matching the mobile ThemeMenu pairs', () => {
    expect(THEMES.dark.swatch).toEqual({ bg: '#0c0c0c', accent: '#29d398' });
    expect(THEMES.light.swatch).toEqual({ bg: '#f5f5f5', accent: '#0e8a4b' });
    expect(THEMES['high-contrast'].swatch).toEqual({ bg: '#000000', accent: '#00ff66' });
    expect(THEMES.matrix.swatch).toEqual({ bg: '#010301', accent: '#35e58f' });
  });

  it('all built-ins satisfy the functional contrast contract without runtime correction', () => {
    for (const id of THEME_ORDER) {
      const resolved = resolveTheme(id);
      expect(resolved.effectiveId).toBe(id);
      expect(resolved.adjustments, id).toEqual([]);
      expect(resolved.theme).toBe(THEMES[id]);
    }
  });
});

describe('themes — registry', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it('registerTheme rejects an id colliding with a built-in (warn + no-op)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerTheme(customTheme('dark', { name: 'Fake Dark' }));
    expect(listThemes().find((t) => t.id === 'dark')?.name).toBe('Dark'); // real built-in, unshadowed
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('listThemes returns built-ins ∪ registered mods', () => {
    registerTheme(customTheme('registry-mod-a'));
    const ids = listThemes().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['dark', 'light', 'high-contrast', 'matrix', 'registry-mod-a']));
  });

  it('AC-T7: getActiveTheme() resolves a registered custom theme to ITS OWN xterm, not dark', () => {
    registerTheme(
      customTheme('neon', {
        xterm: { background: '#ff00ff', foreground: '#00ffff' },
      }),
    );
    document.documentElement.dataset.theme = 'neon';
    const active = getActiveTheme();
    expect(active.id).toBe('neon');
    expect(active.xterm.background).toBe('#ff00ff');
    expect(active.xterm.foreground).not.toBe(THEMES.dark.xterm.foreground);
    expect(active.xterm).not.toEqual(THEMES.dark.xterm);
    expect(getResolvedTheme().adjustments.some((adjustment) => adjustment.role === 'terminalForeground')).toBe(true);
  });

  it('getActiveTheme() falls back to dark for an absent data-theme', () => {
    expect(getActiveTheme()).toBe(THEMES.dark);
  });

  it('preserves an unknown requested id while using Matrix as the effective fallback', () => {
    document.documentElement.dataset.theme = 'never-registered';
    expect(getActiveTheme()).toBe(THEMES.matrix);
    expect(getResolvedTheme()).toMatchObject({
      requestedId: 'never-registered',
      effectiveId: 'matrix',
      fallbackReason: 'missing-custom-theme',
    });
    expect(getActiveThemeName()).toBe('never-registered');
  });

  it('getActiveTheme() resolves a built-in by attribute', () => {
    document.documentElement.dataset.theme = 'matrix';
    expect(getActiveTheme()).toBe(THEMES.matrix);
  });

  it('getActiveThemeName() returns the raw attribute (not narrowed to the 4 built-ins)', () => {
    document.documentElement.dataset.theme = 'some-custom-id';
    expect(getActiveThemeName()).toBe('some-custom-id');
  });

  it('getActiveThemeName() defaults to "dark" when absent', () => {
    expect(getActiveThemeName()).toBe('dark');
  });
});
