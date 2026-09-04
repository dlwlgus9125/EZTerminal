import { describe, expect, it } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import {
  daemonProjectSyncDescriptor,
  daemonWorkspaceId,
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
  it('namespaces renderer Workspace identities and keeps every root selectable', () => {
    const built = daemonProjectSyncDescriptor({
      projectId: 'project-1',
      name: 'Multi root',
      primaryRoot: 'C:\\Working\\frontend',
      additionalRoots: ['C:\\Working\\backend'],
      pinned: true,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: null,
    }, {
      projectId: 'project-1',
      name: 'Multi root',
      roots: [
        { rootId: 'root-front', name: 'frontend', displayPath: 'C:\\Working\\frontend', primary: true },
        { rootId: 'root-back', name: 'backend', displayPath: 'C:\\Working\\backend', primary: false },
      ],
      workspaces: [
        {
          workspaceId: 'shared-worktree', rootId: 'root-front', name: 'feature front',
          displayPath: 'C:\\Working\\feature\\frontend', kind: 'managed', access: 'granted',
        },
        {
          workspaceId: 'shared-worktree', rootId: 'root-back', name: 'feature back',
          displayPath: 'C:\\Working\\feature\\backend', kind: 'managed', access: 'granted',
        },
        {
          workspaceId: 'external-denied', rootId: 'root-front', name: 'external',
          displayPath: 'C:\\External', kind: 'external', access: 'authorization-required',
        },
      ],
    });

    const frontRootId = daemonWorkspaceId('project-1', 'root-front', 'root-front');
    const backRootId = daemonWorkspaceId('project-1', 'root-back', 'root-back');
    expect(built.workspaces).toEqual([
      {
        id: frontRootId, name: 'frontend', kind: 'local', rootPath: 'C:\\Working\\frontend',
      },
      {
        id: backRootId, name: 'backend', kind: 'local', rootPath: 'C:\\Working\\backend',
      },
      {
        id: daemonWorkspaceId('project-1', 'root-front', 'shared-worktree'),
        name: 'feature front', kind: 'worktree', rootPath: 'C:\\Working\\feature\\frontend',
        sourceWorkspaceId: frontRootId,
      },
      {
        id: daemonWorkspaceId('project-1', 'root-back', 'shared-worktree'),
        name: 'feature back', kind: 'worktree', rootPath: 'C:\\Working\\feature\\backend',
        sourceWorkspaceId: backRootId,
      },
    ]);
  });

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
