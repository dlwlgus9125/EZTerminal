import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../shared/agent';
import type { AgentCoordinationSnapshot } from '../shared/agent-coordination';
import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot } from '../shared/daemon-protocol';
import type { AgentCoordinationService } from './agent-coordination-service';
import { AgentControlServer, descriptorFingerprint } from './agent-control-server';
import type { AgentOrchestrationService } from './agent-orchestration-service';
import type { ManagedMergeService } from './managed-merge-service';
import type { ProjectMapService } from './project-map-service';

interface Descriptor {
  readonly version: number;
  readonly origin: string;
  readonly token: string;
}

function activity(
  id: string,
  projectId: string,
  alias: string,
  overrides: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    sessionId: id === 'source' ? 'session-source' : `session-${id}`,
    provider: 'codex',
    cwd: `C:\\repo\\${id}`,
    state: 'done',
    status: 'done',
    stateSeq: 2,
    live: true,
    interactiveReady: true,
    stateSource: 'provider-hook',
    participant: {
      participantId: `participant-${id}`,
      projectId,
      rootId: `root-${id}`,
      workspaceId: `workspace-${id}`,
      alias,
      role: 'implementation',
      task: 'task',
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function post(
  descriptor: Descriptor,
  route: string,
  body: unknown,
  token = descriptor.token,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${descriptor.origin}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function fixture(): {
  readonly server: AgentControlServer;
  readonly coordination: {
    getSnapshot: ReturnType<typeof vi.fn>;
    resolveActivity: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
  };
  readonly maps: { readonly read: ReturnType<typeof vi.fn> };
  readonly orchestration: {
    readonly isWorkerSession: ReturnType<typeof vi.fn>;
    readonly listProfiles: ReturnType<typeof vi.fn>;
    readonly createWorker: ReturnType<typeof vi.fn>;
    readonly listWorkers: ReturnType<typeof vi.fn>;
    readonly readWorker: ReturnType<typeof vi.fn>;
    readonly promptWorker: ReturnType<typeof vi.fn>;
    readonly cancelWorker: ReturnType<typeof vi.fn>;
    readonly archiveWorker: ReturnType<typeof vi.fn>;
    readonly requestWorkerMerge: ReturnType<typeof vi.fn>;
    readonly completeRun: ReturnType<typeof vi.fn>;
    readonly reportWorker: ReturnType<typeof vi.fn>;
  };
  readonly daemon: {
    readonly getSnapshot: ReturnType<typeof vi.fn>;
    readonly execute: ReturnType<typeof vi.fn>;
  };
  readonly setSnapshot: (snapshot: AgentCoordinationSnapshot) => void;
} {
  const source = activity('source', 'project-1', 'Builder');
  const peer = activity('peer', 'project-1', 'Reviewer');
  const foreign = activity('foreign', 'project-2', 'Foreign');
  let snapshot = {
    revision: 1,
    activityRevision: 1,
    activities: [source, peer, foreign],
    projects: [
      { projectId: 'project-1' },
      { projectId: 'project-2' },
    ],
    mergeRequests: [
      { requestId: 'merge-1', projectId: 'project-1' },
      { requestId: 'merge-2', projectId: 'project-2' },
    ],
  } as unknown as AgentCoordinationSnapshot;
  const coordination = {
    getSnapshot: vi.fn(() => snapshot),
    resolveActivity: vi.fn((target: string) => (
      snapshot.activities.find((item) => item.id === target || item.participant?.alias === target) ?? null
    )),
    read: vi.fn(async () => ({ ok: true, text: 'bounded tail', truncated: false } as const)),
    prompt: vi.fn(async () => ({ ok: true } as const)),
    waitFor: vi.fn(async () => null),
  };
  const merges = {
    requestForActivity: vi.fn(async () => ({ ok: false, error: 'invalid', message: 'unused' } as const)),
    listRequests: vi.fn(() => snapshot.mergeRequests),
    waitForRequest: vi.fn(async () => null),
  };
  const maps = {
    read: vi.fn(async () => ({
      ok: true as const,
      map: {
        state: 'valid',
        mapId: 'runtime-architecture',
        spec: { type: 'architecture' },
        verification: { checks: [], diagnostics: [] },
        provenance: { kind: 'commit-pinned', roots: [] },
      },
    })),
  };
  const orchestration = {
    isWorkerSession: vi.fn(() => false),
    listProfiles: vi.fn(() => ({ ok: true as const, value: [{ profileId: 'reader' }] })),
    createWorker: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1' } })),
    listWorkers: vi.fn(() => ({ ok: true as const, value: [{ taskId: 'task-1' }] })),
    readWorker: vi.fn(() => ({ ok: true as const, value: { taskId: 'task-1', summary: 'bounded' } })),
    promptWorker: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1' } })),
    cancelWorker: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1', state: 'cancelled' } })),
    archiveWorker: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1', archivedAt: 3 } })),
    requestWorkerMerge: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1', state: 'merging' } })),
    completeRun: vi.fn(async () => ({ ok: true as const, value: { runId: 'run-1', state: 'completed' } })),
    reportWorker: vi.fn(async () => ({ ok: true as const, value: { taskId: 'task-1', state: 'done' } })),
  };
  const timestamp = '2026-09-04T00:00:00.000Z';
  const daemonSnapshot = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision: 4,
    eventSequence: 9,
    generatedAt: timestamp,
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'One', source: 'native', revision: 1, createdAt: timestamp, updatedAt: timestamp }],
    workspaces: [{ id: 'daemon-workspace-1', projectId: 'project-1', name: 'Main', kind: 'local', rootPath: 'C:\\repo', revision: 1, createdAt: timestamp, updatedAt: timestamp }],
    sessions: [{ id: 'session-source', projectId: 'project-1', workspaceId: 'daemon-workspace-1', kind: 'terminal', title: 'Shell', state: 'running', source: 'legacy-pty', revision: 1, createdAt: timestamp, updatedAt: timestamp }],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
  } satisfies DaemonSnapshot;
  const daemon = {
    getSnapshot: vi.fn(() => daemonSnapshot),
    execute: vi.fn(async () => ({ ok: true as const, status: 'applied' as const, commandId: 'command-1', revision: 5, eventSequence: 10 })),
  };
  return {
    server: new AgentControlServer({
      coordination: coordination as unknown as AgentCoordinationService,
      merges: merges as unknown as ManagedMergeService,
      maps: maps as unknown as ProjectMapService,
      orchestration: orchestration as unknown as AgentOrchestrationService,
      daemon,
    }),
    coordination,
    maps,
    orchestration,
    daemon,
    setSnapshot: (next) => { snapshot = next; },
  };
}

