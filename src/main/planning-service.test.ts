import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PlanningMutationResultSchema,
  PlanningReadResultSchema,
  type PlanningCommand,
  type PlanningItem,
  type PlanningMutationResult,
  type PlanningOperation,
  type PlanningRoleProfile,
  type PlanningSnapshot,
  type TaskDefinition,
  type SceneElement,
  type ScreenScene,
} from '../shared/planning';
import { PlanningService } from './planning-service';

let root: string;
let service: PlanningService;
let counter: number;
const actor = { kind: 'user', id: 'desktop' } as const;
const now = () => new Date('2026-10-13T04:00:00.000Z');
const filePath = () => path.join(root, '.ezterminal', 'planning', 'project.json');
const createService = () => new PlanningService({ resolveProjectRoot: (id) => id === 'project-1' ? root : null, now });
const item = (id = 'requirement-1', overrides: Partial<PlanningItem> = {}): PlanningItem => ({
  id, revision: 0, title: 'Preserve terminal sessions', kind: 'requirement', body: 'Use the existing PTY authority.',
  status: 'ready', acceptance: ['Switching chat skin preserves the terminal.'], ...overrides,
});
const profile = (overrides: Partial<PlanningRoleProfile> = {}): PlanningRoleProfile => ({
  id: 'planner', revision: 0, title: 'Planning', role: 'planning', instructions: 'Plan within the authorized namespace.',
  contextRefs: [], allowedTools: ['planning.read', 'planning.patch'], retryLimit: 2, ...overrides,
});
const task = (id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition => ({
  id, revision: 0, title: id, objective: 'Implement the reviewed design.', featureIds: [], screenIds: [],
  inputRefs: [], interfaceRefs: [], dependencyIds: [], allowedPaths: ['src'],
  acceptance: [{ id: `${id}-acceptance`, description: 'The required behavior works.' }],
  validationPlan: [{ id: `${id}-check`, acceptanceIds: [`${id}-acceptance`], method: 'command', command: 'pnpm test', description: 'Run checks', environment: 'Windows' }],
  status: 'ready', ...overrides,
});
const element = (id: string, overrides: Partial<SceneElement> = {}): SceneElement => ({
  id, kind: 'button', parentId: null, order: 0, properties: { text: 'Send' }, stateIds: [],
  layout: { direction: 'column', width: 'fill', height: 'hug', gap: 8, padding: 8, overflow: 'visible' }, ...overrides,
});
const scene = (overrides: Partial<ScreenScene> = {}): ScreenScene => ({
  id: 'chat-scene', revision: 0, title: 'Chat', platform: 'windows', width: 1440, height: 900,
  featureIds: [], elements: [element('send')], states: [{ id: 'default', title: 'Default', kind: 'default' }],
  transitions: [], status: 'ready', ...overrides,
});
function patch(expectedRevision: number, operations: PlanningOperation[], commandId = `edit-${++counter}`): PlanningCommand {
  return { commandId, projectId: 'project-1', expectedRevision, actor, type: 'planning.patch', payload: { operations, summary: 'Edit planning' } };
}
function accepted(result: PlanningMutationResult): PlanningSnapshot {
  expect(PlanningMutationResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`${result.error}: ${result.message} ${result.issues?.join(', ')}`);
  return result.snapshot;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-planning-'));
  service = createService();
  counter = 0;
});
afterEach(async () => {
  await service.flush();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('PlanningService durable project authority', () => {
  it('freezes selected tasks with their dependency and document closure while leaving unrelated drafts untouched', async () => {
    const before = accepted(await service.execute(patch(0, [
      { op: 'item.put', value: item('requirement') }, { op: 'item.put', value: item('unrelated', { status: 'draft' }) },
      { op: 'profile.put', value: profile() },
      { op: 'task.put', value: task('dependency', { featureIds: ['requirement'], profileId: 'planner' }) },
      { op: 'task.put', value: task('chosen', { dependencyIds: ['dependency'] }) },
      { op: 'task.put', value: task('unfinished', { status: 'draft' }) },
    ])));
    const result = accepted(await service.execute({ projectId: 'project-1', commandId: 'selected-freeze', expectedRevision: before.revision, actor, type: 'planning.freeze', payload: { baselineId: 'selected', title: 'Selected tasks', taskIds: ['chosen'] } }));
    expect(result.draft).toEqual(before.draft);
    expect(result.baselines[0].draft.tasks.map(value => value.id)).toEqual(['dependency', 'chosen']);
    expect(result.baselines[0].draft.items.map(value => value.id)).toEqual(['requirement']);
    expect(result.baselines[0].draft.profiles.map(value => value.id)).toEqual(['planner']);
  });
  it('freezes a reviewed quick task independently of unfinished planning and preserves the editable draft', async () => {
    const before = accepted(await service.execute(patch(0, [
      { op: 'item.put', value: item('unfinished', { status: 'draft' }) },
      { op: 'profile.put', value: profile() },
    ])));
    const command: PlanningCommand = { commandId: 'quick', projectId: 'project-1', expectedRevision: before.revision, actor,
      type: 'planning.quick-freeze', payload: { baselineId: 'quick-baseline', title: 'Small task', task: task('quick-task'), profileIds: ['planner'] } };
    const after = accepted(await service.execute(command));
    expect(after.draft).toEqual(before.draft);
    expect(after.baselines[0]).toMatchObject({ purpose: 'quick-task', draft: { items: [], tasks: [{ id: 'quick-task' }], profiles: [{ id: 'planner' }] } });
    expect(await createService().execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(await service.execute({ ...command, commandId: 'ai-quick', expectedRevision: after.revision, actor: { kind: 'ai', id: 'agent' } }))
      .toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('reads a legacy project without creating planning files or touching terminal data', async () => {
    await fs.writeFile(path.join(root, 'terminal-state'), 'existing');
    const result = await service.read('project-1');
    expect(PlanningReadResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true, snapshot: { revision: 0, draft: { items: [] } } });
    expect(await fs.readdir(root)).toEqual(['terminal-state']);
    expect(await service.read('unknown')).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('commits typed edits and idempotency receipts together and survives a host restart', async () => {
    const command = patch(0, [{ op: 'item.put', value: item() }], 'first-edit');
    const result = await service.execute(command);
    const snapshot = accepted(result);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.draft.items[0]?.revision).toBe(1);
    const restarted = createService();
    const duplicate = await restarted.execute(command);
    expect(duplicate).toEqual({ ...result, duplicate: true });
    expect((await fs.readdir(path.dirname(filePath())))).toEqual(['project.json']);
    expect(await restarted.execute({ ...command, payload: { ...command.payload, summary: 'different' } })).toMatchObject({ ok: false, error: 'conflict' });
    const persisted = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    expect(persisted.receipts).toHaveLength(1);
    expect(persisted.snapshot.history).toHaveLength(1);
    expect(persisted.snapshot).not.toHaveProperty('attempts');
  });

  it('serializes competing edits and preserves the winner when the other revision is stale', async () => {
    const results = await Promise.all([
      service.execute(patch(0, [{ op: 'item.put', value: item('first') }])),
      service.execute(patch(0, [{ op: 'item.put', value: item('second') }])),
    ]);
    expect(results.filter((entry) => entry.ok)).toHaveLength(1);
    expect(results.find((entry) => !entry.ok)).toMatchObject({ error: 'stale', revision: 1 });
    expect(await service.read('project-1')).toMatchObject({ ok: true, snapshot: { draft: { items: [{ id: 'first' }] } } });
  });

  it('does not consume command IDs or revisions when a write fails', async () => {
    const first = accepted(await service.execute(patch(0, [{ op: 'item.put', value: item() }])));
    const before = await fs.readFile(filePath(), 'utf8');
    const command = patch(1, [{ op: 'item.put', value: { ...first.draft.items[0]!, title: 'Updated title' } }]);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    expect(await service.execute(command)).toMatchObject({ ok: false, error: 'unavailable', revision: 1 });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(before);
    expect(await fs.readdir(path.dirname(filePath()))).toEqual(['project.json']);
    rename.mockRestore();
    expect(accepted(await service.execute(command)).revision).toBe(2);
  });

  it('preserves immutable baselines while branching and undoing as new revisions', async () => {
    const initial = accepted(await service.execute(patch(0, [{ op: 'item.put', value: item() }])));
    const frozen = accepted(await service.execute({ commandId: 'freeze', projectId: 'project-1', expectedRevision: 1, actor,
      type: 'planning.freeze', payload: { baselineId: 'baseline-1', title: 'Approved design' } }));
    const original = structuredClone(frozen.baselines[0]);
    const edited = accepted(await service.execute(patch(2, [{ op: 'item.put', value: { ...initial.draft.items[0]!, body: 'New requirement.' } }], 'changed')));
    expect(edited.baselines[0]).toEqual(original);
    const undone = accepted(await service.execute({ commandId: 'undo', projectId: 'project-1', expectedRevision: 3, actor,
      type: 'planning.undo', payload: { changeId: 'changed' } }));
    expect(undone.draft.items[0]).toMatchObject({ body: item().body, revision: 4 });
    expect(undone.history.at(-1)).toMatchObject({ undoOf: 'changed' });
    const branch = accepted(await service.execute({ commandId: 'branch', projectId: 'project-1', expectedRevision: 4, actor,
      type: 'planning.branch', payload: { baselineId: 'baseline-1', draftId: 'draft-2' } }));
    expect(branch.draft).toMatchObject({ id: 'draft-2', basedOnBaselineId: 'baseline-1' });
    expect(branch.baselines[0]).toEqual(original);
    expect(await service.execute({ commandId: 'wrong-undo', projectId: 'project-1', expectedRevision: 5, actor,
      type: 'planning.undo', payload: { changeId: 'changed' } })).toMatchObject({ ok: false, error: 'conflict' });
    const reread = await createService().read('project-1');
    expect(reread).toMatchObject({ ok: true, snapshot: { baselines: [original] } });
  });

  it('rejects deleting referenced entities unless all affected references are removed in the same bundle', async () => {
    const draft = accepted(await service.execute(patch(0, [
      { op: 'item.put', value: item('requirement') }, { op: 'item.put', value: item('feature', { kind: 'feature' }) },
      { op: 'link.put', value: { id: 'link', revision: 0, fromId: 'feature', toId: 'requirement', kind: 'implements', note: '' } },
    ])));
    expect(draft.revision).toBe(1);
    expect(await service.execute(patch(1, [{ op: 'entity.delete', kind: 'item', id: 'requirement' }]))).toMatchObject({ ok: false, error: 'invalid' });
    const result = accepted(await service.execute(patch(1, [{ op: 'entity.delete', kind: 'item', id: 'requirement' }, { op: 'entity.delete', kind: 'link', id: 'link' }])));
    expect(result.draft.items.map((entry) => entry.id)).toEqual(['feature']);
    expect(result.draft.links).toHaveLength(0);
  });

  it('marks linked tasks and downstream dependents for review while leaving independent work alone', async () => {
    const start = accepted(await service.execute(patch(0, [
      { op: 'item.put', value: item('requirement') },
      { op: 'task.put', value: task('t1', { featureIds: ['requirement'] }) },
      { op: 'task.put', value: task('t2', { dependencyIds: ['t1'] }) },
      { op: 'task.put', value: task('t3') },
    ])));
    const next = accepted(await service.execute(patch(1, [{ op: 'item.put', value: { ...start.draft.items[0]!, body: 'Changed' } }])));
    expect(next.draft.tasks.map((entry) => [entry.id, entry.status])).toEqual([['t1', 'review-needed'], ['t2', 'review-needed'], ['t3', 'ready']]);
    expect(await service.execute({ commandId: 'premature-freeze', projectId: 'project-1', expectedRevision: 2, actor,
      type: 'planning.freeze', payload: { baselineId: 'baseline', title: 'Premature' } })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('rejects cyclic task graphs and incomplete validation before any disk mutation', async () => {
    expect(await service.execute(patch(0, [
      { op: 'task.put', value: task('t1', { dependencyIds: ['t2'] }) },
      { op: 'task.put', value: task('t2', { dependencyIds: ['t1'] }) },
    ]))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.execute(patch(0, [{ op: 'task.put', value: task('t1', { validationPlan: [] }) }]))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps AI profile proposals separate until an explicit user applies the exact version', async () => {
    const created = accepted(await service.execute(patch(0, [{ op: 'profile.put', value: profile() }])));
    const current = created.draft.profiles[0]!;
    const proposed = { ...current, instructions: 'Provide short decision-ready alternatives.' };
    const proposal = accepted(await service.execute({ commandId: 'propose', projectId: 'project-1', expectedRevision: 1,
      actor: { kind: 'ai', id: 'planner-session' }, type: 'profile.propose',
      payload: { proposalId: 'proposal-1', profileId: current.id, baseVersion: current.revision, proposed, reason: 'Improve clarity.' } }));
    expect(proposal.draft.profiles[0]).toEqual(current);
    const apply = { commandId: 'apply', projectId: 'project-1', expectedRevision: 2, actor,
      type: 'profile.apply', payload: { proposalId: 'proposal-1' } } as const;
    expect(await service.execute({ ...apply, actor: { kind: 'ai', id: 'planner-session' } })).toMatchObject({ ok: false, error: 'forbidden' });
    const applied = accepted(await service.execute(apply));
    expect(applied.draft.profiles[0]).toMatchObject({ instructions: proposed.instructions, revision: 3 });
    expect(applied.profileProposals[0]?.status).toBe('applied');
  });

  it('rejects planning execution permissions and AI direct profile edits', async () => {
    expect(await service.execute(patch(0, [{ op: 'profile.put', value: profile({ allowedTools: ['terminal.execute'] }) }]))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.execute({ ...patch(0, [{ op: 'profile.put', value: profile() }]), actor: { kind: 'ai', id: 'agent' } })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await service.execute({ ...patch(0, [{ op: 'item.put', value: item() }]), payload: { operations: [{ op: 'runtime.put', value: {} }], summary: 'Invalid runtime persistence' } })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('marks an AI profile proposal stale after a user changes its base version', async () => {
    const start = accepted(await service.execute(patch(0, [{ op: 'profile.put', value: profile() }])));
    const current = start.draft.profiles[0]!;
    accepted(await service.execute({ commandId: 'proposal', projectId: 'project-1', expectedRevision: 1,
      actor: { kind: 'ai', id: 'agent' }, type: 'profile.propose',
      payload: { proposalId: 'p1', profileId: current.id, baseVersion: current.revision,
        proposed: { ...current, instructions: 'AI proposal' }, reason: 'Clarify instructions.' } }));
    const edited = accepted(await service.execute(patch(2, [{ op: 'profile.put', value: { ...current, instructions: 'User edit' } }])));
    expect(edited.profileProposals[0]?.status).toBe('stale');
    expect(await service.execute({ commandId: 'apply-stale', projectId: 'project-1', expectedRevision: 3, actor,
      type: 'profile.apply', payload: { proposalId: 'p1' } })).toMatchObject({ ok: false, error: 'stale' });
    expect(await createService().read('project-1')).toMatchObject({ ok: true, snapshot: { draft: { profiles: [{ instructions: 'User edit' }] } } });
  });

  it('retains stale draft references for review but refuses to freeze them', async () => {
    accepted(await service.execute(patch(0, [{ op: 'item.put', value: item('source') }])));
    const withTask = accepted(await service.execute(patch(1, [{ op: 'task.put', value: task('consumer', {
      inputRefs: [{ id: 'source', kind: 'item', revision: 1 }],
    }) }])));
    const changed = accepted(await service.execute(patch(2, [{ op: 'item.put', value: { ...withTask.draft.items[0]!, body: 'New source' } }])));
    expect(changed.draft.tasks[0]).toMatchObject({ status: 'review-needed', inputRefs: [{ revision: 1 }] });
    const reviewed = accepted(await service.execute(patch(3, [{ op: 'task.put', value: { ...changed.draft.tasks[0]!, status: 'ready' } }])));
    expect(await service.execute({ commandId: 'freeze-stale-ref', projectId: 'project-1', expectedRevision: 4, actor,
      type: 'planning.freeze', payload: { baselineId: 'base', title: 'Base' } })).toMatchObject({ ok: false, error: 'invalid' });
    expect(accepted(await service.execute(patch(4, [{ op: 'task.put', value: {
      ...reviewed.draft.tasks[0]!, inputRefs: [{ id: 'source', kind: 'item', revision: 3 }],
    } }]))).revision).toBe(5);
    expect(accepted(await service.execute({ commandId: 'freeze-current-ref', projectId: 'project-1', expectedRevision: 5, actor,
      type: 'planning.freeze', payload: { baselineId: 'base', title: 'Base' } })).baselines).toHaveLength(1);
  });

  it('rejects tampered baseline data and preserves the original bytes for recovery', async () => {
    accepted(await service.execute(patch(0, [{ op: 'item.put', value: item() }])));
    accepted(await service.execute({ commandId: 'freeze-for-integrity', projectId: 'project-1', expectedRevision: 1, actor,
      type: 'planning.freeze', payload: { baselineId: 'base', title: 'Base' } }));
    const stored = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    stored.snapshot.baselines[0].draft.items[0].body = 'Changed baseline';
    const tampered = JSON.stringify(stored);
    await fs.writeFile(filePath(), tampered);
    expect(await createService().read('project-1')).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(tampered);
  });

  it('preserves malformed or externally edited files instead of quarantining or replacing them', async () => {
    accepted(await service.execute(patch(0, [{ op: 'item.put', value: item() }])));
    const original = await fs.readFile(filePath(), 'utf8');
    const malformed = '{ broken but recoverable';
    await fs.writeFile(filePath(), malformed);
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await service.execute(patch(1, [{ op: 'item.put', value: item('new') }]))).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(malformed);
    await fs.writeFile(filePath(), original);
    const external = createService();
    accepted(await external.execute(patch(1, [{ op: 'item.put', value: item('outside') }], 'external-edit')));
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'external-change', message: expect.stringContaining('restart the application') });
    expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'external-change' });
    expect(await createService().read('project-1')).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  });

  it('blocks planning directory junctions that escape the authorized project', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-planning-external-'));
    try {
      await fs.mkdir(path.join(root, '.ezterminal'));
      await fs.symlink(external, path.join(root, '.ezterminal', 'planning'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(await service.read('project-1')).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await service.execute(patch(0, [{ op: 'item.put', value: item() }]))).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await fs.readdir(external)).toEqual([]);
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });

  it('propagates component properties while preserving instance overrides and immutable baselines', async () => {
    const component = { id: 'send-component', revision: 0, title: 'Send button', elements: [element('button')], allowedOverrides: ['text'] as ['text'] };
    accepted(await service.execute(patch(0, [{ op: 'component.put', value: component }])));
    const created = accepted(await service.execute(patch(1, [{ op: 'scene.put', value: scene({ elements: [element('send', {
      properties: { text: '보내기' }, component: { componentId: component.id, version: 1, overrides: { text: '보내기' } },
    })] }) }])));
    const frozen = accepted(await service.execute({ commandId: 'scene-freeze', projectId: 'project-1', expectedRevision: 2, actor,
      type: 'planning.freeze', payload: { baselineId: 'scene-baseline', title: 'Scene' } }));
    const updated = accepted(await service.execute(patch(3, [{ op: 'component.put', value: {
      ...created.draft.components[0]!, elements: [element('button', { properties: { text: 'Submit', disabled: true } })],
    } }])));
    expect(updated.draft.scenes[0]?.elements[0]?.properties).toEqual({ text: '보내기', disabled: true });
    expect(updated.draft.scenes[0]?.status).toBe('review-needed');
    expect(updated.baselines).toEqual(frozen.baselines);
    expect(await service.execute(patch(4, [{ op: 'component.put', value: { ...updated.draft.components[0]!, allowedOverrides: [] } }]))).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('propagates nested component edits atomically while keeping local overrides and frozen versions', async () => {
    accepted(await service.execute(patch(0, [{ op: 'component.put', value: { id: 'button-component', revision: 0, title: 'Button', elements: [element('button-root')], allowedOverrides: ['text'] } }])));
    accepted(await service.execute(patch(1, [{ op: 'component.put', value: { id: 'card-component', revision: 0, title: 'Card', allowedOverrides: [], elements: [
      element('card-root', { kind: 'frame' }), element('nested-button', { parentId: 'card-root', properties: { text: 'Local label' }, component: { componentId: 'button-component', version: 1, overrides: { text: 'Local label' } } }),
    ] } }])));
    accepted(await service.execute(patch(2, [{ op: 'scene.put', value: scene({ elements: [element('card-instance', { kind: 'frame', component: { componentId: 'card-component', version: 2, overrides: {} } })] }) }])));
    const frozen = accepted(await service.execute({ commandId: 'nested-freeze', projectId: 'project-1', expectedRevision: 3, actor, type: 'planning.freeze', payload: { baselineId: 'nested-baseline', title: 'Frozen nested design' } }));
    const button = frozen.draft.components.find((entry) => entry.id === 'button-component')!;
    const changed = accepted(await service.execute(patch(4, [{ op: 'component.put', value: { ...button, elements: [element('button-root', { properties: { text: 'Global label', disabled: true } })] } }])));
    expect(changed.draft.components.find((entry) => entry.id === 'card-component')).toMatchObject({ revision: 5, elements: expect.arrayContaining([expect.objectContaining({ properties: { text: 'Local label', disabled: true }, component: { componentId: 'button-component', version: 5, overrides: { text: 'Local label' } } })]) });
    expect(changed.draft.scenes[0]?.elements.find((entry) => entry.id === 'card-instance')?.component?.version).toBe(5);
    expect(changed.draft.scenes[0]?.elements.find((entry) => entry.id === 'card-instance:nested-button')?.properties).toEqual({ text: 'Local label', disabled: true });
    expect(changed.baselines).toEqual(frozen.baselines);
    const card = changed.draft.components.find((entry) => entry.id === 'card-component')!;
    const nextButton = changed.draft.components.find((entry) => entry.id === 'button-component')!;
    const together = accepted(await service.execute(patch(5, [
      { op: 'component.put', value: { ...nextButton, elements: [element('button-root', { properties: { text: 'Second global label' } })] } },
      { op: 'component.put', value: { ...card, title: 'Manually edited card' } },
    ])));
    expect(together.draft.components.find((entry) => entry.id === 'card-component')).toMatchObject({ revision: 6, title: 'Manually edited card' });
    expect(together.draft.scenes[0]?.elements.find((entry) => entry.id === 'card-instance:nested-button')?.properties.text).toBe('Local label');
  });

  it('rejects nested component cycles without changing either source or scene', async () => {
    accepted(await service.execute(patch(0, [{ op: 'component.put', value: { id: 'a', revision: 0, title: 'A', elements: [element('a-root')], allowedOverrides: [] } }])));
    const before = accepted(await service.execute(patch(1, [{ op: 'component.put', value: { id: 'b', revision: 0, title: 'B', elements: [element('b-root', { component: { componentId: 'a', version: 1, overrides: {} } })], allowedOverrides: [] } }])));
    expect(await service.execute(patch(2, [{ op: 'component.put', value: { ...before.draft.components.find((entry) => entry.id === 'a')!, elements: [element('a-root', { component: { componentId: 'b', version: 2, overrides: {} } })] } }]))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.read('project-1')).toEqual({ ok: true, snapshot: before });
  });
});
