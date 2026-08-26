import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentActivitySnapshot } from '../shared/agent';
import type { ProjectMapJob } from '../shared/project-map';
import { dispatchProjectMapAgentRequest } from './project-map-agent-launch';

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'activity-old',
    sessionId: 'session-old',
    provider: 'codex',
    providerLabel: 'Codex',
    cwd: 'C:\\Project',
    state: 'working',
    status: 'working',
    stateSeq: 1,
    live: true,
    interactiveReady: true,
    stateSource: 'provider-hook',
    projectId: 'project-1',
    rootId: 'root-1',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function projectMapJob(activityId: string): ProjectMapJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-1',
    ownerRootId: 'root-1',
    ownerWorkspaceId: 'workspace-1',
    type: 'workflow',
    intent: 'create',
    activityId,
    dispatch: 'dedicated-session',
    agentLabel: 'Codex',
    phase: 'queued',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function harness() {
  let listener: ((snapshot: AgentActivitySnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  const startProjectMapJob = vi.fn(async (request) => ({
    ok: true as const,
    job: projectMapJob(request.activityId),
  }));
  const cancelProjectMapJob = vi.fn(async () => ({ ok: true as const }));
  const submitPrompt = vi.fn();
  const dependencies = {
    getAgentActivitySnapshot: vi.fn(async () => ({
      revision: 1,
      items: [activity()],
    })),
    onAgentActivitySnapshot: vi.fn((next: (snapshot: AgentActivitySnapshot) => void) => {
      listener = next;
      return unsubscribe;
    }),
    startProjectMapJob,
    cancelProjectMapJob,
    submitPrompt,
  };
  return {
    dependencies,
    startProjectMapJob,
    cancelProjectMapJob,
    submitPrompt,
    unsubscribe,
    emit(snapshot: AgentActivitySnapshot) {
      listener?.(snapshot);
    },
  };
}

const request = {
  projectId: 'project-1',
  ownerRootId: 'root-1',
  ownerWorkspaceId: 'workspace-1',
  type: 'workflow' as const,
  intent: 'create' as const,
  brief: 'Create a verified workflow map for this repository.',
};

describe('dispatchProjectMapAgentRequest', () => {
  it('binds the job and prompt to the fresh terminal session instead of an existing Agent', async () => {
    const test = harness();
    const dispatch = dispatchProjectMapAgentRequest({
      sessionId: 'session-new',
      provider: 'codex',
      agentLabel: 'Codex',
      request,
      timeoutMs: 1_000,
      dependencies: test.dependencies,
    });

    await Promise.resolve();
    expect(test.startProjectMapJob).not.toHaveBeenCalled();
    test.emit({
      revision: 2,
      items: [
        activity(),
        activity({ id: 'activity-wrong-provider', sessionId: 'session-new', provider: 'claude' }),
        activity({ id: 'activity-new', sessionId: 'session-new', createdAt: 3, updatedAt: 3 }),
      ],
    });

    const job = await dispatch;
    expect(job.activityId).toBe('activity-new');
    expect(test.startProjectMapJob).toHaveBeenCalledWith({
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      type: 'workflow',
      intent: 'create',
      activityId: 'activity-new',
      dispatch: 'dedicated-session',
      agentLabel: 'Codex',
    });
    expect(test.submitPrompt).toHaveBeenCalledWith(expect.stringContaining(request.brief));
    expect(test.submitPrompt).toHaveBeenCalledWith(expect.stringContaining(job.id));
    expect(test.startProjectMapJob.mock.invocationCallOrder[0])
      .toBeLessThan(test.submitPrompt.mock.invocationCallOrder[0]);
    expect(test.cancelProjectMapJob).not.toHaveBeenCalled();
    expect(test.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancels the persisted job when terminal prompt submission fails', async () => {
    const test = harness();
    test.submitPrompt.mockImplementation(() => {
      throw new Error('pty-not-ready');
    });
    const dispatch = dispatchProjectMapAgentRequest({
      sessionId: 'session-new',
      provider: 'codex',
      agentLabel: 'Codex',
      request,
      timeoutMs: 1_000,
      dependencies: test.dependencies,
    });

    test.emit({
      revision: 2,
      items: [activity({ id: 'activity-new', sessionId: 'session-new' })],
    });

    await expect(dispatch).rejects.toThrow('pty-not-ready');
    expect(test.cancelProjectMapJob).toHaveBeenCalledWith({
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      jobId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('rejects an empty brief before waiting for or creating an activity-bound job', async () => {
    const test = harness();
    await expect(dispatchProjectMapAgentRequest({
      sessionId: 'session-new',
      provider: 'codex',
      agentLabel: 'Codex',
      request: { ...request, brief: '   ' },
      dependencies: test.dependencies,
    })).rejects.toThrow('empty, too large');
    expect(test.dependencies.onAgentActivitySnapshot).not.toHaveBeenCalled();
    expect(test.startProjectMapJob).not.toHaveBeenCalled();
  });
});
