import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivity } from '../shared/agent';
import type { ExecutionRun } from '../shared/planning-execution';
import { HostAttentionService, type HostAttentionServiceOptions } from './host-attention-service';

const noDaemon = { sessions: [], agents: [], approvals: [] };

function run(runId: string, activations: Array<{ id: string; state: string }>, overrides: Record<string, unknown> = {}): ExecutionRun {
  return {
    runId, projectId: 'project-a', revision: 1, state: 'awaiting-review', updatedAt: '2026-10-25T04:00:00.000Z',
    preparation: { approvalPolicy: 'user', workflow: { subprojectId: 'login', graph: { nodes: [{ id: 'gate', title: 'Go-ahead' }] } } },
    workflowRuntime: { activations: activations.map((activation) => ({ ...activation, nodeId: 'gate' })) },
    ...overrides,
  } as unknown as ExecutionRun;
}

function harness(initial: Record<string, ExecutionRun[]> = {}) {
  const runs = new Map(Object.entries(initial));
  const refused = new Set<string>();
  let agents: AgentActivity[] = [];
  const announce = vi.fn(async () => undefined);
  const options: HostAttentionServiceOptions = {
    projectIds: () => [...runs.keys()],
    readRuns: (projectId) => runs.get(projectId) ?? [],
    autoApprovalRefused: (projectId, runId, activationId) => refused.has(`${projectId}/${runId}/${activationId}`),
    terminalAgents: () => agents,
    orchestrationWorkers: () => new Set(),
    announce,
  };
  const service = new HostAttentionService(options);
  return {
    service, announce, runs, refused,
    setAgents: (next: AgentActivity[]) => { agents = next; },
    settle: async () => { await vi.advanceTimersByTimeAsync(250); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('HostAttentionService', () => {
  it('announces once when a flow approval appears and once when it is resolved', async () => {
    const h = harness({ 'project-a': [run('run-1', [{ id: 'a1', state: 'active' }])] });
    h.runs.set('project-a', [run('run-1', [{ id: 'a1', state: 'awaiting-approval' }])]);
    h.service.projectChanged('project-a');
    h.service.projectChanged('project-a');
    await h.settle();
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.service.attention(noDaemon).items.map((item) => item.kind)).toEqual(['flow-approval']);
    h.runs.set('project-a', [run('run-1', [{ id: 'a1', state: 'completed' }])]);
    h.service.projectChanged('project-a');
    await h.settle();
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(h.service.attention(noDaemon).items).toEqual([]);
  });

  it('stays quiet for a commit that changes nothing it shows', async () => {
    const h = harness({ 'project-a': [run('run-1', [{ id: 'a1', state: 'awaiting-approval' }])] });
    h.service.projectChanged('project-a');
    await h.settle();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('shows an auto-approved run’s stage once the host’s decision was refused', async () => {
    const auto = run('run-1', [{ id: 'a1', state: 'awaiting-approval' }], { preparation: { approvalPolicy: 'auto', workflow: { subprojectId: 'login', graph: { nodes: [{ id: 'gate', title: 'Go-ahead' }] } } } });
    const h = harness({ 'project-a': [auto] });
    expect(h.service.attention(noDaemon).items).toEqual([]);
    h.refused.add('project-a/run-1/a1');
    h.service.projectChanged('project-a');
    await h.settle();
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.service.attention(noDaemon).items.map((item) => item.activationId)).toEqual(['a1']);
  });

  it('rebuilds what waits on a restart without announcing it, across projects', () => {
    const h = harness({
      'project-a': [run('run-1', [{ id: 'a1', state: 'awaiting-approval' }])],
      'project-b': [run('run-2', [{ id: 'b1', state: 'awaiting-approval' }]), run('run-3', [{ id: 'b2', state: 'awaiting-approval' }], { state: 'cancelled' })],
    });
    expect(h.service.attention(noDaemon).items.map((item) => item.runId).sort()).toEqual(['run-1', 'run-2']);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('announces a blocked terminal agent, debounced with other changes', async () => {
    const h = harness();
    h.setAgents([{ id: 'agent-1', provider: 'claude', state: 'blocked', status: 'blocked', stateSeq: 1, updatedAt: 0 } as AgentActivity]);
    h.service.terminalsChanged();
    h.service.terminalsChanged();
    await h.settle();
    expect(h.announce).toHaveBeenCalledTimes(1);
    h.setAgents([]);
    h.service.terminalsChanged();
    h.service.close();
    await h.settle();
    expect(h.announce).toHaveBeenCalledTimes(1);
  });

  it('reports a failed read and keeps what it had', async () => {
    const reportError = vi.fn();
    const runs = [run('run-1', [{ id: 'a1', state: 'awaiting-approval' }])];
    let fail = false;
    const service = new HostAttentionService({
      projectIds: () => ['project-a'], readRuns: () => { if (fail) throw new Error('locked'); return runs; },
      autoApprovalRefused: () => false, terminalAgents: () => [], orchestrationWorkers: () => new Set(), announce: async () => undefined, reportError,
    });
    fail = true;
    service.projectChanged('project-a');
    await vi.advanceTimersByTimeAsync(250);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(service.attention(noDaemon).items).toHaveLength(1);
  });
});
