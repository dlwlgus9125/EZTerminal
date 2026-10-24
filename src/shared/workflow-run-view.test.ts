import { describe, expect, it } from 'vitest';
import type { ExecutionRun } from './planning-execution';
import { createWorkflowGraph } from './workflow-graph';
import { currentFlowRun, flowRunNumber, runStageConversation, sameWorkflowStructure } from './workflow-run-view';

const graph = createWorkflowGraph('research', 'sub');
const run = (runId: string, createdAt: string, state: ExecutionRun['state'], started = true, subprojectId = 'sub'): ExecutionRun => ({
  runId, projectId: 'project', revision: 1, state, createdAt, updatedAt: createdAt, ...(started ? { startedAt: createdAt } : {}),
  preparationFingerprint: 'f'.repeat(64), tasks: [], attempts: [], evidence: [], reviews: [], gates: [],
  preparation: { subprojectId, workflow: { subprojectId, revision: 1, fingerprint: 'c'.repeat(64), graph } },
}) as unknown as ExecutionRun;

describe('the run a flow shows', () => {
  it('prefers the run still going over a newer one, and numbers runs in the order they were prepared', () => {
    const first = run('a', '2026-10-25T01:00:00.000Z', 'completed');
    const going = run('b', '2026-10-25T02:00:00.000Z', 'paused');
    const preparedOnly = run('c', '2026-10-25T03:00:00.000Z', 'prepared', false);
    const other = run('x', '2026-10-25T04:00:00.000Z', 'running', true, 'other');
    const runs = [preparedOnly, other, going, first];
    expect(currentFlowRun(runs, 'sub')?.runId).toBe('b');
    expect(currentFlowRun([first, preparedOnly], 'sub')?.runId).toBe('c');
    expect(currentFlowRun([], 'sub')).toBeUndefined();
    expect([first, going, preparedOnly].map((entry) => flowRunNumber(runs, entry))).toEqual([1, 2, 3]);
    expect(flowRunNumber(runs, other)).toBe(1);
  });
});

describe('a stage conversation in one run', () => {
  it('is the latest attempt, working or done, with its latest review', () => {
    const base = run('a', '2026-10-25T01:00:00.000Z', 'running');
    const node = graph.nodes[0]!.id;
    expect(runStageConversation(base, node)).toBeUndefined();
    const withAttempts = { ...base,
      attempts: [{ attemptId: 'a1', taskId: node, number: 1, sessionId: 's1', state: 'failed' }, { attemptId: 'a2', taskId: node, number: 2, sessionId: 's2', state: 'running' }],
      reviews: [{ attemptId: 'a1', reviewerSessionId: 'r1' }] } as unknown as ExecutionRun;
    expect(runStageConversation(withAttempts, node)).toEqual({ sessionId: 's2', attemptId: 'a2', working: true });
    const reviewed = { ...withAttempts, attempts: withAttempts.attempts.map((entry) => ({ ...entry, state: 'succeeded' })),
      reviews: [...withAttempts.reviews, { attemptId: 'a2', reviewerSessionId: 'r2' }] } as unknown as ExecutionRun;
    expect(runStageConversation(reviewed, node)).toEqual({ sessionId: 's2', attemptId: 'a2', working: false, reviewSessionId: 'r2' });
  });
});

describe('sameWorkflowStructure', () => {
  it('ignores a stage’s own settings and position, not its kind, connections or the starting stage', () => {
    const edited = { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, instructions: 'New', reasoningEffort: 'high', position: { x: 9, y: 9 } } : node) };
    expect(sameWorkflowStructure(graph, edited)).toBe(true);
    expect(sameWorkflowStructure(graph, { ...graph, entryNodeId: graph.nodes[1]!.id })).toBe(false);
    expect(sameWorkflowStructure(graph, { ...graph, edges: graph.edges.slice(1) })).toBe(false);
    expect(sameWorkflowStructure(graph, { ...graph, edges: graph.edges.map((edge, index) => index === 0 ? { ...edge, outcome: 'failed' as const } : edge) })).toBe(false);
    expect(sameWorkflowStructure(graph, { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, role: 'review' as const } : node) })).toBe(false);
  });
});
