import { describe, expect, it } from 'vitest';
import { changedStageSettings, effectiveRun, stageEditScope, stageStructureChanged, withStageSettings, type ExecutionRun, type StageBinding } from './planning-execution';
import { createWorkflowGraph } from './workflow-graph';

const graph = createWorkflowGraph('research', 'sub');
const stage = { ...graph.nodes[0]!, providerId: 'codex', model: 'model', instructions: 'Original', acceptance: ['Done'] };
const frozenGraph = { ...graph, nodes: [stage, ...graph.nodes.slice(1)] };
const task = { taskId: stage.id, taskRevision: 1, stage: 'planning', title: stage.title, brief: 'Original brief', dependsOn: [], retryLimit: 2,
  acceptance: [{ acceptanceId: 'a', description: 'Done' }], validations: [{ validationId: 'v', acceptanceIds: ['a'], method: 'inspection', environment: 'Review' }],
  profile: { profileId: 'p', revision: 1, role: 'planning', providerId: 'codex', model: 'model', prompt: 'Original', permissionPreset: 'plan', capabilities: [] } } as const;
function run(overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return { runId: 'r', projectId: 'p', revision: 1, state: 'running', startedAt: '2026-10-25T00:00:00.000Z', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
    preparationFingerprint: 'f'.repeat(64), attempts: [], evidence: [], reviews: [], gates: [],
    tasks: [{ taskId: stage.id, state: 'ready', retriesUsed: 0 }],
    preparation: { baseline: { baselineId: 'b', revision: 1, fingerprint: 'a'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: [task],
      workflow: { subprojectId: 'sub', revision: 1, fingerprint: 'c'.repeat(64), graph: frozenGraph } },
    ...overrides } as unknown as ExecutionRun;
}

describe('stage settings vs structure', () => {
  it('splits bindable settings from structure, and splices only settings', () => {
    const edited = { ...stage, instructions: 'Newer', reasoningEffort: 'high', role: 'review' as const, position: { x: 9, y: 9 } };
    expect(changedStageSettings(stage, edited)).toEqual(['instructions', 'reasoningEffort']);
    expect(stageStructureChanged(stage, edited)).toBe(true);
    expect(stageStructureChanged(stage, { ...stage, position: { x: 9, y: 9 } })).toBe(false);
    const spliced = withStageSettings(stage, edited);
    expect(spliced).toMatchObject({ instructions: 'Newer', reasoningEffort: 'high', role: stage.role, position: stage.position });
    // Clearing a setting clears it.
    expect(withStageSettings({ ...stage, reasoningEffort: 'high' }, stage)).not.toHaveProperty('reasoningEffort');
  });
});

describe('effectiveRun', () => {
  it('applies only applied bindings, to the task and its stage', () => {
    const node = { ...stage, instructions: 'Newer' };
    const applied: StageBinding = { outcome: 'applied', boundAt: '2026-10-25T00:00:01.000Z', changed: ['instructions'], node,
      task: { ...task, brief: 'Newer brief', profile: { ...task.profile, prompt: 'Newer' } } as unknown as StageBinding['task'] };
    const effective = effectiveRun(run({ stageBindings: { [stage.id]: applied } }));
    expect(effective.preparation.tasks[0]!.brief).toBe('Newer brief');
    expect(effective.preparation.workflow!.graph.nodes[0]!.instructions).toBe('Newer');
    const kept = run({ stageBindings: { [stage.id]: { outcome: 'kept', boundAt: '2026-10-25T00:00:01.000Z', reason: 'invalid' } } });
    expect(effectiveRun(kept)).toBe(kept);
  });
});

describe('stageEditScope', () => {
  it('is this run before the stage starts, locked while it works, next run afterwards or when not running', () => {
    expect(stageEditScope(run(), stage.id)).toBe('this-run');
    expect(stageEditScope(run({ tasks: [{ taskId: stage.id, state: 'waiting', retriesUsed: 0 }] }), stage.id)).toBe('this-run');
    expect(stageEditScope(run({ tasks: [{ taskId: stage.id, state: 'running', retriesUsed: 0 }] }), stage.id)).toBe('locked');
    // Held before its first send: the edit binds when the run continues.
    expect(stageEditScope(run({ tasks: [{ taskId: stage.id, state: 'paused', retriesUsed: 0, pauseReason: 'Held' }] }), stage.id)).toBe('this-run');
    expect(stageEditScope(run({ tasks: [{ taskId: stage.id, state: 'completed', retriesUsed: 0 }] }), stage.id)).toBe('next-run');
    // Once its first dispatch was decided (binding recorded) the stage counts as working until it finishes.
    const bound = { [stage.id]: { outcome: 'kept' as const, boundAt: '2026-10-25T00:00:01.000Z', reason: 'unchanged' as const } };
    expect(stageEditScope(run({ stageBindings: bound }), stage.id)).toBe('locked');
    expect(stageEditScope(run({ stageBindings: bound, tasks: [{ taskId: stage.id, state: 'completed', retriesUsed: 0 }] }), stage.id)).toBe('next-run');
    expect(stageEditScope(run({ stageBindings: bound, tasks: [{ taskId: stage.id, state: 'failed', retriesUsed: 0 }] }), stage.id)).toBe('next-run');
    expect(stageEditScope(run({ state: 'completed' }), stage.id)).toBe('next-run');
    expect(stageEditScope(run({ startedAt: undefined, state: 'prepared' }), stage.id)).toBe('next-run');
    expect(stageEditScope(undefined, stage.id)).toBe('next-run');
    // Approval, condition and completion stages have no task: their edits wait for the next run.
    expect(stageEditScope(run(), graph.nodes[1]!.id)).toBe('next-run');
  });
});
