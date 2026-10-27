// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { GLYPH_NAMES, Glyph, IconButton, glyphIcon } from './index';

describe('Glyph', () => {
  it('draws every glyph as one decorative path on the 20px grid', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<>{GLYPH_NAMES.map((name) => <Glyph key={name} name={name} />)}</>));
    const svgs = host.querySelectorAll('svg');
    expect(svgs).toHaveLength(GLYPH_NAMES.length);
    for (const svg of svgs) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('viewBox')).toBe('0 0 20 20');
      expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M[\d.]/);
    }
    act(() => root.unmount());
  });

  it('gives icon buttons one stable decorative glyph component per name', () => {
    expect(glyphIcon('back')).toBe(glyphIcon('back'));
    expect(glyphIcon('back')).not.toBe(glyphIcon('next'));
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<IconButton icon={glyphIcon('plus')} aria-label="New terminal" />));
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('New terminal');
    expect(button?.querySelector('svg.ez-ui-glyph')?.getAttribute('aria-hidden')).toBe('true');
    act(() => root.unmount());
  });
});
