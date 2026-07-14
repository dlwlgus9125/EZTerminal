import { describe, expect, it } from 'vitest';

import {
  generatedPanelTitle,
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
});
