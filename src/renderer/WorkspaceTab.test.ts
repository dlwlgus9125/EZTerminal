import { describe, expect, it } from 'vitest';

import {
  generatedPanelTitle,
  generatedProjectSessionTitles,
  MAX_TAB_TITLE_CHARACTERS,
  normalizePanelTitle,
} from './WorkspaceTab';

describe('WorkspaceTab title model', () => {
  it('restores stable generated names for blank terminal and service titles', () => {
    expect(generatedPanelTitle('tab-17', 'terminal')).toBe('Terminal 17');
    expect(generatedPanelTitle('openclaw-chat', 'openclaw-chat')).toBe('OpenClaw Chat');
    expect(normalizePanelTitle('   ', 'Terminal 17')).toBe('Terminal 17');
  });

  it('trims and caps a title at 80 Unicode characters', () => {
    const longTitle = `  ${'🦈'.repeat(MAX_TAB_TITLE_CHARACTERS + 2)}  `;
    const normalized = normalizePanelTitle(longTitle, 'Terminal');
    expect([...normalized]).toHaveLength(MAX_TAB_TITLE_CHARACTERS);
    expect(normalized).not.toContain(' ');
  });

  it('numbers generated titles per project and badge without consuming custom titles', () => {
    expect(Object.fromEntries(generatedProjectSessionTitles([
      { panelId: 'tab-9', projectId: 'p1', projectName: 'Project', badgeKey: 'Codex', titleMode: 'generated' },
      { panelId: 'tab-2', projectId: 'p1', projectName: 'Project', badgeKey: 'Codex', titleMode: 'generated' },
      { panelId: 'tab-3', projectId: 'p1', projectName: 'Project', badgeKey: 'Terminal', titleMode: 'generated' },
      { panelId: 'tab-4', projectId: 'p1', projectName: 'Project', badgeKey: 'Codex', titleMode: 'custom' },
      { panelId: 'tab-5', projectId: 'p2', projectName: 'Project', badgeKey: 'Codex', titleMode: 'generated' },
    ]))).toEqual({
      'tab-2': 'Project',
      'tab-9': 'Project 2',
      'tab-3': 'Project',
      'tab-5': 'Project',
    });
  });
});
