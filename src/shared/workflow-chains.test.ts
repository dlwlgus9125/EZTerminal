import { describe, expect, it } from 'vitest';

import { WorkflowNodeSchema, workflowChainPredecessor, workflowChains, type WorkflowGraph, type WorkflowNode } from './workflow-graph';

const designer = { profileId: 'designer', name: 'Designer', providerId: 'claude', model: 'opus', capturedAt: '2026-10-29T00:00:00.000Z' };
const builder = { ...designer, profileId: 'builder', name: 'Builder' };
const stage = (id: string, patch: Partial<WorkflowNode> = {}) => WorkflowNodeSchema.parse({ id, title: id, operation: 'agent', providerId: 'claude', model: 'opus', agent: designer, ...patch });
const line = (...nodes: WorkflowNode[]): WorkflowGraph => ({ entryNodeId: nodes[0]!.id, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `e${index}`, from: nodes[index]!.id, to: node.id, outcome: nodes[index]!.operation === 'approval' ? 'approved' : 'next' })) });

describe('앞 대화 이어서 chains', () => {
  it('continues the same agent across person stages and stops at another agent or a fresh choice', () => {
    const graph = line(stage('req'), WorkflowNodeSchema.parse({ id: 'ask', title: 'Ask', operation: 'answer', answer: { prompt: 'Q' } }), stage('plan'), stage('mock'),
      stage('review', { role: 'review', session: 'fresh' }), WorkflowNodeSchema.parse({ id: 'ok', title: 'OK', operation: 'approval' }), stage('build', { agent: builder }), stage('test', { agent: builder, session: 'fresh' }));
    expect(workflowChainPredecessor(graph, 'plan')).toBe('req');
    expect(workflowChainPredecessor(graph, 'mock')).toBe('plan');
    expect(workflowChainPredecessor(graph, 'review')).toBeUndefined();
    expect(workflowChainPredecessor(graph, 'build')).toBeUndefined();
    expect(workflowChainPredecessor(graph, 'test')).toBeUndefined();
    expect(workflowChains(graph)).toEqual([['req', 'plan', 'mock']]);
  });

  it('never chains across a fork, a join or a different model', () => {
    const fork = WorkflowNodeSchema.parse({ id: 'fork', title: 'Fork', operation: 'parallel' });
    const graph: WorkflowGraph = { entryNodeId: 'a', nodes: [stage('a'), fork, stage('b'), stage('c')], edges: [
      { id: 'e1', from: 'a', to: 'fork', outcome: 'next' }, { id: 'e2', from: 'fork', to: 'b', outcome: 'next' }, { id: 'e3', from: 'fork', to: 'c', outcome: 'next' },
    ] };
    expect(workflowChains(graph)).toEqual([]);
    expect(workflowChainPredecessor(line(stage('a'), stage('b', { model: 'sonnet' })), 'b')).toBeUndefined();
    // A retry edge back does not break the line.
    const retried = line(stage('a'), stage('b'));
    retried.edges.push({ id: 'back', from: 'b', to: 'a', outcome: 'failed', retryLimit: 2 });
    expect(workflowChainPredecessor(retried, 'b')).toBe('a');
    // Passed and failed both leading to the next stage are one line.
    const both = line(stage('a'), stage('b'));
    both.edges.push({ id: 'failed', from: 'a', to: 'b', outcome: 'failed' });
    expect(workflowChainPredecessor(both, 'b')).toBe('a');
  });
});