describe('AgentControlServer', () => {
  it('issues a stable per-session capability, authenticates it, and scopes list/read to one Project', async () => {
    const { server, coordination } = fixture();
    await server.start();
    try {
      const encoded = server.descriptorForSession('session-source');
      expect(server.descriptorForSession('session-source')).toBe(encoded);
      const descriptor = JSON.parse(encoded) as Descriptor;
      expect(descriptor).toMatchObject({ version: 1 });
      expect(descriptor.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(descriptor.token.length).toBeGreaterThanOrEqual(32);
      expect(descriptorFingerprint(encoded)).toMatch(/^[0-9a-f]{12}$/u);

      await expect(post(descriptor, '/v1/list', {}, 'wrong-token')).resolves.toMatchObject({
        status: 401,
        body: { ok: false, error: 'unauthorized' },
      });
      const listed = await post(descriptor, '/v1/list', {});
      expect(listed.status).toBe(200);
      const listedSnapshot = listed.body.snapshot as AgentCoordinationSnapshot;
      expect(listedSnapshot.activities.map((item) => item.id)).toEqual(['source', 'peer']);
      expect(listedSnapshot.projects.map((project) => project.projectId)).toEqual(['project-1']);
      expect(listedSnapshot.mergeRequests.map((request) => request.requestId)).toEqual(['merge-1']);

      await expect(post(descriptor, '/v1/read', { target: 'foreign', lines: 80 })).resolves.toMatchObject({
        status: 404,
        body: { ok: false },
      });
      expect(coordination.read).not.toHaveBeenCalled();
      await expect(post(descriptor, '/v1/read', { target: 'Reviewer', lines: 999 })).resolves.toMatchObject({
        status: 200,
        body: { ok: true },
      });
      expect(coordination.read).toHaveBeenCalledWith('peer', 200);

      server.revokeSession('session-source');
      await expect(post(descriptor, '/v1/list', {})).resolves.toMatchObject({ status: 401 });
    } finally {
      await server.stop();
    }
  });

  it('keeps legacy collaboration dormant while daemon control uses the registered Session scope', async () => {
    const { server, setSnapshot } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      setSnapshot({
        revision: 2,
        activityRevision: 2,
        activities: [],
        projects: [],
        mergeRequests: [],
      });

      await expect(post(descriptor, '/v1/list', {})).resolves.toMatchObject({
        status: 403,
        body: { ok: false, error: 'collaboration-inactive' },
      });
      await expect(post(descriptor, '/v1/daemon/status', {})).resolves.toMatchObject({
        status: 200,
        body: { ok: true, protocolVersion: 12, projectId: 'project-1' },
      });
    } finally {
      await server.stop();
    }
  });

  it('allows map authoring from an owning-workspace activity before collaboration join', async () => {
    const { server, maps, setSnapshot } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      setSnapshot({
        revision: 2,
        activityRevision: 2,
        activities: [activity('source', 'project-1', 'Builder', {
          projectId: 'project-1',
          rootId: 'root-source',
          workspaceId: 'workspace-source',
          participant: undefined,
        })],
        projects: [],
        mergeRequests: [],
      });

      await expect(post(descriptor, '/v1/list', {})).resolves.toMatchObject({
        status: 403,
        body: { ok: false, error: 'collaboration-inactive' },
      });
      await expect(post(descriptor, '/v1/map/guide', { type: 'architecture' })).resolves.toMatchObject({
        status: 200,
        body: { ok: true, guide: { type: 'architecture' } },
      });
      await expect(post(descriptor, '/v1/map/check', {})).resolves.toMatchObject({
        status: 200,
        body: { ok: true, state: 'valid' },
      });
      expect(maps.read).toHaveBeenCalledWith({
        projectId: 'project-1',
        ownerRootId: 'root-source',
        ownerWorkspaceId: 'workspace-source',
        quality: 'production',
      });
    } finally {
      await server.stop();
    }
  });

  it('serves the native authoring guide and checks only the participant-owned workspace', async () => {
    const { server, maps } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      const guide = await post(descriptor, '/v1/map/guide', { type: 'sequence' });
      expect(guide).toMatchObject({
        status: 200,
        body: { ok: true, guide: { type: 'sequence' } },
      });
      expect((guide.body.guide as { invariants: unknown[] }).invariants.length).toBeGreaterThan(3);

      await expect(post(descriptor, '/v1/map/guide', { type: 'html' })).resolves.toMatchObject({
        status: 400,
        body: { ok: false, error: 'invalid-map-type' },
      });
      await expect(post(descriptor, '/v1/map/check', { mapId: 'runtime-architecture' })).resolves.toMatchObject({
        status: 200,
        body: { ok: true, state: 'valid', mapId: 'runtime-architecture' },
      });
      expect(maps.read).toHaveBeenCalledWith({
        projectId: 'project-1',
        ownerRootId: 'root-source',
        ownerWorkspaceId: 'workspace-source',
        mapId: 'runtime-architecture',
        quality: 'production',
      });
    } finally {
      await server.stop();
    }
  });

  it('exposes bounded Lead worker operations through the session capability', async () => {
    const { server, orchestration } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      await expect(post(descriptor, '/v1/workers/profiles', {})).resolves.toMatchObject({ status: 200, body: { ok: true } });
      const createInput = {
        title: 'Inspect the parser',
        brief: 'Find the exact parser boundary and report evidence.',
        mode: 'read-only',
        profileId: 'reader',
        dependsOn: [],
        writeScopes: [],
      };
      await expect(post(descriptor, '/v1/workers/create', createInput)).resolves.toMatchObject({
        status: 200,
        body: { ok: true, value: { taskId: 'task-1' } },
      });
      expect(orchestration.createWorker).toHaveBeenCalledWith(expect.objectContaining({ id: 'source' }), createInput);
      await expect(post(descriptor, '/v1/workers', {})).resolves.toMatchObject({ status: 200, body: { ok: true } });
      await expect(post(descriptor, '/v1/workers/read', { taskId: 'task-1' })).resolves.toMatchObject({ status: 200 });
      await expect(post(descriptor, '/v1/workers/prompt', { taskId: 'task-1', text: 'Check one more edge.' })).resolves.toMatchObject({ status: 200 });
      await expect(post(descriptor, '/v1/workers/cancel', { taskId: 'task-1' })).resolves.toMatchObject({ status: 200 });
      await expect(post(descriptor, '/v1/workers/archive', { taskId: 'task-1' })).resolves.toMatchObject({ status: 200 });
      await expect(post(descriptor, '/v1/workers/merge', { taskId: 'task-1', targetBranch: 'main' })).resolves.toMatchObject({ status: 200 });
      await expect(post(descriptor, '/v1/workers/complete', { runId: 'run-1' })).resolves.toMatchObject({ status: 200 });
      expect(orchestration.requestWorkerMerge).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'source' }),
        'task-1',
        'main',
      );
    } finally {
      await server.stop();
    }
  });

  it('enforces depth one: a worker can report only and cannot create or control peers', async () => {
    const { server, orchestration, coordination, setSnapshot } = fixture();
    orchestration.isWorkerSession.mockImplementation((sessionId: string) => sessionId === 'session-worker');
    setSnapshot({
      revision: 2,
      activityRevision: 2,
      activities: [activity('worker', 'project-1', 'Worker')],
      projects: [],
      mergeRequests: [],
    });
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-worker')) as Descriptor;
      await expect(post(descriptor, '/v1/workers/create', {
        title: 'Nested worker',
        brief: 'This must never start.',
        mode: 'read-only',
        profileId: 'reader',
      })).resolves.toMatchObject({
        status: 403,
        body: { ok: false, error: 'worker-depth-limit' },
      });
      await expect(post(descriptor, '/v1/workers/cancel', { taskId: 'peer-task' })).resolves.toMatchObject({
        status: 403,
        body: { ok: false, error: 'worker-depth-limit' },
      });
      expect(orchestration.createWorker).not.toHaveBeenCalled();
      expect(orchestration.cancelWorker).not.toHaveBeenCalled();

      await expect(post(descriptor, '/v1/worker/report', {
        taskId: 'task-1',
        outcome: 'succeeded',
        summary: 'Inspected the requested boundary.',
      })).resolves.toMatchObject({ status: 200, body: { ok: true } });
      expect(orchestration.reportWorker).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-worker' }),
        'task-1',
        expect.objectContaining({ outcome: 'succeeded' }),
      );
      expect(coordination.getSnapshot).toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
