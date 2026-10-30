import { describe, expect, it } from 'vitest';

import type { ChatTool } from './types';
import { toolVerb, workspacePath } from './summary';

describe('workspacePath', () => {
  it('shows paths inside the workspace relative to it, whatever the case of the root', () => {
    expect(workspacePath('C:\\Work\\App\\src\\app.ts', 'c:\\work\\app')).toBe('src\\app.ts');
    expect(workspacePath('<WORKSPACE>\\notes.md')).toBe('notes.md');
  });

  it('keeps paths outside the workspace, including a sibling sharing its prefix', () => {
    expect(workspacePath('C:\\Work\\App2\\x.ts', 'C:\\Work\\App')).toBe('C:\\Work\\App2\\x.ts');
    expect(workspacePath('D:\\other\\y.ts', 'C:\\Work\\App')).toBe('D:\\other\\y.ts');
  });
});

describe('toolVerb', () => {
  const failedTool = (category: ChatTool['category'], name = 'tool'): ChatTool => ({ id: 'id', callId: 'call', name, category, status: 'failed', createdAt: '2026-10-30T09:00:00.000Z' });

  it('says what was attempted in plain English when a tool fails', () => {
    expect(toolVerb(failedTool('mcp'), 'en')).toBe('Tried to call');
    expect(toolVerb(failedTool('command'), 'en')).toBe('Tried to run');
    expect(toolVerb(failedTool('edit'), 'en')).toBe('Tried to edit');
    expect(toolVerb(failedTool('read'), 'en')).toBe('Tried to read');
    expect(toolVerb(failedTool('web', 'WebFetch'), 'en')).toBe('Tried to fetch');
    expect(toolVerb(failedTool('web', 'WebSearch'), 'en')).toBe('Tried to search the web');
    expect(toolVerb(failedTool('other'), 'en')).toBe('Tried to use');
  });
});
