import type { IDockviewPanel } from 'dockview-react';
import { describe, expect, it } from 'vitest';

import { isDetachablePanel } from './dockview-popouts';

function panel(component: string): IDockviewPanel {
  return { api: { component } } as unknown as IDockviewPanel;
}

describe('detachable Dockview panels', () => {
  it('allows terminal and Agent Session panels while keeping native OpenClaw chat attached', () => {
    expect(isDetachablePanel(panel('terminal'))).toBe(true);
    expect(isDetachablePanel(panel('agent-session'))).toBe(true);
    expect(isDetachablePanel(panel('openclaw-chat'))).toBe(false);
  });
});
