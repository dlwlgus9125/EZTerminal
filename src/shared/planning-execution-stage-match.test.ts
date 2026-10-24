import { describe, expect, it } from 'vitest';
import { taskMatchesStage, type PreparedExecutionTask } from './planning-execution';
import { createWorkflowGraph, type WorkflowNode } from './workflow-graph';

const node: WorkflowNode = { ...createWorkflowGraph('research', 'sub').nodes[0]!, providerId: 'codex', model: 'model', reasoningEffort: 'high',
  permissionPreset: 'standard', role: 'implementation', allowedPaths: ['src/'], acceptance: ['Builds', 'Tested'] };
const task = {
  taskId: node.id, taskRevision: 1, stage: 'implementation', title: node.title, brief: 'Do it', dependsOn: [], retryLimit: 2,
  allowedPaths: ['src/'], acceptance: [{ acceptanceId: 'a1', description: 'Builds' }, { acceptanceId: 'a2', description: 'Tested' }], validations: [],
  profile: { profileId: 'p', revision: 1, role: 'implementation', providerId: 'codex', model: 'model', reasoningEffort: 'high', prompt: 'Do it', permissionPreset: 'standard', capabilities: [] },
} as unknown as PreparedExecutionTask;

describe('taskMatchesStage', () => {
  it('matches a task prepared from exactly this stage', () => {
    expect(taskMatchesStage(task, node)).toBe(true);
  });
  it('tells apart effort, including chosen versus not chosen', () => {
    expect(taskMatchesStage({ ...task, profile: { ...task.profile, reasoningEffort: 'max' } }, node)).toBe(false);
    const withoutEffort = { ...task.profile }; delete (withoutEffort as { reasoningEffort?: string }).reasoningEffort;
    expect(taskMatchesStage({ ...task, profile: withoutEffort }, node)).toBe(false);
    const plainNode = { ...node }; delete plainNode.reasoningEffort;
    expect(taskMatchesStage({ ...task, profile: withoutEffort }, plainNode)).toBe(true);
  });
  it('tells apart model, permission, role, paths and completion criteria order', () => {
    expect(taskMatchesStage({ ...task, profile: { ...task.profile, model: 'other' } }, node)).toBe(false);
    expect(taskMatchesStage({ ...task, profile: { ...task.profile, permissionPreset: 'plan' } }, node)).toBe(false);
    expect(taskMatchesStage({ ...task, stage: 'review' }, node)).toBe(false);
    expect(taskMatchesStage({ ...task, allowedPaths: ['docs/'] }, node)).toBe(false);
    expect(taskMatchesStage({ ...task, acceptance: [...task.acceptance].reverse() }, node)).toBe(false);
  });
});
