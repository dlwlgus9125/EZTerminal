import { describe, expect, it } from 'vitest';
import type { ExecutionRun, ExecutionTask } from '../../shared/planning-execution';
import { createWorkflowGraph, type WorkflowActivation, type WorkflowGraph } from '../../shared/workflow-graph';
import { canConnectWorkflow, connectWorkflowEdge, layoutWorkflowGraph, projectRunOverlay, workflowEdgeBadge, workflowEdgePath } from './workflow-canvas-model';

const graph: WorkflowGraph = createWorkflowGraph('feature', 'f');
const id = (key: string) => `f:${key}`;
const text = (ko: string) => ko;

function run(state: ExecutionRun['state'], activations: WorkflowActivation[], tasks: ExecutionTask[] = [], edgeCounts: Record<string, number> = {}): ExecutionRun {
  return {
    runId: 'run-1', projectId: 'p', revision: 3, state, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', startedAt: '2026-10-22T00:00:01.000Z',
    preparation: { workflow: { subprojectId: 'login', revision: 4, fingerprint: 'a'.repeat(64), graph }, baseline: { baselineId: 'b', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: [] as never },
    preparationFingerprint: 'c'.repeat(64), tasks, attempts: [], evidence: [], reviews: [], gates: [],
    workflowRuntime: { activations, edgeCounts, completed: state === 'completed' },
  };
}
const activation = (key: string, state: WorkflowActivation['state'], extra: Partial<WorkflowActivation> = {}): WorkflowActivation => ({ id: `wf:${id(key)}:${extra.iteration ?? 0}`, nodeId: id(key), iteration: 0, state, incomingEdgeIds: [], inputResults: {}, ...extra });
const task = (key: string, state: ExecutionTask['state']): ExecutionTask => ({ taskId: id(key), state, retriesUsed: 0 });

describe('projectRunOverlay', () => {
  it('returns nothing for a run without a frozen flow', () => {
    const plain = run('running', []);
    expect(projectRunOverlay({ ...plain, preparation: { ...plain.preparation, workflow: undefined } })).toBeNull();
  });

  it('separates stages the run has not reached yet from those it never reached', () => {
    expect(projectRunOverlay(run('running', [activation('plan', 'active')], [task('plan', 'running')]))!.nodes[id('done')].status).toBe('pending');
    expect(projectRunOverlay(run('completed', [activation('plan', 'completed', { outcome: 'passed' })]))!.nodes[id('done')].status).toBe('not-reached');
  });

  it('refines an active AI stage by its task state', () => {
    const states: Array<[ExecutionTask['state'], string]> = [['ready', 'queued'], ['running', 'working'], ['awaiting-review', 'reviewing'], ['reconciling', 'reconciling'], ['failed', 'needs-attention'], ['paused', 'paused']];
    for (const [taskState, status] of states) {
      expect(projectRunOverlay(run('running', [activation('implement', 'active')], [task('implement', taskState)]))!.nodes[id('implement')].status).toBe(status);
    }
  });

  it('keeps a routed failure as completed with its outcome', () => {
    const view = projectRunOverlay(run('running', [activation('review', 'completed', { outcome: 'failed' })], [task('review', 'failed')]))!.nodes[id('review')];
    expect(view).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  it('shows unfinished stages of a cancelled run as cancelled', () => {
    const overlay = projectRunOverlay(run('cancelled', [activation('plan', 'completed', { outcome: 'passed' }), activation('design', 'active')], [task('design', 'running')]))!;
    expect(overlay.nodes[id('plan')].status).toBe('completed');
    expect(overlay.nodes[id('design')].status).toBe('cancelled');
    expect(overlay.ended).toBe(true);
  });

  it('uses the latest iteration and counts the rounds', () => {
    const overlay = projectRunOverlay(run('running', [
      activation('implement', 'completed', { outcome: 'passed' }),
      activation('implement', 'active', { id: 'wf:f:implement:1', iteration: 1 }),
    ], [task('implement', 'running')], { [id('retry')]: 1 }))!;
    expect(overlay.nodes[id('implement')]).toMatchObject({ status: 'working', iteration: 1, activationId: 'wf:f:implement:1' });
    expect(overlay.edges[id('retry')]).toEqual({ taken: 1, retryLimit: 2 });
  });

  it('lists approval stages waiting for the person', () => {
    const overlay = projectRunOverlay(run('awaiting-review', [activation('approval', 'awaiting-approval')]))!;
    expect(overlay.nodes[id('approval')].status).toBe('awaiting-approval');
    expect(overlay.awaitingApproval).toEqual([{ nodeId: id('approval'), activationId: 'wf:f:approval:0' }]);
  });

  it('counts the inputs a join has received', () => {
    const parallel = createWorkflowGraph('parallel', 'f');
    const join = parallel.nodes.find(node => node.operation === 'join')!;
    const incoming = parallel.edges.filter(edge => edge.to === join.id);
    const value = run('running', [{ id: `wf:${join.id}:0`, nodeId: join.id, iteration: 0, state: 'waiting', incomingEdgeIds: [incoming[0].id], inputResults: {} }]);
    const overlay = projectRunOverlay({ ...value, preparation: { ...value.preparation, workflow: { ...value.preparation.workflow!, graph: parallel } } })!;
    expect(overlay.nodes[join.id]).toMatchObject({ status: 'waiting', arrivals: { arrived: 1, expected: 2 } });
  });
});

describe('workflowEdgeBadge', () => {
  const retry = graph.edges.find(edge => edge.retryLimit)!;
  const forward = graph.edges.find(edge => !edge.retryLimit)!;
  it('names the retry limit while editing and the rounds used while running', () => {
    expect(workflowEdgeBadge(retry, undefined, text)).toBe('재시도 최대 2회');
    expect(workflowEdgeBadge(retry, { taken: 1, retryLimit: 2 }, text)).toBe('재시도 1/2');
  });
  it('labels an ordinary connection only when it ran more than once', () => {
    expect(workflowEdgeBadge(forward, undefined, text)).toBeNull();
    expect(workflowEdgeBadge(forward, { taken: 1 }, text)).toBeNull();
    expect(workflowEdgeBadge(forward, { taken: 2 }, text)).toBe('×2');
  });
});

describe('workflowEdgePath', () => {
  it('curves forward between the ports and keeps the label on the path', () => {
    const path = workflowEdgePath({ x: 0, y: 50 }, { x: 300, y: 80 });
    expect(path.backward).toBe(false);
    expect(path.d.startsWith('M 0 50')).toBe(true);
    expect(path.labelX).toBeGreaterThan(0);
    expect(path.labelX).toBeLessThan(300);
  });
  it('routes a connection that goes back underneath both stages', () => {
    const path = workflowEdgePath({ x: 900, y: 60 }, { x: 300, y: 50 });
    expect(path.backward).toBe(true);
    expect(path.labelY).toBeGreaterThan(60 + 60);
  });
});

describe('layoutWorkflowGraph', () => {
  const size = { width: 260, height: 140 };
  it('places each stage one column after its furthest predecessor, ignoring retries', () => {
    const parallel = createWorkflowGraph('parallel', 'p');
    const laid = layoutWorkflowGraph(parallel, size);
    const at = (key: string) => laid.nodes.find(node => node.id === `p:${key}`)!.position;
    expect(at('plan').x).toBeLessThan(at('fork').x);
    expect(at('ui').x).toBe(at('api').x);
    expect(at('ui').y).not.toBe(at('api').y);
    expect(at('join').x).toBeGreaterThan(at('ui').x);
    expect(at('done').x).toBeGreaterThan(at('approval').x);
  });
  it('keeps columns apart by the measured stage size and changes nothing else', () => {
    const laid = layoutWorkflowGraph(graph, size);
    const xs = [...new Set(laid.nodes.map(node => node.position.x))].sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(size.width + 80);
    expect(laid.edges).toBe(graph.edges);
    const withoutPosition = (nodes: WorkflowGraph['nodes']) => nodes.map(node => ({ ...node, position: null }));
    expect(withoutPosition(laid.nodes)).toEqual(withoutPosition(graph.nodes));
  });
  it('puts stages the start cannot reach in a column of their own', () => {
    const orphan = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: 'f:orphan', title: 'Orphan' }] };
    const laid = layoutWorkflowGraph(orphan, size);
    const maxX = Math.max(...laid.nodes.filter(node => node.id !== 'f:orphan').map(node => node.position.x));
    expect(laid.nodes.find(node => node.id === 'f:orphan')!.position.x).toBeGreaterThan(maxX);
  });
});

