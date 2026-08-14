import type { IDockviewPanel } from 'dockview-react';
import { describe, expect, it } from 'vitest';

import { isDetachablePanel } from './dockview-popouts';

function panel(component: string): IDockviewPanel {
  return { api: { component } } as unknown as IDockviewPanel;
}

describe('detachable Dockview panels', () => {
  it('allows every registered workbench panel to move between native windows', () => {
    expect(isDetachablePanel(panel('terminal'))).toBe(true);
    expect(isDetachablePanel(panel('agent-session'))).toBe(true);
    expect(isDetachablePanel(panel('project-editor'))).toBe(true);
    expect(isDetachablePanel(panel('openclaw-chat'))).toBe(true);
    expect(isDetachablePanel(panel('unknown'))).toBe(false);
  });
});
