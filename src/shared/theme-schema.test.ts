import { describe, expect, it, vi } from 'vitest';

import { MAX_THEME_MOD_BYTES, THEME_SCHEMA_VERSION, ThemeModSchema, validateThemeMod } from './theme-schema';

const validUi = {
  canvas: '#050505',
  surface: '#101010',
  surfaceRaised: '#181818',
  surfaceInset: '#000000',
  textPrimary: '#ffffff',
  textSecondary: '#dddddd',
  textMuted: '#aaaaaa',
  textInverse: '#000000',
  borderSubtle: '#555555',
  borderStrong: '#999999',
  accent: '#00d990',
  onAccent: '#001008',
  focus: '#6fffc8',
  info: '#55bfff',
  success: '#00d990',
  warning: '#ffcc55',
  danger: '#ff6677',
};

function validModJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'neon-mod',
    name: 'Neon Mod',
    cssVars: { '--term-bg': '#101010', '--term-fg': 'rgb(0, 255, 200)' },
    xterm: { background: '#101010', foreground: '#e6e6e6' },
    effects: ['scanlines', 'not-a-real-effect'],
    ...overrides,
  });
}

describe('validateThemeMod — accepts', () => {
  it('a well-formed theme mod', () => {
    const result = validateThemeMod(validModJson());
    expect(result.ok).toBe(true);
  });

  it('drops unknown effect ids with a warning, keeps known ones', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validateThemeMod(validModJson());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.effects).toEqual(['scanlines']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts hex/rgb/hsl/named-color cssVars values', () => {
    const result = validateThemeMod(
      validModJson({
        cssVars: {
          '--term-bg': '#101010f0',
          '--term-fg': 'hsla(120, 50%, 50%, 0.5)',
          '--term-border': 'red',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts version 2 with an explicit semantic UI palette', () => {
    const result = validateThemeMod(validModJson({ schemaVersion: THEME_SCHEMA_VERSION, ui: validUi }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.schemaVersion).toBe(2);
      if (result.theme.schemaVersion === 2) expect(result.theme.ui.accent).toBe('#00d990');
    }
  });
});

describe('validateThemeMod — rejects', () => {
  it('a malicious id attempting selector breakout', () => {
    const result = validateThemeMod(validModJson({ id: 'x"]{}body{x' }));
    expect(result.ok).toBe(false);
  });

  it('an id with angle brackets, spaces, or uppercase', () => {
    for (const id of ['<script>', 'has space', 'UPPER']) {
      expect(validateThemeMod(validModJson({ id })).ok).toBe(false);
    }
  });

  it('an id equal to a built-in theme id', () => {
    for (const id of ['dark', 'light', 'high-contrast', 'matrix']) {
      expect(validateThemeMod(validModJson({ id })).ok).toBe(false);
    }
  });

  it('a non-color cssVars value (url())', () => {
    const result = validateThemeMod(validModJson({ cssVars: { '--term-bg': 'url(evil.css)' } }));
    expect(result.ok).toBe(false);
  });

  it('a non-color cssVars value attempting declaration breakout', () => {
    const result = validateThemeMod(validModJson({ cssVars: { '--term-bg': 'red;}body{color:red' } }));
    expect(result.ok).toBe(false);
  });

  it('a cssVars key outside the --term- namespace', () => {
    const result = validateThemeMod(validModJson({ cssVars: { '--evil-var': '#ffffff' } }));
    expect(result.ok).toBe(false);
  });

  it('oversize input (> 64 KB), before JSON.parse', () => {
    const huge = validModJson({ name: 'x'.repeat(MAX_THEME_MOD_BYTES) });
    expect(validateThemeMod(huge).ok).toBe(false);
  });

  it('invalid JSON, without throwing', () => {
    expect(() => validateThemeMod('{not json')).not.toThrow();
    expect(validateThemeMod('{not json').ok).toBe(false);
  });

  it('a schemaVersion mismatch', () => {
    expect(validateThemeMod(validModJson({ schemaVersion: 99 })).ok).toBe(false);
  });

  it('rejects version 2 without a complete ui palette', () => {
    expect(validateThemeMod(validModJson({ schemaVersion: 2 })).ok).toBe(false);
    expect(validateThemeMod(validModJson({ schemaVersion: 2, ui: { ...validUi, focus: undefined } })).ok).toBe(
      false,
    );
  });
});

describe('ThemeModSchema — direct parse smoke test', () => {
  it('safeParse succeeds for a minimal valid mod', () => {
    const parsed = ThemeModSchema.safeParse(JSON.parse(validModJson({ effects: undefined })));
    expect(parsed.success).toBe(true);
  });
});
