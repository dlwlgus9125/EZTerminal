import { describe, expect, it } from 'vitest';

import {
  isProjectSessionPanelMetadata,
  isProjectSessionTarget,
} from './project-workspace';

describe('project session metadata guards', () => {
  it('accepts a project root target and a paired workspace target', () => {
    expect(isProjectSessionTarget({ projectId: 'project-1' })).toBe(true);
    expect(isProjectSessionTarget({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'worktree-1',
    })).toBe(true);
  });

  it('rejects incomplete workspace identity and every executable or path-bearing extra', () => {
    expect(isProjectSessionTarget({ projectId: 'project-1', rootId: 'root-1' })).toBe(false);
    expect(isProjectSessionTarget({ projectId: 'project-1', cwd: 'C:\\unsafe' })).toBe(false);
    expect(isProjectSessionTarget({ projectId: 'project-1', sessionId: 'session-1' })).toBe(false);
    expect(isProjectSessionTarget({ projectId: 'project-1', command: 'codex' })).toBe(false);
  });

  it('accepts only bounded presentation metadata on a panel', () => {
    expect(isProjectSessionPanelMetadata({
      projectId: 'project-1',
      projectName: 'EZTerminal',
      titleMode: 'generated',
    })).toBe(true);
    expect(isProjectSessionPanelMetadata({
      projectId: 'project-1',
      projectName: 'EZTerminal',
      titleMode: 'custom',
      bootstrap: { command: 'codex' },
    })).toBe(false);
  });
});
