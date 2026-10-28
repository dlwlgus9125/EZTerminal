import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Phone corners: the lucide half of this ratchet moved into test/no-lucide.test.ts (I5). */
const root = resolve(process.cwd(), 'mobile/src');

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
