import { describe, expect, it } from 'vitest';
import type { ExecutionRun, ExecutionTask } from '../../shared/planning-execution';
import { createWorkflowGraph, type WorkflowActivation, type WorkflowGraph } from '../../shared/workflow-graph';
import { canConnectWorkflow, connectWorkflowEdge, reconnectWorkflowEdge, workflowLayoutOnlyChange, defaultWorkflowRun, workflowLayoutOverlaps, workflowRunControls, layoutWorkflowGraph, pageFromSection, projectRunOverlay, resolveCanvasView, sameWorkflowGraph, sectionFromPage, workflowBackwardDepths, workflowEdgeBadge, workflowEdgePath } from './workflow-canvas-model';

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

describe('one canvas: which graph and which run', () => {
  const saved = graph;
  const base = run('running', [activation('plan', 'active')], [task('plan', 'running')]);
  const at = (value: ExecutionRun, runId: string, state: ExecutionRun['state'], createdAt: string, frozen = saved): ExecutionRun => ({ ...value, runId, state, createdAt, preparation: { ...value.preparation, workflow: { ...value.preparation.workflow!, graph: frozen } } });

  it('compares graph content, not revision numbers or key order', () => {
    const reordered = JSON.parse(JSON.stringify({ edges: saved.edges, nodes: saved.nodes, entryNodeId: saved.entryNodeId })) as WorkflowGraph;
    expect(sameWorkflowGraph(saved, reordered)).toBe(true);
    expect(sameWorkflowGraph(saved, { ...saved, nodes: saved.nodes.map((node, index) => index === 0 ? { ...node, position: { x: node.position.x + 1, y: node.position.y } } : node) })).toBe(false);
  });

  it('defaults to the newest unfinished run, else the newest run', () => {
    const old = at(base, 'old', 'running', '2026-10-20T00:00:00.000Z');
    const done = at(base, 'done', 'completed', '2026-10-22T00:00:00.000Z');
    expect(defaultWorkflowRun([done, old])?.runId).toBe('old');
    expect(defaultWorkflowRun([at(base, 'a', 'completed', '2026-10-20T00:00:00.000Z'), done])?.runId).toBe('done');
    expect(defaultWorkflowRun([])).toBeNull();
  });

  it('shows the run on the editable canvas while the saved flow is the one it froze', () => {
    const view = resolveCanvasView({ savedGraph: saved, draftGraph: null, runs: [base], pickedRunId: null, runView: false });
    expect(view).toMatchObject({ mode: 'edit-with-run', editable: true, diverged: false });
    expect(view.run?.runId).toBe('run-1');
    expect(view.overlay?.nodes[id('plan')].status).toBe('working');
  });

  it('hides the overlay once the draft differs and offers the run view', () => {
    const draft = { ...saved, nodes: saved.nodes.slice(0, -1) };
    const view = resolveCanvasView({ savedGraph: saved, draftGraph: draft, runs: [base], pickedRunId: null, runView: false });
    expect(view).toMatchObject({ mode: 'edit', overlay: null, diverged: true, graph: draft });
  });

  it('shows the frozen graph read-only in the run view', () => {
    const frozen = { ...saved, nodes: saved.nodes.slice(1) };
    const view = resolveCanvasView({ savedGraph: saved, draftGraph: null, runs: [at(base, 'r', 'running', base.createdAt, frozen)], pickedRunId: 'r', runView: true });
    expect(view).toMatchObject({ mode: 'run-view', editable: false, graph: frozen });
  });

  it('edits without a run when there is none', () => {
    expect(resolveCanvasView({ savedGraph: saved, draftGraph: null, runs: [], pickedRunId: null, runView: true })).toMatchObject({ mode: 'edit', run: null, overlay: null, diverged: false, editable: true });
  });
});

describe('workflowBackwardDepths', () => {
  it('stacks overlapping returns at different depths and leaves forward edges alone', () => {
    const laid = layoutWorkflowGraph(graph, { width: 248, height: 136 });
    const looped = connectWorkflowEdge(connectWorkflowEdge(laid, id('implement'), 'failed', id('implement'), 'self'), id('approval'), 'rejected', id('design'), 'long');
    const depths = workflowBackwardDepths(looped);
    expect(depths.self).toBe(0);
    expect(depths[id('retry')]).toBeGreaterThanOrEqual(0);
    expect(depths.long).toBeGreaterThan(depths[id('retry')]);
    expect(depths[graph.edges[0].id]).toBeUndefined();
  });
  it('drops deeper paths lower', () => {
    expect(workflowEdgePath({ x: 900, y: 60 }, { x: 300, y: 50 }, 1).labelY).toBeGreaterThan(workflowEdgePath({ x: 900, y: 60 }, { x: 300, y: 50 }, 0).labelY);
  });
});

