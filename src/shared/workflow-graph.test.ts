import { describe, expect, it } from 'vitest';
import { createWorkflowGraph, validateWorkflowGraph, WorkflowNodeSchema, workflowOutcomePorts, type WorkflowGraph } from './workflow-graph';

describe('workflowOutcomePorts', () => {
  it('lists the outcomes each stage kind can route', () => {
    expect(workflowOutcomePorts('agent')).toEqual(['next', 'passed', 'failed']);
    expect(workflowOutcomePorts('condition')).toEqual(['passed', 'failed']);
    expect(workflowOutcomePorts('approval')).toEqual(['approved', 'rejected']);
    expect(workflowOutcomePorts('parallel')).toEqual(['next']);
    expect(workflowOutcomePorts('join')).toEqual(['next']);
    expect(workflowOutcomePorts('complete')).toEqual([]);
  });

  it('is what the validator accepts as a source port', () => {
    const graph: WorkflowGraph = createWorkflowGraph('research', 'p');
    const approval = graph.nodes.find(node => node.operation === 'approval')!;
    const wrongPort = { ...graph, edges: graph.edges.map(edge => edge.from === approval.id ? { ...edge, outcome: 'next' as const } : edge) };
    expect(validateWorkflowGraph(wrongPort).some(issue => issue.code === 'invalid-port' && issue.nodeId === approval.id)).toBe(true);
    expect(validateWorkflowGraph(graph).some(issue => issue.code === 'invalid-port')).toBe(false);
  });
});

describe('stage reasoning effort', () => {
  it('is optional, kept only when chosen, and at most 32 characters', () => {
    const node = createWorkflowGraph('research', 'sub').nodes[0]!;
    expect(WorkflowNodeSchema.parse(node)).not.toHaveProperty('reasoningEffort');
    expect(WorkflowNodeSchema.parse({ ...node, reasoningEffort: 'x'.repeat(32) }).reasoningEffort).toHaveLength(32);
    expect(WorkflowNodeSchema.safeParse({ ...node, reasoningEffort: 'x'.repeat(33) }).success).toBe(false);
    expect(WorkflowNodeSchema.safeParse({ ...node, reasoningEffort: '' }).success).toBe(false);
  });
});
