import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Android app draws only the stencil glyphs (`src/renderer/ui/Glyph.tsx`): no phone file may
 * import lucide (I4 moved the screens, I5 deleted the last unused ones). The repo-wide ban that also
 * covers shared components is test/no-lucide.test.ts.
 */
const LUCIDE_ALLOWED = new Set<string>();

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