describe('panel section and the saved page', () => {
  it('maps the stored page values both ways without new values', () => {
    expect(sectionFromPage('flow')).toBe('settings');
    expect(sectionFromPage('stage')).toBe('stage');
    expect(sectionFromPage('run')).toBe('run');
    expect(pageFromSection('settings')).toBe('flow');
    expect(pageFromSection('stage')).toBe('stage');
    expect(pageFromSection('run')).toBe('run');
  });
});

describe('workflowLayoutOverlaps', () => {
  const size = { width: 248, height: 136 };
  it('flags stages stored closer than one card, as older drafts were', () => {
    const legacy = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, position: { x: 80 + index * 240, y: 80 } })) };
    expect(workflowLayoutOverlaps(legacy, size)).toBe(true);
  });
  it('accepts the tidy layout', () => {
    expect(workflowLayoutOverlaps(layoutWorkflowGraph(graph, size), size)).toBe(false);
  });
});

describe('workflowRunControls', () => {
  const at = (state: ExecutionRun['state'], extra: Partial<ExecutionRun> = {}) => workflowRunControls({ ...run(state, []), ...extra });
  it('offers resume only for a run the person paused', () => {
    expect(at('paused', { dispatchPaused: true })).toMatchObject({ canResume: true, blocked: false });
    expect(at('paused')).toMatchObject({ canResume: false, blocked: true, canPause: false });
  });
  it('closes every action while a cancellation is pending', () => {
    expect(at('running', { cancelRequested: true })).toMatchObject({ cancelling: true, canPause: false, canCancel: false, approvalsOpen: false });
  });
  it('keeps approvals open while the run waits for review, and closes them once it ends', () => {
    expect(at('awaiting-review')).toMatchObject({ approvalsOpen: true, canPause: true });
    expect(at('completed')).toMatchObject({ approvalsOpen: false, canIntegrate: true, canCancel: false });
    expect(at('completed', { integrationAuthorized: { by: 'desktop', at: 'x' } }).canIntegrate).toBe(false);
    expect(at('prepared')).toMatchObject({ canStart: true, canPause: false });
  });
});

describe('scale and port geometry', () => {
  it('grows the return clearance with the UI scale', () => {
    const at100 = workflowEdgePath({ x: 900, y: 60 }, { x: 300, y: 50 }, 1, 1);
    const at150 = workflowEdgePath({ x: 900, y: 60 }, { x: 300, y: 50 }, 1, 1.5);
    expect(at150.labelY - 60).toBeCloseTo((at100.labelY - 60) * 1.5);
  });
  it('treats stages closer than one card as a return, as the ports route them', () => {
    const tight = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, position: { x: 80 + index * 240, y: 80 } })) };
    expect(Object.keys(workflowBackwardDepths(tight, 248))).toContain(tight.edges[0].id);
    expect(Object.keys(workflowBackwardDepths(layoutWorkflowGraph(graph, { width: 248, height: 136 }), 248))).not.toContain(graph.edges[0].id);
  });
});

describe('reconnectWorkflowEdge', () => {
  const laid = layoutWorkflowGraph(graph, { width: 248, height: 136 });
  it('keeps a retry limit the person set when the connection still loops back', () => {
    const custom = { ...laid, edges: laid.edges.map(edge => edge.id === id('retry') ? { ...edge, retryLimit: 7 } : edge) };
    const moved = reconnectWorkflowEdge(custom, id('retry'), id('condition'), 'failed', id('design'))!;
    expect(moved.edges.find(edge => edge.id === id('retry'))).toMatchObject({ to: id('design'), retryLimit: 7 });
  });
  it('drops the limit when the connection no longer loops, and refuses impossible moves', () => {
    const forward = reconnectWorkflowEdge(laid, id('retry'), id('condition'), 'failed', id('done'))!;
    expect(forward.edges.find(edge => edge.id === id('retry'))?.retryLimit).toBeUndefined();
    expect(reconnectWorkflowEdge(laid, id('retry'), id('done'), 'next', id('plan'))).toBeNull();
  });
});

describe('workflowLayoutOnlyChange', () => {
  it('is true only when stage positions are all that changed', () => {
    const moved = { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 999, y: 1 } } : node) };
    expect(workflowLayoutOnlyChange(graph, moved)).toBe(true);
    expect(workflowLayoutOnlyChange(graph, graph)).toBe(false);
    expect(workflowLayoutOnlyChange(graph, { ...moved, nodes: moved.nodes.map((node, index) => index === 1 ? { ...node, title: 'x' } : node) })).toBe(false);
  });
  it('survives a JSON round trip of the frozen graph (same content, any key order)', () => {
    expect(sameWorkflowGraph(graph, JSON.parse(JSON.stringify(structuredClone(graph))) as WorkflowGraph)).toBe(true);
  });
});
