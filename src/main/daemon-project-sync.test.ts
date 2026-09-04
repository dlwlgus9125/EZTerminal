import { describe, expect, it } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import {
  planDaemonProjectSync,
  type DaemonProjectSyncDescriptor,
} from './daemon-project-sync';

const NOW = '2026-09-04T00:00:00.000Z';

function snapshot(): Pick<DaemonSnapshot, 'projects' | 'workspaces'> {
  return { projects: [], workspaces: [] };
}

const descriptor: DaemonProjectSyncDescriptor = {
  id: 'project-1',
  name: 'EZTerminal',
  rootPath: 'C:\\Working\\EZTerminal',
  workspaces: [
    {
      id: 'root-1',
      name: 'EZTerminal',
      kind: 'local',
      rootPath: 'C:\\Working\\EZTerminal',
    },
    {
      id: 'worktree-1',
      name: 'feature',
      kind: 'worktree',
      rootPath: 'C:\\Working\\EZTerminal-worktree',
      sourceWorkspaceId: 'root-1',
    },
  ],
};

describe('planDaemonProjectSync', () => {
  it('creates one native Project before all of its selectable Workspaces', () => {
    expect(planDaemonProjectSync(snapshot(), [descriptor])).toEqual([
      { kind: 'project.upsert', value: {
        id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native',
      } },
      { kind: 'workspace.upsert', value: {
        id: 'root-1', projectId: 'project-1', name: 'EZTerminal', kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal',
      } },
      { kind: 'workspace.upsert', value: {
        id: 'worktree-1', projectId: 'project-1', name: 'feature', kind: 'worktree',
        rootPath: 'C:\\Working\\EZTerminal-worktree', sourceWorkspaceId: 'root-1',
      } },
    ]);
  });

  it('is a no-op once equivalent records are authoritative', () => {
    expect(planDaemonProjectSync({
      projects: [{
        id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: descriptor.workspaces.map((workspace) => ({
        ...workspace,
        projectId: 'project-1',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    }, [descriptor])).toEqual([]);
  });

  it('rejects ambiguous global Workspace identities before touching SQLite', () => {
    expect(() => planDaemonProjectSync(snapshot(), [
      descriptor,
      {
        id: 'project-2', name: 'Other', rootPath: 'C:\\Other',
        workspaces: [{ id: 'root-1', name: 'Other', kind: 'local', rootPath: 'C:\\Other' }],
      },
    ])).toThrow(/Workspace id/u);
  });
});
