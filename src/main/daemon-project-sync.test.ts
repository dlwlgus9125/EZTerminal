import { describe, expect, it } from 'vitest';

import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot } from '../shared/daemon-protocol';
import {
  daemonProjectRemovalTransition,
  daemonProjectSaveRevocationTransition,
  daemonProjectSyncDescriptor,
  daemonWorkspaceId,
  planDaemonProjectRevocation,
  planDaemonProjectSaveTransition,
  planDaemonWorkspaceRevocation,
  planDaemonProjectSync,
  resolvedDaemonProjectSyncDescriptor,
  trustedDaemonWorkspaceReactivationIds,
  daemonWorkspaceRevocationTransition,
  type DaemonProjectSyncDescriptor,
  type DaemonProjectSyncOptions,
} from './daemon-project-sync';

const NOW = '2026-09-04T00:00:00.000Z';

function snapshot(): Pick<DaemonSnapshot, 'projects' | 'workspaces'> {
  return { projects: [], workspaces: [] };
}

function authoritySnapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision: 1,
    eventSequence: 1,
    generatedAt: NOW,
    runtime: {
      keepRunning: true,
      startAtLogin: true,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
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
  it('archives a removed native Project and every active Workspace atomically', () => {
    expect(planDaemonProjectRevocation({
      projects: [{
        id: 'project-1',
        name: 'EZTerminal',
        rootPath: 'C:\\Working\\EZTerminal',
        source: 'native',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [
        {
          id: 'root-1', projectId: 'project-1', name: 'Main', kind: 'local',
          rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'worktree-1', projectId: 'project-1', name: 'Review', kind: 'worktree',
          rootPath: 'C:\\Working\\review', sourceWorkspaceId: 'root-1',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'foreign-1', projectId: 'project-2', name: 'Foreign', kind: 'local',
          rootPath: 'C:\\Other', revision: 1, createdAt: NOW, updatedAt: NOW,
        },
      ],
    }, 'project-1', NOW)).toEqual([
      {
        kind: 'workspace.upsert',
        value: {
          id: 'root-1', projectId: 'project-1', name: 'Main', kind: 'local',
          rootPath: 'C:\\Working\\EZTerminal', archivedAt: NOW,
        },
      },
      {
        kind: 'workspace.upsert',
        value: {
          id: 'worktree-1', projectId: 'project-1', name: 'Review', kind: 'worktree',
          rootPath: 'C:\\Working\\review', sourceWorkspaceId: 'root-1', archivedAt: NOW,
        },
      },
      {
        kind: 'project.upsert',
        value: {
          id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal',
          source: 'native', archivedAt: NOW,
        },
      },
    ]);
  });

  it('fails a full Project removal closed when a fresh snapshot contains an active Session', () => {
    const plan = daemonProjectRemovalTransition('project-1', NOW)({
      snapshot: authoritySnapshot({
        projects: [{
          id: 'project-1', name: 'Demo', rootPath: 'C:\\Demo', source: 'native',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        workspaces: [{
          id: 'workspace-1', projectId: 'project-1', name: 'Demo', kind: 'local',
          rootPath: 'C:\\Demo', revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        sessions: [{
          id: 'session-1', projectId: 'project-1', workspaceId: 'workspace-1',
          kind: 'agent', title: 'Working', state: 'running', source: 'structured',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
      }),
      scheduleRuns: [],
    });

    expect(plan).toEqual({
      commit: {},
      value: { ok: false, reason: 'active-sessions', sessionIds: ['session-1'] },
    });
  });

  it('retires terminal descendants and queued automation in the Project tombstone transaction', () => {
    const plan = daemonProjectRemovalTransition('project-1', NOW)({
      snapshot: authoritySnapshot({
        projects: [{
          id: 'project-1', name: 'Demo', rootPath: 'C:\\Demo', source: 'native',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        workspaces: [{
          id: 'workspace-1', projectId: 'project-1', name: 'Demo', kind: 'local',
          rootPath: 'C:\\Demo', revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        sessions: [{
          id: 'session-1', projectId: 'project-1', workspaceId: 'workspace-1',
          kind: 'agent', title: 'Finished', state: 'completed', source: 'structured',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        agents: [{
          sessionId: 'session-1', providerId: 'codex', providerSessionId: 'provider-1',
          permissionPreset: 'standard', state: 'done', queuedTurnCount: 0,
          orchestrationEnabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        schedules: [{
          id: 'schedule-1', name: 'Nightly', workspaceId: 'workspace-1', providerId: 'codex',
          permissionPreset: 'standard', prompt: 'Check', cron: '0 0 * * *', timezone: 'UTC',
          enabled: true, runCount: 0, nextRunAt: '2026-09-05T00:00:00.000Z',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        heartbeats: [{
          sessionId: 'session-1', prompt: 'Continue', cron: '*/5 * * * *', timezone: 'UTC',
          enabled: true, pending: true, nextRunAt: '2026-09-05T00:00:00.000Z',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
      }),
      scheduleRuns: [{
        id: 'run-1', scheduleId: 'schedule-1', state: 'queued', scheduledFor: NOW,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    });

    expect(plan?.value).toEqual({ ok: true, sessionIds: ['session-1'] });
    expect(plan?.commit.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project.upsert', value: expect.objectContaining({ archivedAt: NOW }) }),
      expect.objectContaining({ kind: 'workspace.upsert', value: expect.objectContaining({ archivedAt: NOW }) }),
      expect.objectContaining({ kind: 'session.upsert', value: expect.objectContaining({ state: 'archived' }) }),
      expect.objectContaining({ kind: 'agent.upsert', value: expect.objectContaining({ state: 'archived' }) }),
      expect.objectContaining({ kind: 'schedule.upsert', value: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ kind: 'schedule-run.upsert', value: expect.objectContaining({
        state: 'failed', errorCode: 'project-authority-revoked',
      }) }),
      { kind: 'heartbeat.delete', sessionId: 'session-1' },
    ]));
  });

  it('blocks a prepared root removal while that root still owns an active Session', () => {
    const plan = daemonProjectSaveRevocationTransition({
      id: 'project-1', rootPaths: ['C:\\Demo', 'D:\\Removed'],
    }, 'project-1', ['C:\\Demo'], NOW)({
      snapshot: authoritySnapshot({
        projects: [{
          id: 'project-1', name: 'Demo', rootPath: 'C:\\Demo', source: 'native',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        workspaces: [{
          id: 'removed-root', projectId: 'project-1', name: 'Removed', kind: 'local',
          rootPath: 'D:\\Removed', revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        sessions: [{
          id: 'session-removed', projectId: 'project-1', workspaceId: 'removed-root',
          kind: 'terminal', title: 'Busy', state: 'idle', source: 'structured',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
      }),
      scheduleRuns: [],
    });

    expect(plan?.value).toEqual({
      ok: false,
      reason: 'active-sessions',
      sessionIds: ['session-removed'],
    });
    expect(plan?.commit).toEqual({});
  });

  it('disables Workspace automation without interrupting an already active Session', () => {
    const target = { projectId: 'project-1', rootId: 'root-1', workspaceId: 'external-1' };
    const workspaceId = daemonWorkspaceId(target.projectId, target.rootId, target.workspaceId);
    const sourceWorkspaceId = daemonWorkspaceId(target.projectId, target.rootId, target.rootId);
    const plan = daemonWorkspaceRevocationTransition(target, NOW)({
      snapshot: authoritySnapshot({
        workspaces: [{
          id: workspaceId, projectId: 'project-1', name: 'External', kind: 'worktree',
          rootPath: 'D:\\External', sourceWorkspaceId,
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        sessions: [{
          id: 'session-1', projectId: 'project-1', workspaceId, kind: 'agent', title: 'Working',
          state: 'running', source: 'structured', revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        schedules: [{
          id: 'schedule-1', name: 'Nightly', workspaceId, providerId: 'codex',
          permissionPreset: 'standard', prompt: 'Check', cron: '0 0 * * *', timezone: 'UTC',
          enabled: true, runCount: 0, nextRunAt: '2026-09-05T00:00:00.000Z',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
        heartbeats: [{
          sessionId: 'session-1', prompt: 'Continue', cron: '*/5 * * * *', timezone: 'UTC',
          enabled: true, pending: true, revision: 1, createdAt: NOW, updatedAt: NOW,
        }],
      }),
      scheduleRuns: [{
        id: 'run-1', scheduleId: 'schedule-1', state: 'queued', scheduledFor: NOW,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    });

    expect(plan?.value).toEqual({ sessionIds: ['session-1'] });
    expect(plan?.commit.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'workspace.upsert', value: expect.objectContaining({ archivedAt: NOW }) }),
      expect.objectContaining({ kind: 'schedule.upsert', value: expect.objectContaining({ enabled: false }) }),
      expect.objectContaining({ kind: 'schedule-run.upsert', value: expect.objectContaining({ state: 'failed' }) }),
      { kind: 'heartbeat.delete', sessionId: 'session-1' },
    ]));
    expect(plan?.commit.mutations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session.upsert' }),
    ]));
  });

  it('archives one explicitly revoked external Workspace without disturbing its Project', () => {
    const sourceWorkspaceId = daemonWorkspaceId('project-1', 'root-1', 'root-1');
    const workspaceId = daemonWorkspaceId('project-1', 'root-1', 'external-1');
    expect(planDaemonWorkspaceRevocation({
      workspaces: [{
        id: workspaceId,
        projectId: 'project-1',
        name: 'review',
        kind: 'worktree',
        rootPath: 'C:\\External\\review',
        sourceWorkspaceId,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, {
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'external-1',
    }, NOW)).toEqual([{
      kind: 'workspace.upsert',
      value: {
        id: workspaceId,
        projectId: 'project-1',
        name: 'review',
        kind: 'worktree',
        rootPath: 'C:\\External\\review',
        sourceWorkspaceId,
        archivedAt: NOW,
      },
    }]);
  });

  it('archives a removed registered root and all of its descendant Workspaces during save', () => {
    const next: DaemonProjectSyncDescriptor = {
      id: 'project-1',
      name: 'EZTerminal',
      rootPath: 'C:\\Working\\EZTerminal',
      workspaces: [{
        id: 'root-primary', name: 'EZTerminal', kind: 'local', rootPath: 'C:\\Working\\EZTerminal',
      }],
    };
    expect(planDaemonProjectSaveTransition({
      projects: [{
        id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [
        {
          id: 'root-primary', projectId: 'project-1', name: 'EZTerminal', kind: 'local',
          rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'root-removed', projectId: 'project-1', name: 'Removed', kind: 'local',
          rootPath: 'D:\\Removed', revision: 1, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'removed-child', projectId: 'project-1', name: 'Removed child', kind: 'worktree',
          rootPath: 'D:\\Removed-worktree', sourceWorkspaceId: 'root-removed',
          revision: 1, createdAt: NOW, updatedAt: NOW,
        },
      ],
    }, {
      id: 'project-1',
      rootPaths: ['C:\\Working\\EZTerminal', 'D:\\Removed'],
    }, next, ['C:\\Working\\EZTerminal'], NOW)).toEqual([
      {
        kind: 'workspace.upsert',
        value: {
          id: 'root-removed', projectId: 'project-1', name: 'Removed', kind: 'local',
          rootPath: 'D:\\Removed', archivedAt: NOW,
        },
      },
      {
        kind: 'workspace.upsert',
        value: {
          id: 'removed-child', projectId: 'project-1', name: 'Removed child', kind: 'worktree',
          rootPath: 'D:\\Removed-worktree', sourceWorkspaceId: 'root-removed', archivedAt: NOW,
        },
      },
    ]);
  });

  it('archives the complete previous identity while publishing a new primary-root identity', () => {
    const next: DaemonProjectSyncDescriptor = {
      id: 'project-2',
      name: 'Moved',
      rootPath: 'D:\\Moved',
      workspaces: [{ id: 'root-new', name: 'Moved', kind: 'local', rootPath: 'D:\\Moved' }],
    };
    const mutations = planDaemonProjectSaveTransition({
      projects: [{
        id: 'project-1', name: 'Old', rootPath: 'C:\\Old', source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: 'root-old', projectId: 'project-1', name: 'Old', kind: 'local', rootPath: 'C:\\Old',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    }, { id: 'project-1', rootPaths: ['C:\\Old'] }, next, ['D:\\Moved'], NOW, {
      reactivateProjectIds: new Set(['project-2']),
    });

    expect(mutations).toEqual([
      {
        kind: 'workspace.upsert',
        value: {
          id: 'root-old', projectId: 'project-1', name: 'Old', kind: 'local',
          rootPath: 'C:\\Old', archivedAt: NOW,
        },
      },
      {
        kind: 'project.upsert',
        value: {
          id: 'project-1', name: 'Old', rootPath: 'C:\\Old', source: 'native', archivedAt: NOW,
        },
      },
      {
        kind: 'project.upsert',
        value: { id: 'project-2', name: 'Moved', rootPath: 'D:\\Moved', source: 'native' },
      },
      {
        kind: 'workspace.upsert',
        value: {
          id: 'root-new', projectId: 'project-2', name: 'Moved', kind: 'local', rootPath: 'D:\\Moved',
        },
      },
    ]);
  });

  it('translates an already-authorized descriptor without rediscovering its worktrees', () => {
    const built = resolvedDaemonProjectSyncDescriptor({
      projectId: 'project-1',
      name: 'Captured project',
      roots: [
        { rootId: 'root-1', name: 'root', displayPath: 'C:\\Working\\root', primary: true },
      ],
      workspaces: [
        {
          workspaceId: 'external-1', rootId: 'root-1', name: 'review',
          displayPath: 'C:\\External\\review', kind: 'external', access: 'granted',
        },
      ],
    });

    expect(built).toMatchObject({
      id: 'project-1',
      name: 'Captured project',
      workspaces: expect.arrayContaining([
        {
          id: daemonWorkspaceId('project-1', 'root-1', 'external-1'),
          name: 'review',
          kind: 'worktree',
          rootPath: 'C:\\External\\review',
          sourceWorkspaceId: daemonWorkspaceId('project-1', 'root-1', 'root-1'),
        },
      ]),
    });
  });

  it('namespaces renderer Workspace identities and keeps every root selectable', () => {
    const project = {
      projectId: 'project-1',
      name: 'Multi root',
      primaryRoot: 'C:\\Working\\frontend',
      additionalRoots: ['C:\\Working\\backend'],
      pinned: true,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: null,
    } as const;
    const workspaceDescriptor = {
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
    } as const;
    const built = daemonProjectSyncDescriptor(project, workspaceDescriptor);

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
    expect([...trustedDaemonWorkspaceReactivationIds(workspaceDescriptor)]).toEqual([
      frontRootId,
      backRootId,
      daemonWorkspaceId('project-1', 'root-front', 'shared-worktree'),
      daemonWorkspaceId('project-1', 'root-back', 'shared-worktree'),
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

  it('tombstones a deleted external Workspace after authoritative discovery omits it', () => {
    const [root, external] = descriptor.workspaces;
    const authoritativeDescriptor: DaemonProjectSyncDescriptor = {
      ...descriptor,
      workspaces: [root!],
      workspaceDiscovery: {
        roots: [{ sourceWorkspaceId: root!.id, status: 'complete' }],
      },
    };
    const options: DaemonProjectSyncOptions & { readonly archivedAt: string } = {
      archivedAt: NOW,
    };

    expect(planDaemonProjectSync({
      projects: [{
        id: descriptor.id, name: descriptor.name, rootPath: descriptor.rootPath, source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        ...root!, projectId: descriptor.id, revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        ...external!, projectId: descriptor.id, revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    }, [authoritativeDescriptor], options)).toEqual([{
      kind: 'workspace.upsert',
      value: {
        ...external!,
        projectId: descriptor.id,
        archivedAt: NOW,
      },
    }]);

    const productionPlan = planDaemonProjectSync({
      projects: [{
        id: descriptor.id, name: descriptor.name, rootPath: descriptor.rootPath, source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        ...root!, projectId: descriptor.id, revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        ...external!, projectId: descriptor.id, revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    }, [authoritativeDescriptor]);
    const productionTombstone = productionPlan[0];
    expect(productionTombstone).toMatchObject({
      kind: 'workspace.upsert',
      value: { id: external!.id, archivedAt: expect.any(String) },
    });
    expect(productionTombstone?.kind === 'workspace.upsert'
      && Number.isFinite(Date.parse(productionTombstone.value.archivedAt ?? ''))).toBe(true);
  });

  it('tombstones prior external authority when successful identity revalidation requires consent again', () => {
    const project = {
      projectId: 'project-1',
      name: 'EZTerminal',
      primaryRoot: 'C:\\Working\\EZTerminal',
      additionalRoots: [],
      pinned: true,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: null,
    } as const;
    const sourceWorkspaceId = daemonWorkspaceId('project-1', 'root-1', 'root-1');
    const externalWorkspaceId = daemonWorkspaceId('project-1', 'root-1', 'external-1');
    const revalidated = daemonProjectSyncDescriptor(project, {
      projectId: project.projectId,
      name: project.name,
      roots: [{
        rootId: 'root-1', name: project.name, displayPath: project.primaryRoot, primary: true,
      }],
      workspaces: [{
        workspaceId: 'root-1', rootId: 'root-1', name: project.name,
        displayPath: project.primaryRoot, kind: 'root', access: 'granted',
      }, {
        workspaceId: 'external-1', rootId: 'root-1', name: 'replacement',
        displayPath: 'D:\\Replacement', kind: 'external', access: 'authorization-required',
        repositoryId: 'repo-replacement',
      }],
      workspaceDiscovery: {
        roots: [{ rootId: 'root-1', status: 'complete' }],
      },
    });

    expect(planDaemonProjectSync({
      projects: [{
        id: project.projectId, name: project.name, rootPath: project.primaryRoot, source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: sourceWorkspaceId, projectId: project.projectId, name: project.name, kind: 'local',
        rootPath: project.primaryRoot, revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        id: externalWorkspaceId, projectId: project.projectId, name: 'approved external',
        kind: 'worktree', rootPath: 'C:\\External', sourceWorkspaceId,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    }, [revalidated], { archivedAt: NOW })).toEqual([{
      kind: 'workspace.upsert',
      value: {
        id: externalWorkspaceId,
        projectId: project.projectId,
        name: 'approved external',
        kind: 'worktree',
        rootPath: 'C:\\External',
        sourceWorkspaceId,
        archivedAt: NOW,
      },
    }]);
  });

  it('rejects unavailable Workspace discovery before a full daemon sync can preserve stale authority', () => {
    const project = {
      projectId: 'project-1',
      name: 'EZTerminal',
      primaryRoot: 'C:\\Working\\EZTerminal',
      additionalRoots: [],
      pinned: true,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: null,
    } as const;
    const unavailableDescriptor = {
      projectId: project.projectId,
      name: project.name,
      roots: [{
        rootId: 'root-1', name: project.name, displayPath: project.primaryRoot, primary: true,
      }],
      workspaces: [{
        workspaceId: 'root-1', rootId: 'root-1', name: project.name,
        displayPath: project.primaryRoot, kind: 'root', access: 'granted',
      }],
      workspaceDiscovery: {
        roots: [{ rootId: 'root-1', status: 'unavailable', error: 'git-failed' }],
      },
    } as const;
    const unavailable = daemonProjectSyncDescriptor(project, unavailableDescriptor);
    const sourceWorkspaceId = daemonWorkspaceId('project-1', 'root-1', 'root-1');
    const staleWorkspaceId = daemonWorkspaceId('project-1', 'root-1', 'external-1');

    expect(() => planDaemonProjectSync({
      projects: [{
        id: 'project-1', name: project.name, rootPath: project.primaryRoot, source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: sourceWorkspaceId, projectId: 'project-1', name: project.name, kind: 'local',
        rootPath: project.primaryRoot, revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        id: staleWorkspaceId, projectId: 'project-1', name: 'External', kind: 'worktree',
        rootPath: 'C:\\External', sourceWorkspaceId,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    }, [unavailable])).toThrowError(
      expect.objectContaining({
        name: 'DaemonProjectWorkspaceDiscoveryError',
        code: 'git-failed',
      }),
    );
  });

  it('keeps an ordinary non-Git Project usable when no active child authority exists', () => {
    const [root] = descriptor.workspaces;
    const unavailable: DaemonProjectSyncDescriptor = {
      ...descriptor,
      workspaces: [root!],
      workspaceDiscovery: {
        roots: [{
          sourceWorkspaceId: root!.id,
          status: 'unavailable',
          error: 'not-a-repository',
        }],
      },
    };

    expect(planDaemonProjectSync(snapshot(), [unavailable])).toEqual([
      { kind: 'project.upsert', value: {
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
      } },
      { kind: 'workspace.upsert', value: {
        ...root!,
        projectId: descriptor.id,
      } },
    ]);
  });

  it('preserves archived native identities during ambient synchronization', () => {
    const external = descriptor.workspaces[1]!;
    expect(planDaemonProjectSync({
      projects: [{
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [{
        ...external,
        projectId: descriptor.id,
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, [descriptor])).toEqual([]);
  });

  it('reactivates an archived Project and its Workspaces only for explicit re-registration', () => {
    const external = descriptor.workspaces[1]!;
    expect(planDaemonProjectSync({
      projects: [{
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [{
        ...external,
        projectId: descriptor.id,
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, [descriptor], {
      reactivateProjectIds: new Set([descriptor.id]),
      reactivateWorkspaceIds: new Set(descriptor.workspaces.map((workspace) => workspace.id)),
    })).toEqual(expect.arrayContaining([
      {
        kind: 'project.upsert',
        value: {
          id: descriptor.id,
          name: descriptor.name,
          rootPath: descriptor.rootPath,
          source: 'native',
        },
      },
      {
        kind: 'workspace.upsert',
        value: {
          ...external,
          projectId: descriptor.id,
        },
      },
    ]));
  });

  it('preserves a revoked Workspace during ambient sync of an active Project', () => {
    const [root, external] = descriptor.workspaces;
    expect(planDaemonProjectSync({
      projects: [{
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [{
        ...root!,
        projectId: descriptor.id,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        ...external!,
        projectId: descriptor.id,
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, [descriptor])).toEqual([]);
  });

  it('reactivates only the explicitly re-approved Workspace of an active Project', () => {
    const [root, external] = descriptor.workspaces;
    expect(planDaemonProjectSync({
      projects: [{
        id: descriptor.id,
        name: descriptor.name,
        rootPath: descriptor.rootPath,
        source: 'native',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [{
        ...root!,
        projectId: descriptor.id,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        ...external!,
        projectId: descriptor.id,
        archivedAt: NOW,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }, [descriptor], {
      reactivateWorkspaceIds: new Set([external!.id]),
    })).toEqual([{
      kind: 'workspace.upsert',
      value: {
        ...external!,
        projectId: descriptor.id,
      },
    }]);
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
