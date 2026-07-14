/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  applyThemeVarsAndEffects,
  ensureThemeVarsStyleEl,
  getUserFontId,
  setUserFontId,
  themeModToDefinition,
} from './theme-runtime';
import { THEMES, registerTheme, type ThemeDefinition } from './themes';

// jsdom (unlike the real Chromium renderer this app ships in) doesn't implement
// the `CSS.escape` global theme-runtime.ts relies on — polyfill it here (spec:
// https://drafts.csswg.org/cssom/#the-css.escape()-method) so this file can
// exercise the real call instead of stubbing it out. Test-only; production
// code keeps calling the browser's native implementation.
function cssEscape(value: string): string {
  const string = String(value);
  const firstCodeUnit = string.charCodeAt(0);
  let result = '';
  for (let index = 0; index < string.length; index++) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0x0000) {
      result += '�';
    } else if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `;
    } else if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index);
    } else {
      result += `\\${string.charAt(index)}`;
    }
  }
  return result;
}
if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = { escape: cssEscape };
}

function customTheme(id: string, overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return {
    id,
    name: id,
    cssVars: { '--term-bg': '#111111', '--term-green': '#00ff00' },
    xterm: { background: '#111111' },
    fontFamily: '"Test Mono", monospace',
    fontSize: 13,
    ...overrides,
  };
}

function styleText(): string {
  return document.getElementById('ez-theme-vars')?.textContent ?? '';
}

describe('ensureThemeVarsStyleEl', () => {
  it('creates a single #ez-theme-vars <style> node in <head>, idempotently', () => {
    const first = ensureThemeVarsStyleEl();
    expect(first.tagName).toBe('STYLE');
    expect(first.id).toBe('ez-theme-vars');
    expect(document.head.contains(first)).toBe(true);
    expect(ensureThemeVarsStyleEl()).toBe(first);
  });
});

describe('applyThemeVarsAndEffects', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    ensureThemeVarsStyleEl().textContent = '';
    for (const id of ['scanlines', 'phosphor-glow', 'flicker', 'crt-curvature']) {
      document.documentElement.removeAttribute(`data-effect-${id}`);
    }
  });

  it('writes a [data-theme="..."] rule with the theme cssVars for a registered custom theme', () => {
    registerTheme(customTheme('neon-runtime'));
    document.documentElement.dataset.theme = 'neon-runtime';
    applyThemeVarsAndEffects('neon-runtime', { effectToggles: {}, platformDefaults: {} });
    const text = styleText();
    expect(text).toContain('[data-theme="neon-runtime"]');
    expect(text).toContain('--term-bg:#111111;');
    expect(text).toContain('--term-green:#00ff00;');
    expect(text).toContain('--ui-canvas:#111111;');
  });

  it('writes empty textContent for a built-in theme (matrix)', () => {
    document.documentElement.dataset.theme = 'matrix';
    // Seed non-empty content first so we can prove it gets cleared, not just left alone.
    ensureThemeVarsStyleEl().textContent = '[data-theme="stale"] { --term-bg: red; }';
    applyThemeVarsAndEffects('matrix', { effectToggles: {}, platformDefaults: {} });
    expect(styleText()).toBe('');
  });

  it('CSS.escape is applied to the emitted selector for a known id', () => {
    registerTheme(customTheme('escape-check'));
    document.documentElement.dataset.theme = 'escape-check';
    applyThemeVarsAndEffects('escape-check', { effectToggles: {}, platformDefaults: {} });
    expect(styleText()).toContain(`[data-theme="${CSS.escape('escape-check')}"]`);
  });

  it('applies effects declared by the theme, gated by toggles', () => {
    registerTheme(customTheme('effects-theme', { effects: ['scanlines', 'flicker'] }));
    document.documentElement.dataset.theme = 'effects-theme';
    applyThemeVarsAndEffects('effects-theme', {
      effectToggles: { scanlines: true, flicker: false },
      platformDefaults: {},
    });
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-flicker')).toBeNull();
  });

  it('switching to a theme with no declared effects removes previously-set attributes', () => {
    registerTheme(customTheme('effects-theme-2', { effects: ['scanlines'] }));
    document.documentElement.dataset.theme = 'effects-theme-2';
    applyThemeVarsAndEffects('effects-theme-2', { effectToggles: { scanlines: true }, platformDefaults: {} });
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');

    document.documentElement.dataset.theme = 'dark';
    applyThemeVarsAndEffects('dark', { effectToggles: { scanlines: true }, platformDefaults: {} });
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBeNull();
  });

  it('falls back to platformDefaults when a toggle is unset', () => {
    registerTheme(customTheme('effects-theme-3', { effects: ['crt-curvature'] }));
    document.documentElement.dataset.theme = 'effects-theme-3';
    applyThemeVarsAndEffects('effects-theme-3', {
      effectToggles: {},
      platformDefaults: { 'crt-curvature': true },
    });
    expect(document.documentElement.getAttribute('data-effect-crt-curvature')).toBe('on');
  });

  it('applies Matrix variables under a missing custom id while preserving the requested selector', () => {
    document.documentElement.dataset.theme = 'missing-custom-theme';
    applyThemeVarsAndEffects('missing-custom-theme', { effectToggles: {}, platformDefaults: {} });
    expect(styleText()).toContain('[data-theme="missing-custom-theme"]');
    expect(styleText()).toContain(`--term-bg:${THEMES.matrix.cssVars['--term-bg']};`);
    expect(styleText()).toContain(`--ui-canvas:${THEMES.matrix.ui!.canvas};`);
  });

  it('converts version 2 UI colors directly while version 1 remains seed-compatible', () => {
    const v2 = themeModToDefinition({
      schemaVersion: 2,
      id: 'v2-runtime',
      name: 'V2 Runtime',
      cssVars: { '--term-bg': '#111111' },
      xterm: { background: '#111111', foreground: '#eeeeee' },
      ui: { ...THEMES.dark.ui!, accent: '#12ef98' },
    });
    expect(v2.ui!.accent).toBe('#12ef98');

    const v1 = themeModToDefinition({
      schemaVersion: 1,
      id: 'v1-runtime',
      name: 'V1 Runtime',
      cssVars: { '--term-bg': '#101010', '--term-green': '#00cc77' },
      xterm: { background: '#101010', foreground: '#eeeeee' },
    });
    expect(v1.ui).toMatchObject({ canvas: '#101010', accent: '#00cc77' });
  });
});

describe('getUserFontId / setUserFontId', () => {
  it('round-trips a font id, defaulting to undefined', () => {
    expect(getUserFontId()).toBeUndefined();
    setUserFontId('fira-code');
    expect(getUserFontId()).toBe('fira-code');
    setUserFontId(undefined);
    expect(getUserFontId()).toBeUndefined();
  });
});
