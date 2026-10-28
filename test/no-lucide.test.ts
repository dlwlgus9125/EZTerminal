import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The app draws only the stencil glyphs (`src/renderer/ui/Glyph.tsx`, `glyphIcon(name)`), on the
 * desktop and the phone. I5 moved every screen off lucide; the list below only shrinks.
 */
const LUCIDE_ALLOWED = new Set<string>([
  // AgentHub's legacy views are being deleted in a parallel I5 change; these go with it.
  'src/renderer/AgentHub.tsx',
  'src/renderer/DaemonAgentSessions.tsx',
  'src/renderer/ProjectConversationNavigator.tsx',
]);

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
  const importing = SCANNED.flatMap((dir) => sources(resolve(root, dir)))
    .filter((path) => /from ['"]lucide-react['"]/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replace(/\\/g, '/'));

  it('lets only listed files import lucide', () => {
    expect(importing.filter((file) => !LUCIDE_ALLOWED.has(file))).toEqual([]);
  });

  it('drops a file from the list once it stops importing lucide', () => {
    expect([...LUCIDE_ALLOWED].filter((file) => !importing.includes(file))).toEqual([]);
  });
});
