import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateDesignStyles } from '../scripts/design-style-guard-core.mjs';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ezterminal-design-style-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('design style guard', () => {
  it('accepts semantic product styles and derived channel colors', () => {
    const root = fixture({
      'src/renderer/feature.css': '.card { color: var(--ui-text-primary); background: rgba(var(--ui-accent-rgb), 0.1); z-index: var(--ui-z-popover); }',
      'mobile/src/View.tsx': "export const style = { color: 'var(--ui-danger)', fontFamily: 'var(--ui-font-body)' };\n",
    });
    expect(validateDesignStyles(root)).toMatchObject({ cssFiles: 1, sourceFiles: 1 });
  });

  it.each([
    ['raw palette', '.card { color: #ff00aa; }', 'raw palette color'],
    ['terminal token', '.card { color: var(--term-green); }', 'terminal token in product chrome'],
    ['font stack', '.card { font-family: Arial, sans-serif; }', 'direct font stack'],
    ['z-index ladder', '.card { z-index: 9999; }', 'high local z-index'],
  ])('rejects %s in product CSS', (_name, source, expected) => {
    const root = fixture({ 'src/renderer/feature.css': source });
    expect(() => validateDesignStyles(root)).toThrow(expected);
  });

  it('allows literal values only in the named token/theme foundations', () => {
    const root = fixture({
      'src/renderer/styles/ui-tokens.css': ':root { --ui-danger: #ff0000; }',
      'src/renderer/themes.ts': "export const danger = '#ff0000';\n",
      'mobile/src/mobile-decorative-tokens.css': '.root { --overlay: rgba(0, 0, 0, 0.5); }',
    });
    expect(() => validateDesignStyles(root)).not.toThrow();
  });
});
