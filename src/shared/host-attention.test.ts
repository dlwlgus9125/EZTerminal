import { describe, expect, it } from 'vitest';
import type { AgentActivity } from './agent';
import type { DaemonSnapshot } from './daemon-protocol';
import { attentionDigest, computeHostAttention, type HostAttentionInput } from './host-attention';
import type { ExecutionRun } from './planning-execution';

type Daemon = HostAttentionInput['daemon'];

function daemon(overrides: Partial<{ [K in keyof Daemon]: unknown[] }> = {}): Daemon {
  return {
    sessions: [
      { id: 'chat-1', projectId: 'project-a', title: 'Fix login', createdAt: '2026-10-25T00:00:00.000Z' },
      { id: 'chat-2', projectId: 'project-b', title: 'Archived chat', archivedAt: '2026-10-25T00:00:00.000Z' },
      { id: 'chat-3', projectId: 'project-a', title: 'No agent' },
    ],
    agents: [{ sessionId: 'chat-1' }, { sessionId: 'chat-2' }],
    approvals: [
      { id: 'approval-1', sessionId: 'chat-1', state: 'pending', title: 'Run tests', createdAt: '2026-10-25T01:00:00.000Z', request: { kind: 'command', command: 'pnpm test' } },
      { id: 'question-1', sessionId: 'chat-1', state: 'pending', title: 'Which?', createdAt: '2026-10-25T02:00:00.000Z', request: { kind: 'question', questions: [] } },
      { id: 'resolved', sessionId: 'chat-1', state: 'allowed', title: 'Done', createdAt: '2026-10-25T03:00:00.000Z' },
      { id: 'archived', sessionId: 'chat-2', state: 'pending', title: 'Archived', createdAt: '2026-10-25T03:00:00.000Z' },
      { id: 'agentless', sessionId: 'chat-3', state: 'pending', title: 'No agent', createdAt: '2026-10-25T03:00:00.000Z' },
    ],
    ...overrides,
  } as unknown as Daemon;
}

function run(overrides: Record<string, unknown> = {}): ExecutionRun {
  return {
    runId: 'run-1', projectId: 'project-a', revision: 4, state: 'awaiting-review', updatedAt: '2026-10-25T04:00:00.000Z',
    preparation: { approvalPolicy: 'user', workflow: { subprojectId: 'login', graph: { nodes: [{ id: 'gate', title: 'Go-ahead' }] } } },
    workflowRuntime: { activations: [
      { id: 'activation-1', nodeId: 'gate', state: 'awaiting-approval' },
      { id: 'activation-0', nodeId: 'gate', state: 'completed' },
    ] },
    ...overrides,
  } as unknown as ExecutionRun;
}

const agent = (overrides: Partial<AgentActivity>): AgentActivity => ({
  id: 'activity-1', sessionId: 'pty-1', provider: 'claude', state: 'blocked', status: 'blocked', stateSeq: 3, projectId: 'project-a',
  updatedAt: Date.parse('2026-10-25T05:00:00.000Z'), ...overrides,
} as AgentActivity);

const none = (): boolean => false;

describe('computeHostAttention', () => {
  it('counts pending approvals and questions of live sessions only', () => {
    const result = computeHostAttention({ daemon: daemon(), flows: [], terminalAgents: [], orchestrationWorkers: new Set() });
    expect(result.items.map((item) => [item.kind, item.approvalId])).toEqual([['question', 'question-1'], ['approval', 'approval-1']]);
    expect(result.items[0]).toMatchObject({ projectId: 'project-a', title: 'Fix login', sessionId: 'chat-1' });
  });

  it('counts an approval stage of a going run, not of a finished or cancelled one', () => {
    const flows = [{ projectId: 'project-a', run: run(), autoApprovalRefused: none }];
    expect(computeHostAttention({ daemon: daemon({ approvals: [] }), flows, terminalAgents: [], orchestrationWorkers: new Set() }).items).toEqual([
      expect.objectContaining({ kind: 'flow-approval', projectId: 'project-a', subprojectId: 'login', runId: 'run-1', runRevision: 4, activationId: 'activation-1', nodeId: 'gate', title: 'Go-ahead' }),
    ]);
    for (const state of ['completed', 'cancelled']) {
      expect(computeHostAttention({ daemon: daemon({ approvals: [] }), flows: [{ projectId: 'project-a', run: run({ state }), autoApprovalRefused: none }], terminalAgents: [], orchestrationWorkers: new Set() }).items).toEqual([]);
    }
  });

  it('counts an auto-approved run’s stage only once the host refused to decide it', () => {
    const auto = run({ preparation: { approvalPolicy: 'auto', workflow: { subprojectId: 'login', graph: { nodes: [{ id: 'gate', title: 'Go-ahead' }] } } } });
    const input = (refused: boolean) => ({ daemon: daemon({ approvals: [] }), flows: [{ projectId: 'project-a', run: auto, autoApprovalRefused: (id: string) => refused && id === 'activation-1' }], terminalAgents: [], orchestrationWorkers: new Set<string>() });
    expect(computeHostAttention(input(false)).items).toEqual([]);
    expect(computeHostAttention(input(true)).items.map((item) => item.kind)).toEqual(['flow-approval']);
  });

  it('counts blocked terminal agents only, and leaves orchestration workers to their lead', () => {
    const agents = [agent({}), agent({ id: 'done-1', state: 'done' }), agent({ id: 'error-1', state: 'error' }), agent({ id: 'worker-1' })];
    const result = computeHostAttention({ daemon: daemon({ approvals: [] }), flows: [], terminalAgents: agents, orchestrationWorkers: new Set(['worker-1']) });
    expect(result.items).toEqual([expect.objectContaining({ kind: 'terminal-agent', activityId: 'activity-1', projectId: 'project-a', title: 'claude' })]);
  });

  it('keeps ids stable for the same wait and the digest independent of order', () => {
    const input = { daemon: daemon(), flows: [{ projectId: 'project-a', run: run(), autoApprovalRefused: none }], terminalAgents: [agent({})], orchestrationWorkers: new Set<string>() };
    const first = computeHostAttention(input);
    const again = computeHostAttention({ ...input, daemon: daemon({ approvals: [...(daemon().approvals as unknown[])].reverse() }) });
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(again.digest).toBe(first.digest);
    expect(attentionDigest([...first.items].reverse())).toBe(first.digest);
    // A new wait of the same agent (its state moved on and back) is another item.
    expect(computeHostAttention({ ...input, terminalAgents: [agent({ stateSeq: 5 })] }).digest).not.toBe(first.digest);
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length);
  });

  it('is empty, with a stable digest, when nothing waits', () => {
    const empty = computeHostAttention({ daemon: { sessions: [], agents: [], approvals: [] } as unknown as Pick<DaemonSnapshot, 'sessions' | 'agents' | 'approvals'>, flows: [], terminalAgents: [], orchestrationWorkers: new Set() });
    expect(empty).toEqual({ version: 1, digest: expect.stringMatching(/^[0-9a-f]{16}$/u), items: [] });
  });
});
