import { describe, expect, it } from 'vitest';
import type { ExecutionRun, PreparedExecutionTask } from '../shared/planning-execution';
import { createWorkflowGraph, type WorkflowNode } from '../shared/workflow-graph';
import type { WorkflowSubproject } from '../shared/workflow';
import { decideStageBinding } from './workflow-stage-binding';

const graph = createWorkflowGraph('parallel', 'sub');
const configure = (node: WorkflowNode, paths: string[]): WorkflowNode => node.operation !== 'agent' ? node
  : { ...node, providerId: 'codex', model: 'model', instructions: `Do ${node.title}`, acceptance: ['Done'], permissionPreset: node.role === 'implementation' ? 'standard' : 'plan', allowedPaths: node.role === 'implementation' ? paths : [] };
const paths: Record<string, string[]> = { 'sub:ui': ['src/ui'], 'sub:api': ['src/api'] };
const frozenGraph = { ...graph, nodes: graph.nodes.map((node) => configure(node, paths[node.id] ?? [])) };
const task = (node: WorkflowNode): PreparedExecutionTask => ({ taskId: node.id, taskRevision: 1, stage: node.role, title: node.title, brief: 'Prepared brief',
  dependsOn: node.id === 'sub:plan' ? [] : ['sub:plan'], retryLimit: 2, allowedPaths: node.allowedPaths, executionEnvironment: { mode: 'namespaced', portCount: 1 },
  acceptance: [{ acceptanceId: `${node.id}:accept:1`, description: 'Done' }],
  validations: [{ validationId: `${node.id}:accept:1:validation`, acceptanceIds: [`${node.id}:accept:1`], method: 'inspection', environment: 'Review' }],
  profile: { profileId: `${node.id}:profile`, revision: 1, role: node.role, providerId: 'codex', model: 'model', prompt: `Do ${node.title}`, permissionPreset: node.permissionPreset, capabilities: [] } });
const run = { runId: 'run', projectId: 'project', revision: 3, state: 'running', startedAt: '2026-10-25T00:00:00.000Z', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
  preparationFingerprint: 'f'.repeat(64), attempts: [], evidence: [], reviews: [], gates: [],
  tasks: frozenGraph.nodes.filter((node) => node.operation === 'agent').map((node) => ({ taskId: node.id, state: node.id === 'sub:ui' ? 'ready' : 'waiting', retriesUsed: 0 })),
  preparation: { baseline: { baselineId: 'baseline', revision: 1, fingerprint: 'a'.repeat(64) }, baseCommit: 'a'.repeat(40), artifacts: [], teamMode: 'division', progressPolicy: 'autonomous',
    reviewer: { profileId: 'sub:reviewer', revision: 1, role: 'review', providerId: 'codex', model: 'model', prompt: 'Review', permissionPreset: 'plan', capabilities: [] },
    tasks: frozenGraph.nodes.filter((node) => node.operation === 'agent').map(task),
    workflow: { subprojectId: 'sub', revision: 1, fingerprint: 'c'.repeat(64), graph: frozenGraph } },
} as unknown as ExecutionRun;
const subproject = (edit: (node: WorkflowNode) => WorkflowNode): WorkflowSubproject => ({ id: 'sub', title: 'Parallel', goal: '', status: 'active', revision: 4,
  createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', presetId: 'parallel', history: [], archivedNodes: [],
  graph: { ...frozenGraph, nodes: frozenGraph.nodes.map((node) => node.id === 'sub:ui' ? edit(node) : node) } });
const dependencies = {
  daemon: { providers: [{ id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready', revision: 1, createdAt: '', updatedAt: '' }] } as never,
  listModels: async () => [{ id: 'model', displayName: 'Model', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }],
  now: () => new Date('2026-10-25T00:00:05.000Z'),
};

describe('decideStageBinding', () => {
  it('rebuilds a writing stage with its edited settings and keeps its prepared dependencies', async () => {
    const decision = await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, instructions: 'Do the new UI', reasoningEffort: 'high' })) }, dependencies);
    expect(decision, JSON.stringify(decision).slice(0, 600)).toMatchObject({ kind: 'record', binding: { outcome: 'applied', sourceRevision: 4, changed: ['instructions', 'reasoningEffort'] } });
    if (decision.kind !== 'record' || decision.binding.outcome !== 'applied') throw new Error('unexpected');
    expect(decision.binding.task).toMatchObject({ taskId: 'sub:ui', dependsOn: ['sub:plan'], allowedPaths: ['src/ui'], profile: { reasoningEffort: 'high', permissionPreset: 'standard' } });
    expect(decision.binding.task!.profile.prompt).toContain('Do the new UI');
  });

  it('refuses writable paths that overlap a stage that may run at the same time', async () => {
    const decision = await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, allowedPaths: ['src'] })) }, dependencies);
    expect(decision).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/overlap/u) } });
  });

  it('records an unchanged stage as kept and holds the stage when the model list cannot be read', async () => {
    // Recorded either way: once a stage is sent its settings are settled for this run.
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, position: { x: 1, y: 2 } })) }, dependencies)).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'unchanged' } });
    const offline = { ...dependencies, listModels: async () => { throw new Error('Codex is offline'); } };
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, instructions: 'Edited' })) }, offline)).toEqual({ kind: 'retry', reason: 'Codex is offline' });
  });

  it('keeps the prepared stage when it was removed or the file is unreadable', async () => {
    const removed = { ...subproject((node) => node), graph: { ...frozenGraph, nodes: frozenGraph.nodes.filter((node) => node.id !== 'sub:ui') } };
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: removed }, dependencies)).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'missing' } });
    expect(await decideStageBinding(run, 'sub:ui', { ok: false, reason: 'unreadable' }, dependencies)).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'unreadable' } });
  });
});

