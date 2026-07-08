import { describe, expect, it, vi } from 'vitest';

import { MAX_THEME_MOD_BYTES, ThemeModSchema, validateThemeMod } from './theme-schema';

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
});

describe('ThemeModSchema — direct parse smoke test', () => {
  it('safeParse succeeds for a minimal valid mod', () => {
    const parsed = ThemeModSchema.safeParse(JSON.parse(validModJson({ effects: undefined })));
    expect(parsed.success).toBe(true);
  });
});
