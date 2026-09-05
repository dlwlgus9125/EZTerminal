import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentActivitySnapshot, AgentState } from '../shared/agent';
import type { ManagedMergeRequest } from '../shared/agent-coordination';
import type { AgentProjectRecord } from './agent-project-store';
import {
  AgentCoordinationService,
  type AgentWorkspaceIdentity,
  type CoordinationActivitySource,
  type CoordinationMergeSource,
} from './agent-coordination-service';
import { AgentCoordinationStore } from './agent-coordination-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-service-'));

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'activity-1',
    sessionId: 'session-1',
    provider: 'codex',
    cwd: 'C:\\repo\\agent-one',
    state: 'done',
    status: 'done',
    stateSeq: 3,
    live: true,
    interactiveReady: true,
    stateSource: 'provider-hook',
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

class FakeActivities implements CoordinationActivitySource {
  snapshot: AgentActivitySnapshot;
  private readonly listeners = new Set<(snapshot: AgentActivitySnapshot) => void>();
  readonly sendPrompt = vi.fn(async () => ({ ok: true } as const));
  readonly readActivity = vi.fn(async () => ({ ok: true, text: 'tail', truncated: false } as const));
  readonly markSeen = vi.fn(() => true);

  constructor(items: readonly AgentActivity[]) {
    this.snapshot = { revision: 1, items };
  }

  getSnapshot(): AgentActivitySnapshot {
    return this.snapshot;
  }