describe('decideStageBinding review fixes', () => {
  it('reads every writable scope the way result capture does: "." and "/**" overlap a sibling', async () => {
    for (const scope of ['.', 'src/**', 'SRC/API/', 'src\\api']) {
      const decision = await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, allowedPaths: [scope] })) }, dependencies);
      expect(decision, scope).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/overlap/u) } });
    }
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, allowedPaths: ['src/ui-next'] })) }, dependencies))
      .toMatchObject({ kind: 'record', binding: { outcome: 'applied' } });
  });

  it('refuses an edit whose own text is already too long for one turn, before binding it', async () => {
    // Each part fits its own limit, but the turn it sends does not.
    const decision = await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, instructions: 'x'.repeat(33_000), document: 'y'.repeat(32_000) })) }, dependencies);
    expect(decision).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/too long for one turn/u) } });
    // A single part over its task limit is refused the same way, before the ledger would.
    const oversized = await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, document: 'y'.repeat(70_000) })) }, dependencies);
    expect(oversized).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/task limit/u) } });
    // The previous attempt evidence the sender quotes counts toward the same turn.
    const edit = { ok: true as const, subproject: subproject((node) => ({ ...node, instructions: 'x'.repeat(40_000) })) };
    expect(await decideStageBinding(run, 'sub:ui', edit, dependencies)).toMatchObject({ kind: 'record', binding: { outcome: 'applied' } });
    expect(await decideStageBinding(run, 'sub:ui', edit, { ...dependencies, handoff: () => 'h'.repeat(50_000) }))
      .toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/too long for one turn/u) } });
  });

  it('treats a changed connection around the stage as structure (next run), but not a moved stage', async () => {
    const rerouted = { ...subproject((node) => ({ ...node, instructions: 'Edited too' })) };
    const graph = { ...rerouted.graph, edges: rerouted.graph.edges.map((edge) => edge.to === 'sub:ui' ? { ...edge, id: `${edge.id}-new` } : edge) };
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: { ...rerouted, graph } }, dependencies))
      .toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'structure-changed' } });
    expect(await decideStageBinding(run, 'sub:ui', { ok: true, subproject: subproject((node) => ({ ...node, position: { x: 4, y: 4 }, instructions: 'Edited' })) }, dependencies))
      .toMatchObject({ kind: 'record', binding: { outcome: 'applied', changed: ['instructions'] } });
  });

  it('rebuilds a stage whose input document was rebound upstream, so it reads what that stage used', async () => {
    const reader = { ...frozenGraph.nodes.find((node) => node.id === 'sub:api')!, inputs: [{ nodeId: 'sub:plan', kind: 'document' as const }] };
    const plan = frozenGraph.nodes.find((node) => node.id === 'sub:plan')!;
    const boundPlan = { ...plan, document: 'The new plan document' };
    const readerGraph = { ...frozenGraph, nodes: frozenGraph.nodes.map((node) => node.id === 'sub:api' ? reader : node.id === 'sub:plan' ? boundPlan : node) };
    const withUpstream = { ...run, tasks: run.tasks.map((task) => task.taskId === 'sub:api' ? { ...task, state: 'ready' } : task),
      stageBindings: { 'sub:plan': { outcome: 'applied', boundAt: '2026-10-25T00:00:01.000Z', changed: ['document'], node: boundPlan, task: run.preparation.tasks[0] } },
      preparation: { ...run.preparation, workflow: { ...run.preparation.workflow!, graph: readerGraph } } } as unknown as ExecutionRun;
    const committed = { ...subproject((node) => node), graph: { ...readerGraph } };
    const decision = await decideStageBinding(withUpstream, 'sub:api', { ok: true, subproject: committed }, dependencies);
    expect(decision).toMatchObject({ kind: 'record', binding: { outcome: 'applied', changed: [], inputsChanged: true } });
    if (decision.kind !== 'record' || decision.binding.outcome !== 'applied') throw new Error('unexpected');
    expect(decision.binding.task!.profile.prompt).toContain('The new plan document');

    // Its own edit is refused (an effort the model does not offer): its own settings stay, its inputs still refresh.
    const refusedOwn = { ...committed, graph: { ...readerGraph, nodes: readerGraph.nodes.map((node) => node.id === 'sub:api' ? { ...node, reasoningEffort: 'max' } : node) } };
    const fallback = await decideStageBinding(withUpstream, 'sub:api', { ok: true, subproject: refusedOwn }, dependencies);
    expect(fallback).toMatchObject({ kind: 'record', binding: { outcome: 'applied', changed: [], inputsChanged: true, detail: expect.stringMatching(/Own settings kept \(invalid\)/u) } });
    if (fallback.kind !== 'record' || fallback.binding.outcome !== 'applied') throw new Error('unexpected');
    expect(fallback.binding.task!.profile.reasoningEffort).toBeUndefined();
    expect(fallback.binding.task!.profile.prompt).toContain('The new plan document');
    // The flow file cannot be read: inputs still refresh.
    expect(await decideStageBinding(withUpstream, 'sub:api', { ok: false, reason: 'unreadable' }, dependencies))
      .toMatchObject({ kind: 'record', binding: { outcome: 'applied', inputsChanged: true } });

    // The new document no longer fits the stage: it is held, never sent with the document upstream no longer uses.
    const hugePlan = { ...plan, document: 'd'.repeat(70_000) };
    const hugeGraph = { ...readerGraph, nodes: readerGraph.nodes.map((node) => node.id === 'sub:plan' ? hugePlan : node) };
    const withHuge = { ...withUpstream, stageBindings: { 'sub:plan': { ...withUpstream.stageBindings!['sub:plan']!, node: hugePlan } },
      preparation: { ...withUpstream.preparation, workflow: { ...withUpstream.preparation.workflow!, graph: hugeGraph } } } as unknown as ExecutionRun;
    for (const source of [{ ok: true as const, subproject: { ...committed, graph: hugeGraph } }, { ok: true as const, subproject: { ...refusedOwn, graph: { ...hugeGraph, nodes: hugeGraph.nodes.map((node) => node.id === 'sub:api' ? { ...node, reasoningEffort: 'max' } : node) } } }]) {
      expect(await decideStageBinding(withHuge, 'sub:api', source, dependencies)).toMatchObject({ kind: 'hold', reason: expect.stringMatching(/input documents changed upstream/u) });
    }
  });

  it('counts the exact accepted outputs the sender quotes toward the turn', async () => {
    const withOutputs = { ...run,
      attempts: [{ attemptId: 'plan-attempt', taskId: 'sub:plan', sessionId: 'plan-session', turnId: 'plan-turn', state: 'succeeded', artifacts: [], startedAt: '2026-10-25T00:00:00.000Z' }],
      reviews: [{ attemptId: 'plan-attempt', decision: 'approve' }],
      workflowRuntime: { completed: false, edgeCounts: {}, activations: [{ id: 'wf:sub:ui:0', nodeId: 'sub:ui', iteration: 0, state: 'active', incomingEdgeIds: [], inputResults: { 'sub:plan': { attemptId: 'plan-attempt', outcome: 'passed' } } }] },
    } as unknown as ExecutionRun;
    const edit = { ok: true as const, subproject: subproject((node) => ({ ...node, instructions: 'x'.repeat(40_000) })) };
    const quoted = { ...dependencies, outputContext: async () => 'o'.repeat(50_000) };
    expect(await decideStageBinding(withOutputs, 'sub:ui', edit, { ...dependencies, outputContext: async () => 'o'.repeat(5_000) })).toMatchObject({ kind: 'record', binding: { outcome: 'applied' } });
    expect(await decideStageBinding(withOutputs, 'sub:ui', edit, quoted))
      .toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/too long for one turn/u) } });
    // Outputs that cannot be read now: nothing is recorded (the stage stays editable) and it is checked again.
    expect(await decideStageBinding(withOutputs, 'sub:ui', edit, { ...dependencies, outputContext: async () => { throw new Error('result store busy'); } }))
      .toEqual({ kind: 'retry', reason: expect.stringMatching(/accepted input results could not be read \(result store busy\)/u) });
  });
});
