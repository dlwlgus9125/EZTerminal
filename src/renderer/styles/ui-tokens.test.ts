import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { calculateContrastRatio } from '../theme-contrast';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/ui-tokens.css'), 'utf8');
const desktopFoundation = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
const mobileFoundation = readFileSync(resolve(process.cwd(), 'src/renderer/mobile-shared.css'), 'utf8');

function declaration(name: string): string | undefined {
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim();
}

function scopedDeclarationFrom(
  source: string,
  selector: string,
  name: string,
): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`).exec(source)?.[1];
  return block ? new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)?.[1].trim() : undefined;
}

function scopedDeclaration(selector: string, name: string): string | undefined {
  return scopedDeclarationFrom(css, selector, name);
}

function compositeHex(foreground: string, background: string, opacity: number): string {
  const channel = (color: string, offset: number): number =>
    Number.parseInt(color.slice(offset, offset + 2), 16);
  const blended = [1, 3, 5].map((offset) =>
    Math.round(
      channel(foreground, offset) * opacity
        + channel(background, offset) * (1 - opacity),
    ).toString(16).padStart(2, '0'));
  return `#${blended.join('')}`;
}

function mediaBlocks(source: string, condition: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  const marker = `@media ${condition}`;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const open = source.indexOf('{', start + marker.length);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    blocks.push(source.slice(open + 1, end - 1));
    cursor = end;
  }
  return blocks;
}

