import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../shared/agent';
import type { AgentCoordinationSnapshot } from '../shared/agent-coordination';
import type { AgentCoordinationService } from './agent-coordination-service';
import { AgentControlServer, descriptorFingerprint } from './agent-control-server';
import type { AgentTeamService } from './agent-team-service';
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
  readonly teams: {
    readonly submitPlan: ReturnType<typeof vi.fn>;
    readonly waitForPlanDecision: ReturnType<typeof vi.fn>;
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
  const teams = {
    submitPlan: vi.fn(async () => ({ ok: true as const, value: { revision: 2 } })),
    waitForPlanDecision: vi.fn(async () => ({
      ok: true as const,
      value: { run: { revision: 3 }, assignment: { title: 'Implement' }, brief: 'Approved brief.' },
    })),
  };
  return {
    server: new AgentControlServer({
      coordination: coordination as unknown as AgentCoordinationService,
      merges: merges as unknown as ManagedMergeService,
      maps: maps as unknown as ProjectMapService,
      teams: teams as unknown as Pick<AgentTeamService, 'submitPlan' | 'waitForPlanDecision'>,
    }),
    coordination,
    maps,
    teams,
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

  it('keeps a dormant descriptor powerless until its session has joined collaboration', async () => {
    const { server, setSnapshot } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      setSnapshot({
        revision: 2,
        activityRevision: 2,
        activities: [activity('source', 'project-1', 'Builder', { participant: undefined })],
        projects: [],
        mergeRequests: [],
      });

      await expect(post(descriptor, '/v1/list', {})).resolves.toMatchObject({
        status: 403,
        body: { ok: false, error: 'collaboration-inactive' },
      });
    } finally {
      await server.stop();
    }
  });

  it('accepts a bounded Team plan only from the authenticated session identity', async () => {
    const { server, teams } = fixture();
    await server.start();
    try {
      const descriptor = JSON.parse(server.descriptorForSession('session-source')) as Descriptor;
      const runId = '123e4567-e89b-12d3-a456-426614174020';
      const proposal = {
        summary: 'Split implementation and review.',
        assignments: [{
          taskId: '123e4567-e89b-12d3-a456-426614174030',
          personaId: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Implement the bounded change',
          outcome: 'The requested behavior works.',
          scopeHints: ['src/'],
          validationIds: [],
          acceptanceCriteria: ['The focused test passes.'],
          brief: 'Implement only the assigned scope.',
        }],
        excludedMembers: [],
      };

      await expect(post(descriptor, '/v1/team/plan', {
        runId,
        expectedRevision: 1,
        proposal,
      })).resolves.toMatchObject({ status: 200, body: { ok: true } });
      expect(teams.submitPlan).toHaveBeenCalledWith('source', {
        runId,
        expectedRevision: 1,
        proposal,
      });
      expect(teams.waitForPlanDecision).toHaveBeenCalledWith(runId, 2, expect.any(AbortSignal));

      await expect(post(descriptor, '/v1/team/plan', {
        runId: '------------------------------------',
        expectedRevision: 1,
        proposal,
      })).resolves.toMatchObject({
        status: 400,
        body: { ok: false, error: 'invalid-request' },
      });
      expect(teams.submitPlan).toHaveBeenCalledTimes(1);
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
});
