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
  'ConnectScreen.tsx',
  'MobileAgentFolderPicker.tsx',
  'MobileAgentProjects.tsx',
  'MobileAgentView.tsx',
  'MobileAppUpdateCard.tsx',
  'MobileDaemonNavigator.tsx',
  'MobileFileView.tsx',
  'MobileHomeView.tsx',
  'MobileLeadWorkersStrip.tsx',
  'MobileMoreSheet.tsx',
  'MobileNewSessionDraft.tsx',
  'MobilePlanningNavigator.tsx',
  'MobileRemoteDesktopView.tsx',
  'MobileSessionSheet.tsx',
  'MobileSessionView.tsx',
  'MobileSettingsView.tsx',
  'MobileTabBar.tsx',
  'MobileWorkspace.tsx',
  'TerminalAccessorySettings.tsx',
  'ThemeMenu.tsx',
  'TouchInputBar.tsx',
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