describe('UI token contract', () => {
  it('defines every semantic colour consumed by primitives', () => {
    for (const token of [
      '--ui-canvas',
      '--ui-surface',
      '--ui-surface-raised',
      '--ui-surface-inset',
      '--ui-text-primary',
      '--ui-text-secondary',
      '--ui-text-muted',
      '--ui-text-inverse',
      '--ui-border-subtle',
      '--ui-border-strong',
      '--ui-accent',
      '--ui-on-accent',
      '--ui-focus',
      '--ui-info',
      '--ui-success',
      '--ui-warning',
      '--ui-danger',
    ]) {
      expect(declaration(token), `${token} must be declared`).toBeDefined();
    }
  });

  it('uses only the approved typography, radius, and control-height scales', () => {
    expect(declaration('--ui-font-size-xs')).toBe('0.75rem');
    expect(declaration('--ui-font-size-sm')).toBe('0.8125rem');
    expect(declaration('--ui-font-size-md')).toBe('0.875rem');
    expect(declaration('--ui-font-size-lg')).toBe('1rem');
    expect(declaration('--ui-font-size-xl')).toBe('1.25rem');
    expect(declaration('--ui-font-size-2xl')).toBe('var(--ui-font-size-xl)');
    expect(declaration('--ui-radius-sm')).toBe('0.125rem');
    expect(declaration('--ui-radius-md')).toBe('0.25rem');
    expect(declaration('--ui-radius-lg')).toBe('0.5rem');
    expect(declaration('--ui-radius-pill')).toBe('var(--ui-radius-lg)');
    expect(declaration('--ui-control-height-sm')).toBe('2rem');
    expect(declaration('--ui-control-height-md')).toBe('2rem');
    expect(declaration('--ui-control-height-lg')).toBe('2.5rem');
  });

  it('has no unbundled font dependency and exposes workbench layer names', () => {
    expect(css).not.toMatch(/Pretendard|\bInter\b/);
    expect(declaration('--ui-z-sticky')).toBe('100');
    expect(declaration('--ui-z-sidebar-scrim')).toBe('200');
    expect(declaration('--ui-z-sidebar')).toBe('300');
    expect(declaration('--ui-z-dialog')).toBe('700');
    expect(declaration('--ui-z-modal')).toBe('var(--ui-z-dialog)');
    expect(declaration('--ui-z-critical')).toBe('1200');
    expect(declaration('--ui-z-boot')).toBe('1300');
  });

  it('adds the commercial-pass card scale without disturbing the base scales', () => {
    expect(declaration('--ui-radius-xl')).toBe('0.75rem');
    expect(declaration('--ui-radius-2xl')).toBe('0.875rem');
    expect(declaration('--ui-radius-round')).toBe('999px');
    expect(declaration('--ui-font-size-3xs')).toBe('0.625rem');
    expect(declaration('--ui-font-size-2xs')).toBe('0.65625rem');
    expect(declaration('--ui-font-size-3xl')).toBe('1.625rem');
    expect(declaration('--ui-pane-gap')).toBe('0.875rem');
    expect(declaration('--ui-pane-inset')).toBe('0.4375rem');
    expect(declaration('--ui-motion-modal')).toBe('180ms');

    const reducedMotionBlock =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]+?)\n\}/.exec(css)?.[1] ?? '';
    for (const token of ['modal', 'toast', 'pane-focus']) {
      expect(
        new RegExp(`--ui-motion-${token}\\s*:\\s*0ms`).test(reducedMotionBlock),
        `--ui-motion-${token} must collapse under reduced motion`,
      ).toBe(true);
    }
  });

  // theme-contrast.ts only corrects the seventeen required roles, so the
  // decorative ones added by the commercial pass have no runtime safety net and
  // are gated here instead.
  const BUILT_IN_THEMES = ['dark', 'light', 'high-contrast', 'matrix'] as const;
  const SURFACES = ['--ui-canvas', '--ui-surface', '--ui-surface-raised', '--ui-surface-inset'] as const;

  function themeColor(theme: string, token: string): string {
    const value = scopedDeclaration(`[data-theme='${theme}']`, token);
    expect(value, `${theme} must declare ${token}`).toBeDefined();
    return value!;
  }

  it('declares every decorative role in all four built-in themes', () => {
    // A custom property computes to its substituted value, so a theme that
    // leans on the :root aliases inherits whatever an ancestor scope resolved
    // them to. The token gallery renders all four themes as nested scopes.
    for (const theme of BUILT_IN_THEMES) {
      for (const token of [
        '--ui-text-dim',
        '--ui-border-mid',
        '--ui-border-focus-soft',
        '--ui-glow-color',
      ]) {
        expect(
          scopedDeclaration(`[data-theme='${theme}']`, token),
          `${theme} must declare ${token} rather than inherit it`,
        ).toBeDefined();
      }
    }
  });

  it('keeps dim text readable and soft borders perceivable in every theme', () => {
    for (const theme of BUILT_IN_THEMES) {
      const dim = themeColor(theme, '--ui-text-dim');
      for (const surface of SURFACES) {
        const ratio = calculateContrastRatio(dim, themeColor(theme, surface));
        expect(ratio, `${theme} --ui-text-dim on ${surface}`).not.toBeNull();
        expect(ratio!, `${theme} --ui-text-dim on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }

      // This role draws modal and pane boundaries, which is non-text UI.
      const border = themeColor(theme, '--ui-border-focus-soft');
      for (const surface of ['--ui-surface', '--ui-surface-raised'] as const) {
        const ratio = calculateContrastRatio(border, themeColor(theme, surface));
        expect(ratio, `${theme} --ui-border-focus-soft on ${surface}`).not.toBeNull();
        expect(ratio!, `${theme} --ui-border-focus-soft on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps decorative roles falling back to contrast-corrected ones', () => {
    // A sparse custom theme only supplies the seventeen semantic colours. The
    // decorative roles must therefore resolve through those rather than baking
    // in Matrix greens, which would bleed into every custom and light theme.
    expect(declaration('--ui-text-dim')).toBe('var(--ui-text-muted)');
    expect(declaration('--ui-border-mid')).toBe('var(--ui-border-subtle)');
    expect(declaration('--ui-border-focus-soft')).toBe('var(--ui-border-strong)');
    expect(declaration('--ui-glow-color')).toBe('var(--ui-accent)');

    // Light and High Contrast opt out of phosphor bloom through the glow
    // colour, not the shadows: `[data-theme]` and `[data-theme='light']` have
    // equal specificity, so the recompute block would win on source order.
    for (const theme of ['light', 'high-contrast']) {
      expect(scopedDeclaration(`[data-theme='${theme}']`, '--ui-glow-color')).toBe('transparent');
    }
    for (const theme of ['dark', 'matrix']) {
      expect(scopedDeclaration(`[data-theme='${theme}']`, '--ui-glow-color')).toBe(
        'var(--ui-accent)',
      );
    }
  });

  it('maps density preferences to the approved 32px, 40px, and 44px control tiers', () => {
    for (const size of ['sm', 'md', 'lg']) {
      expect(scopedDeclaration("[data-density='compact']", `--ui-control-height-${size}`)).toBe('2rem');
      expect(scopedDeclaration("[data-density='comfortable']", `--ui-control-height-${size}`)).toBe('2.5rem');
    }

    const coarseBlock = /@media \(pointer: coarse\)\s*\{([\s\S]+)\}\s*$/.exec(css)?.[1] ?? '';
    for (const size of ['sm', 'md', 'lg']) {
      expect(new RegExp(`--ui-control-height-${size}\\s*:\\s*2\\.75rem`).test(coarseBlock)).toBe(true);
    }
  });

  it('keeps rem tokens on a theme-independent 16px root scale', () => {
    for (const foundation of [desktopFoundation, mobileFoundation]) {
      expect(foundation).toContain('font-size: calc(16px * var(--ez-ui-scale, 1));');
      const matrixBlock = /\[data-theme=(?:'matrix'|"matrix")\]\s*\{([^}]+)\}/.exec(foundation)?.[1] ?? '';
      expect(matrixBlock).not.toMatch(/font-size\s*:/);
    }
  });

  it('keeps inactive pane header metadata above 4.5:1 in every built-in theme', () => {
    expect(
      scopedDeclarationFrom(desktopFoundation, '.pane-header-meta', 'color'),
    ).toBe('var(--ui-text-secondary)');
    expect(
      scopedDeclarationFrom(desktopFoundation, '.pane-header-meta', 'opacity'),
    ).toBe('1');
    const groupOpacity = Number(
      scopedDeclarationFrom(desktopFoundation, '.ez-dock .dv-groupview', 'opacity'),
    );
    expect(groupOpacity).toBe(0.82);

    for (const theme of BUILT_IN_THEMES) {
      const foreground = themeColor(theme, '--ui-text-secondary');
      const background = theme === 'dark'
        ? new RegExp('--term-bg-raised\\s*:\\s*(#[0-9a-f]+)').exec(desktopFoundation)?.[1]
        : scopedDeclarationFrom(
          desktopFoundation,
          `[data-theme='${theme}']`,
          '--term-bg-raised',
        );
      expect(background, `${theme} must define the pane header background`).toMatch(/^#[0-9a-f]{6}$/);
      const effectiveForeground = compositeHex(foreground, background!, groupOpacity);
      expect(
        calculateContrastRatio(effectiveForeground, background!),
        `${theme} inactive pane metadata`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('stops terminal block entry and running-status pulse under reduced motion', () => {
    const reducedMotion = mediaBlocks(desktopFoundation, '(prefers-reduced-motion: reduce)').join('\n');
    const animationNoneRule = /\.block,\s*\.block-status--running::before\s*\{([^}]+)\}/
      .exec(reducedMotion)?.[1] ?? '';
    expect(animationNoneRule).toMatch(/animation\s*:\s*none\s*!important/);

    const waitingRule = /\.pty-plain-waiting\s*\{([^}]+)\}/.exec(reducedMotion)?.[1] ?? '';
    expect(waitingRule).toMatch(/animation\s*:\s*none\s*!important/);
  });
});
