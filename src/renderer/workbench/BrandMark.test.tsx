// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrandMark } from './BrandMark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const css = readFileSync(resolve(process.cwd(), 'src/renderer/workbench/workbench.css'), 'utf8');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BrandMark', () => {
  it('keeps the full visible product name as the heading and hides only the signal mark', () => {
    act(() => root.render(<BrandMark className="brand-test-hook" />));

    const heading = container.querySelector<HTMLHeadingElement>('h1[data-testid="workbench-brand-mark"]');
    const signal = heading?.querySelector<HTMLElement>('.workbench-brand-mark__signal');

    expect(heading?.textContent).toBe('EZTerminal');
    expect(heading?.classList.contains('brand-test-hook')).toBe(true);
    expect(heading?.hasAttribute('aria-label')).toBe(false);
    expect(signal?.getAttribute('aria-hidden')).toBe('true');
    expect(signal?.querySelectorAll('.workbench-brand-mark__signal-bar')).toHaveLength(3);
    expect(heading?.querySelector('.workbench-brand-mark__name')?.textContent).toBe('EZTerminal');
  });

  it('keeps CRT decoration theme-aware, effect-gated, and accessibility-safe', () => {
    expect(css).toMatch(/\[data-theme=["']matrix["']\]\s+\.workbench-brand-mark__name\s*\{[^}]*["']VT323["']/s);
    expect(css).toMatch(
      /html\[data-effect-phosphor-glow=["']on["']\]\s+\.workbench-brand-mark__name\s*\{[^}]*text-shadow/s,
    );
    expect(css).toMatch(/html\[data-effect-scanlines=["']on["']\]\s+\.workbench-brand-mark::after\s*\{[^}]*opacity/s);
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/@media \(min-width: 800px\) and \(max-width: 1199px\)/);
  });
});
