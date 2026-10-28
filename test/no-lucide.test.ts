import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The app draws only the stencil glyphs (`src/renderer/ui/Glyph.tsx`, `glyphIcon(name)`), on the
 * desktop and the phone. I5 moved every screen off lucide and removed the package; ESLint's
 * no-restricted-imports names the replacement if an import comes back.
 */
const root = process.cwd();
const SCANNED = ['src', 'mobile/src', 'test', 'e2e', 'visual', 'mobile/e2e', 'scripts'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mjs)$/.test(name) ? [path] : [];
  });
}

describe('no lucide', () => {
  it('imports lucide nowhere', () => {
    const importing = SCANNED.flatMap((dir) => sources(resolve(root, dir)))
      .filter((path) => /from ['"]lucide-react['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path).replace(/\\/g, '/'));
    expect(importing).toEqual([]);
  });

  it('depends on lucide nowhere', () => {
    for (const manifest of ['package.json', 'mobile/package.json', 'pnpm-lock.yaml']) {
      expect(readFileSync(resolve(root, manifest), 'utf8'), manifest).not.toMatch(/lucide/);
    }
  });
});
