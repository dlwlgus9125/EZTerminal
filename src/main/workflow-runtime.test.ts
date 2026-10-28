import { describe, expect, it } from 'vitest';
import { advanceWorkflowRun, workflowTaskInputs } from './workflow-runtime';
import { createWorkflowGraph, validateWorkflowGraph, WorkflowNodeSchema, type WorkflowGraph } from '../shared/workflow';
import type { ExecutionRun, PreparedExecutionTask } from '../shared/planning-execution';

function runnable(graph: WorkflowGraph): WorkflowGraph { return { ...graph, nodes: graph.nodes.map(node => node.operation === 'agent' ? { ...node, providerId: 'claude', model: 'model', instructions: 'Perform the stage', acceptance: ['Verified evidence'] } : node) }; }
function run(graph: WorkflowGraph): ExecutionRun {
  const tasks: PreparedExecutionTask[] = graph.nodes.filter(node => node.operation === 'agent').map(node => ({ taskId: node.id, taskRevision: 0, title: node.title, stage: node.role, brief: node.instructions, dependsOn: [], retryLimit: 2,
    profile: { profileId: node.id, revision: 0, role: node.role, providerId: 'claude', model: 'model', prompt: 'Task', permissionPreset: 'plan', capabilities: [] },
    acceptance: [{ acceptanceId: 'a', description: 'Evidence' }], validations: [{ validationId: 'v', acceptanceIds: ['a'], method: 'inspection', environment: 'review' }] }));
  return { runId: 'run', projectId: 'project', revision: 1, state: 'running', createdAt: 'now', updatedAt: 'now', startedAt: 'now',
    preparation: { baseline: { baselineId: 'b', revision: 0, fingerprint: 'a'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks,
      workflow: { subprojectId: 'sub', revision: 0, fingerprint: 'b'.repeat(64), graph } }, preparationFingerprint: 'c'.repeat(64),
    tasks: tasks.map(task => ({ taskId: task.taskId, state: 'waiting', retriesUsed: 0 })), attempts: [], evidence: [], reviews: [], gates: [] };
}
function finish(input: ExecutionRun, taskId: string, accepted = true): ExecutionRun {
  const attemptId = `${taskId}:${input.attempts.length + 1}`;
  return advanceWorkflowRun({ ...input, tasks: input.tasks.map(task => task.taskId === taskId ? { ...task, currentAttemptId: attemptId, state: accepted ? 'completed' : 'failed' } : task),
    attempts: [...input.attempts, { attemptId, taskId, taskRevision: 0, dispatchId: attemptId, workspaceId: attemptId, number: 1, reason: 'initial', sessionId: attemptId, turnId: attemptId,
      state: 'succeeded', startedAt: 'now', artifacts: [{ artifactId: attemptId, revision: 1 }], requestedSettings: { providerId: 'claude', permissionPreset: 'plan' }, effectiveSettings: { providerId: 'claude', permissionPreset: 'plan' } }],
    reviews: [...input.reviews, { reviewId: attemptId, attemptId, reviewerSessionId: `review-${attemptId}`, reviewerTurnId: `review-${attemptId}`, decidedBy: 'reviewer', baseline: input.preparation.baseline,
      artifacts: [{ artifactId: attemptId, revision: 1 }], evidenceIds: ['proof'], decision: accepted ? 'approve' : 'reject', detail: 'Verified', decidedAt: 'now' }] });
}
function conditional(): WorkflowGraph {
  return runnable({ entryNodeId: 'work', nodes: [WorkflowNodeSchema.parse({ id: 'work', title: 'Work', operation: 'agent' }),
    WorkflowNodeSchema.parse({ id: 'condition', title: 'Check result', operation: 'condition', condition: { sourceNodeId: 'work', field: 'outcome', equals: 'passed' } }),
    WorkflowNodeSchema.parse({ id: 'done', title: 'Done', operation: 'complete' })], edges: [
      { id: 'next', from: 'work', to: 'condition', outcome: 'next' }, { id: 'pass', from: 'condition', to: 'done', outcome: 'passed' }, { id: 'retry', from: 'condition', to: 'work', outcome: 'failed', retryLimit: 2 },
    ] });
}

describe('frozen workflow execution projection', () => {
  it('routes both verified outcomes through next to a condition and bounds retry iterations', () => {
    const graph = conditional(); expect(validateWorkflowGraph(graph, true)).toEqual([]);
    expect(finish(advanceWorkflowRun(run(graph)), 'work').state).toBe('completed');
    let current = advanceWorkflowRun(run(graph));
    current = finish(current, 'work', false); expect(current.tasks[0].state).toBe('ready'); expect(current.workflowRuntime?.activations.find(entry => entry.nodeId === 'work' && entry.iteration === 1)?.state).toBe('active');
    current = finish(current, 'work', false); current = finish(current, 'work', false);
    expect(current.state).toBe('paused'); expect(current.workflowRuntime?.edgeCounts.retry).toBe(2); expect(current.workflowRuntime?.activations.at(-1)?.state).toBe('retry-exhausted');
  });
  it('does not treat an unverified provider failure as a negative condition result', () => {
    const initial = advanceWorkflowRun(run(conditional()));
    const current = advanceWorkflowRun({ ...initial, tasks: initial.tasks.map(task => ({ ...task, state: 'failed', currentAttemptId: 'failed' })), attempts: [{ attemptId: 'failed', taskId: 'work', taskRevision: 0, dispatchId: 'dispatch', workspaceId: 'ws', number: 1, reason: 'initial', sessionId: 's', turnId: 't', state: 'failed', startedAt: 'now', artifacts: [], requestedSettings: { providerId: 'claude', permissionPreset: 'plan' }, effectiveSettings: { providerId: 'claude', permissionPreset: 'plan' } }] });
    expect(current.state).toBe('paused'); expect(current.workflowRuntime?.activations).toHaveLength(1);
  });
  it('waits for all parallel branches and explicit approval; duplicate results do not advance twice', () => {
    const graph = runnable(createWorkflowGraph('parallel', 'p')); expect(validateWorkflowGraph(graph, true)).toEqual([]);
    let current = finish(advanceWorkflowRun(run(graph)), 'p:plan');
    expect(current.tasks.filter(task => task.state === 'ready').map(task => task.taskId)).toEqual(['p:ui', 'p:api']);
    current = finish(current, 'p:ui'); expect(current.workflowRuntime?.activations.find(entry => entry.nodeId === 'p:join')?.state).toBe('waiting');
    current = advanceWorkflowRun(current); expect(current.workflowRuntime?.edgeCounts['p:edge:4']).toBe(1);
    current = finish(current, 'p:api'); expect(current.state).toBe('awaiting-review');
    const pending = current.workflowRuntime!.activations.find(entry => entry.state === 'awaiting-approval')!;
    current = advanceWorkflowRun({ ...current, workflowRuntime: { ...current.workflowRuntime!, activations: current.workflowRuntime!.activations.map(entry => entry.id === pending.id ? { ...entry, state: 'active', outcome: 'approved' } : entry) } });
    expect(current.state).toBe('completed'); expect(current.preparation.workflow?.graph).toEqual(graph);
  });
  it('starts an any-join once with the winning ancestry and does not absorb a later branch result', () => {
    const graph = runnable(createWorkflowGraph('parallel', 'p')); graph.nodes.find(node => node.id === 'p:join')!.joinPolicy = 'any';
    let current = finish(advanceWorkflowRun(run(graph)), 'p:plan'); current = finish(current, 'p:ui');
    const approval = current.workflowRuntime!.activations.find(node => node.nodeId === 'p:approval')!;
    expect(approval.inputResults['p:ui']).toBeDefined(); expect(approval.inputResults['p:api']).toBeUndefined();
    current = finish(current, 'p:api');
    expect(current.workflowRuntime!.activations.filter(node => node.nodeId === 'p:approval')).toHaveLength(1);
    expect(current.workflowRuntime!.activations.find(node => node.nodeId === 'p:approval')!.inputResults).toEqual(approval.inputResults);
  });
  it('preserves the frozen graph while paused and cannot reuse another iteration condition result', () => {
    let current = advanceWorkflowRun(run(conditional())); current = finish(current, 'work', false);
    const paused = advanceWorkflowRun({ ...current, dispatchPaused: true }); expect(paused.state).toBe('paused'); expect(paused.workflowRuntime).toEqual(current.workflowRuntime);
    expect(current.workflowRuntime?.activations.filter(entry => entry.nodeId === 'condition')).toHaveLength(1);
    current = finish({ ...paused, dispatchPaused: false }, 'work', true); expect(current.state).toBe('completed');
  });
  it('binds explicit result inputs to exact accepted attempts, rejecting missing iteration results', () => {
    const graph = runnable(createWorkflowGraph('feature', 'p')); graph.nodes.find(node => node.id === 'p:design')!.inputs = [{ nodeId: 'p:plan', kind: 'result' }];
    const current = finish(advanceWorkflowRun(run(graph)), 'p:plan');
    const task = current.preparation.tasks.find(entry => entry.taskId === 'p:design')!;
    const inputs = workflowTaskInputs(current, task); expect(inputs.task.dependsOn).toEqual(['p:plan']); expect(inputs.context).toContain('p:plan:1');
    const missing = { ...current, workflowRuntime: { ...current.workflowRuntime!, activations: current.workflowRuntime!.activations.map(entry => entry.nodeId === 'p:design' ? { ...entry, inputResults: {} } : entry) } };
    expect(() => workflowTaskInputs(missing, task)).toThrow('no accepted result');
  });
  it('rejects unbounded cycles, missing outcome ports and partial parallel retries', () => {
    const graph = conditional(); graph.edges[2] = { ...graph.edges[2], retryLimit: undefined }; expect(validateWorkflowGraph(graph).some(issue => issue.code === 'unbounded-cycle')).toBe(true);
    graph.edges = graph.edges.slice(0, 2); expect(validateWorkflowGraph(graph).some(issue => issue.code === 'condition-ports')).toBe(true);
    const parallel = runnable(createWorkflowGraph('parallel', 'p'));
    parallel.edges.push({ id: 'retry', from: 'p:approval', to: 'p:ui', outcome: 'rejected', retryLimit: 2 });
    expect(validateWorkflowGraph(parallel).some(issue => issue.code === 'retry-join')).toBe(true);
  });
  it('keeps accepted planning/design inputs outside a repair loop while replacing implementation/review results', () => {
    const graph = runnable(createWorkflowGraph('feature', 'p'));
    graph.nodes.find(node => node.id === 'p:implement')!.inputs = [{ nodeId: 'p:plan', kind: 'result' }, { nodeId: 'p:design', kind: 'result' }];
    graph.nodes.find(node => node.id === 'p:review')!.inputs = [{ nodeId: 'p:implement', kind: 'result' }];
    expect(validateWorkflowGraph(graph, true)).toEqual([]);
    let current = finish(advanceWorkflowRun(run(graph)), 'p:plan'); current = finish(current, 'p:design'); current = finish(current, 'p:implement'); current = finish(current, 'p:review', false);
    const implement = current.preparation.tasks.find(task => task.taskId === 'p:implement')!;
    const retained = workflowTaskInputs(current, implement);
    expect(retained.task.dependsOn).toEqual(['p:plan', 'p:design']); expect(retained.context).toContain('p:plan:1'); expect(retained.context).toContain('p:design:2');
    current = finish(current, 'p:implement');
    const review = workflowTaskInputs(current, current.preparation.tasks.find(task => task.taskId === 'p:review')!);
    expect(review.context).toContain('p:implement:5'); expect(review.context).not.toContain('p:implement:3');
    current = finish(current, 'p:review'); expect(current.state).toBe('awaiting-review');
  });
});

describe('answer stages and approval notes (v18)', () => {
  function asking(): WorkflowGraph {
    return runnable({ entryNodeId: 'ask', nodes: [
      WorkflowNodeSchema.parse({ id: 'ask', title: 'Ask the person', operation: 'answer', answer: { prompt: 'Which login flow?' } }),
      WorkflowNodeSchema.parse({ id: 'work', title: 'Work', operation: 'agent' }),
      WorkflowNodeSchema.parse({ id: 'check', title: 'Check', operation: 'approval' }),
      WorkflowNodeSchema.parse({ id: 'done', title: 'Done', operation: 'complete' }),
    ], edges: [
      { id: 'e1', from: 'ask', to: 'work', outcome: 'next' }, { id: 'e2', from: 'work', to: 'check', outcome: 'next' },
      { id: 'e3', from: 'check', to: 'done', outcome: 'approved' }, { id: 'back', from: 'check', to: 'work', outcome: 'rejected', retryLimit: 2 },
    ] });
  }
  const resolve = (input: ExecutionRun, nodeId: string, patch: Record<string, unknown>): ExecutionRun => advanceWorkflowRun({ ...input, workflowRuntime: { ...input.workflowRuntime!,
    activations: input.workflowRuntime!.activations.map(entry => entry.nodeId === nodeId && (entry.state === 'awaiting-answer' || entry.state === 'awaiting-approval') ? { ...entry, state: 'active', ...patch } : entry) } });

  it('waits for the answer with no model, then hands it to the next stage', () => {
    const graph = asking(); expect(validateWorkflowGraph(graph, true)).toEqual([]);
    let current = advanceWorkflowRun(run(graph));
    expect(current.workflowRuntime!.activations[0]!.state).toBe('awaiting-answer');
    expect(current.state).toBe('awaiting-review');
    expect(current.tasks.every(task => task.state === 'waiting')).toBe(true);
    current = resolve(current, 'ask', { outcome: 'next', answer: 'Email and code' });
    expect(current.tasks.find(task => task.taskId === 'work')!.state).toBe('ready');
    const inputs = workflowTaskInputs(current, current.preparation.tasks.find(task => task.taskId === 'work')!);
    expect(inputs.context).toContain('Answers from the person');
    expect(inputs.context).toContain('Email and code');
  });

  it('gives a stage only the answers on the path that reached it', () => {
    let current = resolve(advanceWorkflowRun(run(asking())), 'ask', { outcome: 'next', answer: 'Email' });
    const work = current.workflowRuntime!.activations.find(entry => entry.nodeId === 'work')!;
    expect(work.inputResults.ask).toMatchObject({ outcome: 'passed' });
    // An activation that did not come through the answer (another branch) does not read it.
    current = { ...current, workflowRuntime: { ...current.workflowRuntime!, activations: current.workflowRuntime!.activations.map(entry => entry.id === work.id ? { ...entry, inputResults: {} } : entry) } };
    expect(workflowTaskInputs(current, current.preparation.tasks.find(task => task.taskId === 'work')!).context).not.toContain('Email');
  });

  it('sends a rejection note back to the stage the rejection returns to', () => {
    let current = resolve(advanceWorkflowRun(run(asking())), 'ask', { outcome: 'next', answer: 'Email' });
    current = finish(current, 'work');
    current = resolve(current, 'check', { outcome: 'rejected', comment: 'Keep the old button.' });
    const inputs = workflowTaskInputs(current, current.preparation.tasks.find(task => task.taskId === 'work')!);
    expect(inputs.context).toContain('sent this work back with a note');
    expect(inputs.context).toContain('Keep the old button.');
    // The answer from before the loop still reaches the retried stage.
    expect(inputs.context).toContain('Email');
  });

  it('routes a stage the host skipped (정기 점검, nothing changed) on as passed, with no attempt', () => {
    const graph = runnable(conditional());
    let current = advanceWorkflowRun(run(graph));
    current = advanceWorkflowRun({ ...current, tasks: current.tasks.map(task => ({ ...task, state: 'cancelled' as const })),
      workflowRuntime: { ...current.workflowRuntime!, activations: current.workflowRuntime!.activations.map(entry => entry.nodeId === 'work' ? { ...entry, skipped: 'Same check results' } : entry) } });
    expect(current.workflowRuntime!.activations.find(entry => entry.nodeId === 'work')).toMatchObject({ state: 'completed', outcome: 'passed' });
    expect(current.workflowRuntime!.activations.find(entry => entry.nodeId === 'work')!.inputResults.work).toBeUndefined();
  });

  it('needs a question and names a missing agent', () => {
    const graph = asking();
    graph.nodes[0] = { ...graph.nodes[0]!, answer: undefined };
    expect(validateWorkflowGraph(graph, true).map(issue => issue.code)).toContain('answer-prompt');
    graph.nodes[1] = { ...graph.nodes[1]!, agent: { profileId: 'gone', name: 'Builder', providerId: 'claude', capturedAt: '2026-10-29T00:00:00.000Z' } };
    expect(validateWorkflowGraph(graph, false, { profileIds: new Set(['other']) }).map(issue => issue.code)).toContain('missing-agent');
    expect(validateWorkflowGraph(graph, false, { profileIds: new Set(['gone']) }).map(issue => issue.code)).not.toContain('missing-agent');
  });
});