describe('connecting stages', () => {
  it('refuses connections a stage cannot make', () => {
    expect(canConnectWorkflow(graph, id('done'), 'next', id('plan'))).toBe(false);
    expect(canConnectWorkflow(graph, id('plan'), 'next', id('design'))).toBe(false);
    expect(canConnectWorkflow(graph, id('plan'), 'approved', id('design'))).toBe(false);
    expect(canConnectWorkflow(graph, id('plan'), 'next', id('plan'))).toBe(false);
  });
  it('allows a stage to retry itself after an explicit failure', () => {
    expect(canConnectWorkflow(graph, id('implement'), 'failed', id('implement'))).toBe(true);
    const next = connectWorkflowEdge(graph, id('implement'), 'failed', id('implement'), 'edge-self');
    expect(next.edges.at(-1)).toEqual({ id: 'edge-self', from: id('implement'), to: id('implement'), outcome: 'failed', retryLimit: 2 });
  });
  it('bounds a failure that loops back and leaves forward connections unbounded', () => {
    const back = connectWorkflowEdge(graph, id('review'), 'failed', id('design'), 'edge-back');
    expect(back.edges.at(-1)?.retryLimit).toBe(2);
    const forward = connectWorkflowEdge({ ...graph, edges: [] }, id('plan'), 'next', id('design'), 'edge-forward');
    expect(forward.edges).toEqual([{ id: 'edge-forward', from: id('plan'), to: id('design'), outcome: 'next' }]);
  });
});
