import type { IDockviewPanel } from 'dockview-react';
import { describe, expect, it } from 'vitest';

import { isDetachablePanel } from './dockview-popouts';

function panel(component: string): IDockviewPanel {
  return { api: { component } } as unknown as IDockviewPanel;
}

describe('detachable Dockview panels', () => {
  it('keeps collection-bound Project Maps in the main workbench', () => {
    expect(isDetachablePanel(panel('terminal'))).toBe(true);
    expect(isDetachablePanel(panel('agent-session'))).toBe(true);
    expect(isDetachablePanel(panel('project-editor'))).toBe(true);
    expect(isDetachablePanel(panel('project-map'))).toBe(false);
    expect(isDetachablePanel(panel('openclaw-chat'))).toBe(true);
    expect(isDetachablePanel(panel('unknown'))).toBe(false);
  });
});
