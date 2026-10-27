import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * I4 moves the Android app off lucide onto the stencil glyphs (`src/renderer/ui/Glyph.tsx`).
 * This list only shrinks: a phone file not on it may not import lucide, and a file on it that no
 * longer imports lucide must be removed. At the end of I4 only the unused screens that I5 deletes
 * stay here. Shared desktop components under `src/renderer` are out of scope.
 */
const LUCIDE_ALLOWED = new Set([
  // Unused screens I5 deletes (no product code renders them).
  'MobileAgentFolderPicker.tsx',
  'MobileAgentProjects.tsx',
  'MobileHomeView.tsx',
]);

const root = resolve(process.cwd(), 'mobile/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Android glyph ratchet', () => {
  const importing = sources(root)
    .filter((path) => /from ['"]lucide-react['"]/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replace(/\\/g, '/'));

  it('lets only listed phone files import lucide', () => {
    expect(importing.filter((file) => !LUCIDE_ALLOWED.has(file))).toEqual([]);
  });

  it('drops a file from the list once it stops importing lucide', () => {
    expect([...LUCIDE_ALLOWED].filter((file) => !importing.includes(file))).toEqual([]);
  });
});

describe('Android radius ratchet', () => {
  function css(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return css(path);
      return name.endsWith('.css') ? [path] : [];
    });
  }

  it('rounds phone corners only through the radius roles (a circle or a square corner aside)', () => {
    const literal = css(root).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/border-radius:\s*([^;}]+)/g)]
      .map((match) => match[1]!.trim())
      .filter((value) => !value.includes('var(') && /\d+(?:\.\d+)?(?:px|rem|em)/.test(value))
      .map((value) => `${relative(root, path).replace(/\\/g, '/')}: ${value}`));
    expect(literal).toEqual([]);
  });
});