  onSnapshot(listener: (snapshot: AgentActivitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(items: readonly AgentActivity[]): void {
    this.snapshot = { revision: this.snapshot.revision + 1, items };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

async function configuredStore(directory = makeDir()): Promise<AgentCoordinationStore> {
  const store = new AgentCoordinationStore(directory);
  await store.init();
  const saved = await store.saveProject({
    projectId: 'project-1',
    goal: 'Coordinate two coding agents safely',
    defaultTargetBranch: 'main',
    validationCommands: [{
      id: 'unit',
      name: 'Unit tests',
      command: 'pnpm test:unit',
      timeoutMs: 60_000,
    }],
  });
  if (!saved.ok) throw new Error('fixture configuration failed');
  return store;
}

const projects = [{ projectId: 'project-1' }] as unknown as readonly AgentProjectRecord[];

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('AgentCoordinationService', () => {
  it('projects workspace identity for a live activity before coordination join', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity()]);
    const resolveWorkspace = vi.fn(async () => ({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    }));
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace,
    });

    await vi.waitFor(() => {
      expect(service.getSnapshot().activities[0]).toMatchObject({
        id: 'activity-1',
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      });
    });
    expect(service.getSnapshot().activities[0]?.participant).toBeUndefined();
    expect(resolveWorkspace).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('waits for a working activity before delivering a queued prompt', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity({
      state: 'working',
      status: 'working',
      stateSeq: 1,
    })]);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace: async () => ({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      }),
    });

    const pending = service.prompt('activity-1', 'Create the map.', {
      whenReady: true,
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    expect(activities.sendPrompt).not.toHaveBeenCalled();
    activities.emit([activity({ state: 'done', status: 'done', stateSeq: 2 })]);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(activities.sendPrompt).toHaveBeenCalledWith('activity-1', 'Create the map.');
    service.dispose();
  });

  it('joins only a live provider activity, projects transient metadata, and generates an explicit brief', async () => {
    const directory = makeDir();
    const store = await configuredStore(directory);
    const activities = new FakeActivities([activity()]);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace: async () => ({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
      newId: () => 'participant-1',
      now: () => 100,
    });

    const joined = await service.join({
      activityId: 'activity-1',
      alias: '  Builder  ',
      role: 'implementation',
      task: 'Add managed merge',
      expectedProjectRevision: 1,
    });

    expect(joined).toMatchObject({
      ok: true,
      value: {
        participant: {
          participantId: 'participant-1',
          alias: 'Builder',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      },
    });
    if (!joined.ok) throw new Error('join failed');
    expect(joined.value.brief).toContain('Project goal: Coordinate two coding agents safely');
    expect(joined.value.brief).toContain('ezterminal-agent merge request --target main --wait');
    expect(service.resolveActivity('builder')?.id).toBe('activity-1');
    expect(service.getSnapshot().activities[0]?.participant).toMatchObject({ alias: 'Builder' });

    const reloaded = new AgentCoordinationStore(directory);
    await reloaded.init();
    expect(reloaded.getProject('project-1')?.participants).toEqual([]);

    activities.emit([activity({ live: false, state: 'idle', status: 'idle', stateSeq: 4 })]);
    expect(service.getParticipantByActivity('activity-1')).toBeNull();
    expect(service.getSnapshot().projects[0]?.participants).toEqual([]);
    service.dispose();
  });

  it('removes Project authority immediately and detaches participant and workspace caches', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity()]);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace: async () => ({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      }),
      newId: () => 'participant-1',
    });
    await expect(service.join({
      activityId: 'activity-1', alias: 'Builder', role: 'code', task: 'remove safely',
    })).resolves.toMatchObject({ ok: true });

    const removing = service.removeProjectAuthority('project-1');
    expect(service.getParticipantByActivity('activity-1')).toBeNull();
    expect(service.getProject('project-1')).toBeNull();
    expect(service.getSnapshot().activities[0]).not.toHaveProperty('projectId');
    expect(service.getSnapshot().activities[0]?.participant).toBeUndefined();
    expect(service.getSnapshot().projects).toEqual([]);

    await expect(removing).resolves.toBe(true);
    expect(store.getProject('project-1')).toBeNull();
    service.dispose();
  });

  it('generation-fences late workspace resolution and join completion across remove and restore', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity()]);
    const initialResolution = deferred<AgentWorkspaceIdentity | null>();
    const joiningResolution = deferred<AgentWorkspaceIdentity | null>();
    const revokedResolution = deferred<AgentWorkspaceIdentity | null>();
    const restoredResolution = deferred<AgentWorkspaceIdentity | null>();
    const resolveWorkspace = vi.fn()
      .mockReturnValueOnce(initialResolution.promise)
      .mockReturnValueOnce(joiningResolution.promise)
      .mockReturnValueOnce(revokedResolution.promise)
      .mockReturnValueOnce(restoredResolution.promise);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace,
      newId: () => 'participant-1',
    });
    const joining = service.join({
      activityId: 'activity-1', alias: 'Builder', role: 'code', task: 'must become stale',
    });
    expect(resolveWorkspace).toHaveBeenCalledTimes(2);

    await expect(service.removeProjectAuthority('project-1')).resolves.toBe(true);
    const restored = await store.saveProject({
      projectId: 'project-1',
      goal: 'Explicitly restored Project',
      defaultTargetBranch: 'main',
      validationCommands: [],
    });
    expect(restored.ok).toBe(true);
    expect(service.restoreProjectAuthority('project-1')).toBe(true);
    expect(resolveWorkspace).toHaveBeenCalledTimes(4);

    const identity = {
      projectId: 'project-1', rootId: 'root-1', workspaceId: 'workspace-1',
    } as const;
    initialResolution.resolve(identity);
    joiningResolution.resolve(identity);
    revokedResolution.resolve(identity);
    await expect(joining).resolves.toMatchObject({ ok: false, error: 'stale' });
    expect(service.getParticipantByActivity('activity-1')).toBeNull();
    expect(service.getSnapshot().activities[0]).not.toHaveProperty('projectId');

    restoredResolution.resolve(identity);
    await vi.waitFor(() => {
      expect(service.getSnapshot().activities[0]).toMatchObject({
        projectId: 'project-1', rootId: 'root-1', workspaceId: 'workspace-1',
      });
    });
    expect(service.getSnapshot().activities[0]?.participant).toBeUndefined();
    service.dispose();
  });

  it('removes only matching Workspace authority while preserving Project configuration and unrelated participants', async () => {
    const store = await configuredStore();
    await store.saveProject({
      projectId: 'project-2',
      goal: 'Keep the other Project active',
      defaultTargetBranch: 'main',
      validationCommands: [],
    });
    const activities = new FakeActivities([
      activity(),
      activity({ id: 'activity-sibling', sessionId: 'session-sibling', cwd: 'C:\\repo\\sibling' }),
      activity({ id: 'activity-foreign', sessionId: 'session-foreign', cwd: 'C:\\other' }),
      activity({ id: 'activity-unjoined', sessionId: 'session-unjoined', cwd: 'C:\\repo\\unjoined' }),
    ]);
    let nextParticipantId = 0;
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => [
        { projectId: 'project-1' },
        { projectId: 'project-2' },
      ] as unknown as readonly AgentProjectRecord[],
      resolveWorkspace: async (item) => {
        if (item.id === 'activity-foreign') {
          return { projectId: 'project-2', rootId: 'root-foreign', workspaceId: 'workspace-foreign' };
        }
        if (item.id === 'activity-sibling') {
          return { projectId: 'project-1', rootId: 'root-sibling', workspaceId: 'workspace-sibling' };
        }
        return {
          projectId: 'project-1',
          rootId: 'root-target',
          workspaceId: item.id === 'activity-unjoined' ? 'workspace-unjoined' : 'workspace-target',
        };
      },
      newId: () => `participant-${String(++nextParticipantId)}`,
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().activities.find((item) => item.id === 'activity-unjoined'))
        .toMatchObject({ projectId: 'project-1', rootId: 'root-target', workspaceId: 'workspace-unjoined' });
    });
    for (const activityId of ['activity-1', 'activity-sibling', 'activity-foreign']) {
      await expect(service.join({
        activityId,
        alias: activityId,
        role: 'code',
        task: 'stay correctly scoped',
      })).resolves.toMatchObject({ ok: true });
    }

    expect(service.removeWorkspaceAuthority('project-1', 'root-target', 'workspace-target')).toBe(true);
    expect(service.getParticipantByActivity('activity-1')).toBeNull();
    expect(service.getParticipantByActivity('activity-sibling')).not.toBeNull();
    expect(service.getParticipantByActivity('activity-foreign')).not.toBeNull();
    expect(service.getSnapshot().activities.find((item) => item.id === 'activity-unjoined'))
      .toMatchObject({ projectId: 'project-1', workspaceId: 'workspace-unjoined' });

    expect(service.removeWorkspaceAuthority('project-1', 'root-target')).toBe(true);
    expect(service.getSnapshot().activities.find((item) => item.id === 'activity-unjoined'))
      .not.toHaveProperty('projectId');
    expect(service.getParticipantByActivity('activity-sibling')).not.toBeNull();
    expect(service.getParticipantByActivity('activity-foreign')).not.toBeNull();
    expect(service.getSnapshot().projects.map((project) => project.projectId))
      .toEqual(['project-1', 'project-2']);
    expect(store.getProject('project-1')).not.toBeNull();
    service.dispose();
  });

  it('generation-fences a pending Workspace resolver across revoke and explicit restore', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity()]);
    const beforeRevoke = deferred<AgentWorkspaceIdentity | null>();
    const joiningBeforeRevoke = deferred<AgentWorkspaceIdentity | null>();
    const whileRevoked = deferred<AgentWorkspaceIdentity | null>();
    const afterRestore = deferred<AgentWorkspaceIdentity | null>();
    const resolveWorkspace = vi.fn()
      .mockReturnValueOnce(beforeRevoke.promise)
      .mockReturnValueOnce(joiningBeforeRevoke.promise)
      .mockReturnValueOnce(whileRevoked.promise)
      .mockReturnValueOnce(afterRestore.promise);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace,
    });
    const joining = service.join({
      activityId: 'activity-1', alias: 'Builder', role: 'code', task: 'must not cross revoke',
    });

    expect(service.removeWorkspaceAuthority('project-1', 'root-1', 'workspace-1')).toBe(true);
    expect(service.restoreWorkspaceAuthority('project-1', 'root-1', 'workspace-1')).toBe(true);
    expect(resolveWorkspace).toHaveBeenCalledTimes(4);
    const identity = { projectId: 'project-1', rootId: 'root-1', workspaceId: 'workspace-1' } as const;
    beforeRevoke.resolve(identity);
    joiningBeforeRevoke.resolve(identity);
    whileRevoked.resolve(identity);
    await expect(joining).resolves.toMatchObject({ ok: false, error: 'stale' });
    await Promise.resolve();
    expect(service.getSnapshot().activities[0]).not.toHaveProperty('projectId');

    afterRestore.resolve(identity);
    await vi.waitFor(() => expect(service.getSnapshot().activities[0]).toMatchObject(identity));
    expect(store.getProject('project-1')).not.toBeNull();
    service.dispose();
  });

  it('rejects generic, stale, and duplicate-alias joins', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([
      activity(),
      activity({ id: 'activity-2', sessionId: 'session-2', provider: 'claude' }),
      activity({ id: 'activity-3', sessionId: 'session-3', provider: 'generic' }),
    ]);
    let nextId = 0;
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace: async (item) => ({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: `workspace-${item.id}`,
      }),
      newId: () => `participant-${String(++nextId)}`,
    });

    await expect(service.join({
      activityId: 'activity-1', alias: 'Builder', role: 'code', task: 'one', expectedProjectRevision: 0,
    })).resolves.toMatchObject({ ok: false, error: 'stale' });
    await expect(service.join({
      activityId: 'activity-3', alias: 'Other', role: 'code', task: 'generic',
    })).resolves.toMatchObject({ ok: false, error: 'not-found' });
    await expect(service.join({
      activityId: 'activity-1', alias: 'Builder', role: 'code', task: 'one',
    })).resolves.toMatchObject({ ok: true });
    await expect(service.join({
      activityId: 'activity-2', alias: 'builder', role: 'review', task: 'two',
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    service.dispose();
  });

  it('strips validation output from snapshots and aborts long polling promptly', async () => {
    const store = await configuredStore();
    const activities = new FakeActivities([activity({ state: 'working', status: 'working' })]);
    const service = new AgentCoordinationService({
      activities,
      store,
      listProjects: () => projects,
      resolveWorkspace: async () => ({ projectId: 'project-1', rootId: 'root-1', workspaceId: 'workspace-1' }),
    });
    const mergeRequest = {
      requestId: 'request-1',
      revision: 2,
      projectId: 'project-1',
      participantId: 'participant-1',
      activityId: 'activity-1',
      sourceWorkspaceId: 'workspace-1',
      sourceBranch: 'agent/feature',
      sourceHead: '1'.repeat(40),
      targetBranch: 'main',
      targetHead: '2'.repeat(40),
      state: 'validating',
      validationConfigRevision: 1,
      validations: [{ id: 'unit', name: 'Unit', status: 'running', outputTail: 'SECRET OUTPUT' }],
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
    } satisfies ManagedMergeRequest;
    const mergeListeners = new Set<() => void>();
    const merges: CoordinationMergeSource = {
      listRequests: () => [mergeRequest],
      onRequests: (listener) => {
        mergeListeners.add(listener);
        return () => mergeListeners.delete(listener);
      },
    };
    service.bindMergeSource(merges);
    expect(JSON.stringify(service.getSnapshot())).not.toContain('SECRET OUTPUT');

    const controller = new AbortController();
    const waiting = service.waitFor('activity-1', new Set<AgentState>(['done']), 3, 60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeNull();
    service.dispose();
  });
});
