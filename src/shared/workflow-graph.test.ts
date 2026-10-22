import { describe, expect, it } from 'vitest';
import { createWorkflowGraph, validateWorkflowGraph, workflowOutcomePorts, type WorkflowGraph } from './workflow-graph';

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
