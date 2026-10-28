import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowService, launchIntentDigest, repeatContentDigest, repeatPin, workflowDigest, type WorkflowRepeatConsentChange } from './workflow-service';
import { repeatConfigDigest } from './workflow-repeat-time';
import { PlanningService } from './planning-service';
import { seedPlanning } from './planning-seed.fixture';
import type { TaskDefinition } from '../shared/planning';
import { createWorkflowGraph, WorkflowCommandSchema, type WorkflowCommand, type WorkflowSnapshot, type WorkflowSubproject } from '../shared/workflow';
import { legacyWorkflowPreviewResult, legacyWorkflowResult } from '../shared/workflow-protocol-projection';

let directory: string; let planning: PlanningService; let service: WorkflowService;
const user = { kind: 'desktop' as const, id: 'surface' };
const base = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
const create = (id: string): WorkflowCommand => ({ ...base, commandId: `create-${id}`, type: 'subproject.create', payload: { id, title: id, goal: '', presetId: 'research' } });
async function snapshot(): Promise<WorkflowSnapshot> { const result = await service.read('project'); if (!result.ok) throw new Error(result.message); return result.snapshot; }
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-'));
  planning = new PlanningService({ resolveProjectRoot: id => id === 'project' ? directory : null });
  service = new WorkflowService({ hostId: 'host', resolveProjectRoot: id => id === 'project' ? directory : null, planning, runs: () => [],
    session: id => id === 'chat' ? { projectId: 'project', managed: false } : id === 'managed' ? { projectId: 'project', managed: true } : { projectId: 'other', managed: false } });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe('workflow authority and storage', () => {
  it('keeps an unmigrated legacy registry stable across reads and host restarts', async () => {
    await seedPlanning(planning, 'project', { items: [{ id: 'item', revision: 0, title: 'old', kind: 'requirement', body: 'record', status: 'ready', acceptance: [] }] });
    const options = { hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined };
    const earlier = new WorkflowService({ ...options, now: () => new Date('2026-10-13T00:00:00.000Z') });
    const later = new WorkflowService({ ...options, now: () => new Date('2026-10-14T00:00:00.000Z') });
    const source = path.join(directory, '.ezterminal', 'planning', 'project.json'); const before = await fs.readFile(source);
    const previous = await earlier.exportRegistry('project');
    expect(await later.exportRegistry('project')).toEqual(previous);
    await expect(fs.stat(path.join(directory, '.ezterminal', 'planning', 'workflows.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await later.execute(create('a'), user)).ok).toBe(true);
    expect((await later.exportRegistry('project')).subprojects[0]).toEqual(previous.subprojects[0]);
    expect(await fs.readFile(source)).toEqual(before);
  });
  it('derives legacy timestamps without history from the preserved source file without persisting a registry', async () => {
    const initial = await planning.read('project'); if (!initial.ok) throw new Error(initial.message);
    initial.snapshot.draft.items.push({ id: 'item', revision: 0, title: 'Imported', kind: 'requirement', body: 'record', status: 'ready', acceptance: [] });
    expect((await planning.importSnapshot('project', initial.snapshot)).ok).toBe(true);
    const source = path.join(directory, '.ezterminal', 'planning', 'project.json'); const before = await fs.readFile(source);
    const previous = await service.exportRegistry('project');
    const restarted = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, now: () => new Date('2026-10-14T00:00:00.000Z') });
    expect(await restarted.exportRegistry('project')).toEqual(previous);
    expect(previous.subprojects[0].createdAt).toBe((await fs.stat(source)).mtime.toISOString());
    expect(await fs.readFile(source)).toEqual(before);
    await expect(fs.stat(path.join(directory, '.ezterminal', 'planning', 'workflows.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('maps legacy planning without changing source bytes, baselines or receipts and keeps quick tasks unowned', async () => {
    const quickTask: TaskDefinition = { id: 'quick-task', revision: 0, title: 'Quick', objective: 'Check one thing', featureIds: [], screenIds: [], inputRefs: [], dependencyIds: [], allowedPaths: [], interfaceRefs: [], acceptance: [{ id: 'ac', description: 'Checked' }], validationPlan: [{ id: 'v', acceptanceIds: ['ac'], description: 'Inspect', method: 'inspection', environment: 'Host' }], status: 'ready' };
    await seedPlanning(planning, 'project', { items: [{ id: 'item', revision: 0, title: 'old', kind: 'requirement', body: 'record', status: 'ready', acceptance: [] }] }, { baselines: [
      { id: 'old-baseline', title: 'Old baseline' },
      { id: 'quick', title: 'Quick', purpose: 'quick-task', draft: { tasks: [quickTask] } },
    ] });
    const source = path.join(directory, '.ezterminal', 'planning', 'project.json'); const before = await fs.readFile(source);
    const migrated = await snapshot(); expect(migrated.subprojects[0].id).toBe('legacy-default');
    expect((await service.execute(create('a'), user)).ok).toBe(true);
    expect(await fs.readFile(source)).toEqual(before);
    expect((await fs.readdir(path.dirname(source))).filter(name => name.includes('workflow-backup')).length).toBe(1);
    expect(migrated.legacyBaselineOwners['old-baseline']).toBe('legacy-default');
    expect(migrated.legacyBaselineOwners.quick).toBeNull();
    // The old planning screen's edits are refused (I5); a legacy-default flow run still adds its baseline to the root file.
    expect(await planning.execute({ projectId: 'project', commandId: 'later-freeze', actor: { kind: 'user', id: 'u' }, expectedRevision: 3, type: 'planning.freeze', payload: { baselineId: 'later-baseline', title: 'Later baseline' } })).toMatchObject({ ok: false, error: 'forbidden' });
    const empty = { id: 'draft-1', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] };
    expect((await planning.captureWorkflowBaseline('project', 'legacy-default', 'later-baseline', 'Later baseline', empty)).ok).toBe(true);
    expect((await snapshot()).legacyBaselineOwners['later-baseline']).toBe('legacy-default');
  });
  it('isolates revisions across subprojects, serializes same-draft conflicts and replays exact commands', async () => {
    const a = create('a'); expect((await service.execute(a, user)).ok).toBe(true);
    expect(await service.execute(a, user)).toMatchObject({ ok: true, duplicate: true });
    expect(await service.execute({ ...a, payload: { ...a.payload, title: 'changed' } }, user)).toMatchObject({ ok: false, error: 'command-conflict' });
    expect((await service.execute({ ...create('b'), expectedRevision: 1 }, user)).ok).toBe(true);
    const command: WorkflowCommand = { ...base, commandId: 'edit-a', subprojectId: 'a', type: 'workflow.patch', payload: { graph: createWorkflowGraph('fix', 'a'), summary: 'change a' } };
    const outcomes = await Promise.all([service.execute(command, user), service.execute({ ...command, commandId: 'second-a' }, user)]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1); expect(outcomes.filter(result => !result.ok)).toHaveLength(1);
    expect(await service.execute({ ...base, commandId: 'edit-b', subprojectId: 'b', type: 'workflow.patch', payload: { graph: createWorkflowGraph('fix', 'b'), summary: 'change b' } }, user)).toMatchObject({ ok: true });
  });
  it('rejects duplicate graph identities at creation and preserves repairable missing-reference drafts during copy', async () => {
    const graph = createWorkflowGraph('research', 'a'); graph.nodes.push(structuredClone(graph.nodes[0]));
    expect(await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user)).toMatchObject({ ok: false, error: 'invalid-command' });
    expect((await snapshot()).subprojects).toEqual([]);
    graph.nodes.pop(); graph.edges[0].to = 'missing-stage';
    expect(await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user)).toMatchObject({ ok: true });
    expect(await service.execute({ ...base, commandId: 'copy-incomplete', type: 'subproject.copy', subprojectId: 'a', payload: { id: 'b', title: 'Incomplete copy' } }, user)).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects[1].graph.edges[0].to).toMatch(/^copy-/u);
  });
  it('compensates an earlier nonconflicting edit and rejects overlapping undo', async () => {
    await service.execute(create('a'), user); let graph = (await snapshot()).subprojects[0].graph;
    graph.nodes[0].title = 'first change'; await service.execute({ ...base, commandId: 'first', subprojectId: 'a', type: 'workflow.patch', payload: { graph, summary: 'first' } }, user);
    graph = structuredClone(graph); graph.nodes[1].title = 'unrelated'; await service.execute({ ...base, expectedRevision: 1, commandId: 'second', subprojectId: 'a', type: 'workflow.patch', payload: { graph, summary: 'second' } }, user);
    expect((await service.execute({ ...base, expectedRevision: 2, commandId: 'undo-first', subprojectId: 'a', type: 'workflow.undo', payload: { changeId: 'first' } }, user)).ok).toBe(true);
    const owner = (await snapshot()).subprojects[0]; expect(owner.graph.nodes.find(node => node.id === 'a:research')?.title).toBe('조사'); expect(owner.graph.nodes.find(node => node.id === 'a:approval')?.title).toBe('unrelated');
    expect(await service.execute({ ...base, expectedRevision: 3, commandId: 'undo-again', subprojectId: 'a', type: 'workflow.undo', payload: { changeId: 'first' } }, user)).toMatchObject({ ok: false, error: 'revision-conflict' });
  });
  it('preserves conversations and deleted stage identities, rejecting foreign/managed ownership', async () => {
    await service.execute(create('a'), user);
    const link: WorkflowCommand = { ...base, commandId: 'link', subprojectId: 'a', type: 'session.link', payload: { sessionId: 'chat', scope: 'stage', nodeId: 'a:research' } };
    expect((await service.execute(link, user)).ok).toBe(true);
    expect(await service.execute({ ...link, commandId: 'managed-link', expectedRevision: 1, payload: { ...link.payload, sessionId: 'managed' } }, user)).toMatchObject({ ok: false, error: 'forbidden' });
    const graph = (await snapshot()).subprojects[0].graph; graph.nodes = graph.nodes.filter(node => node.id !== 'a:research'); graph.edges = [];
    expect((await service.execute({ ...base, expectedRevision: 1, commandId: 'delete', subprojectId: 'a', type: 'workflow.patch', payload: { graph, summary: 'remove' } }, user)).ok).toBe(true);
    const state = await snapshot(); expect(state.sessionLinks[0].sessionId).toBe('chat'); expect(state.subprojects[0].archivedNodes[0].id).toBe('a:research');
  });
  it('guards host and AI authority and confines creation conversations to revocable previews', async () => {
    expect(await service.execute({ ...create('a'), hostId: 'another' }, user)).toMatchObject({ ok: false, error: 'wrong-host' });
    const graph = createWorkflowGraph('research', 'a');
    expect(await service.preview({ action: 'open', projectId: 'project', sessionId: 'chat', previewId: 'preview', graph })).toMatchObject({ ok: true });
    expect(await service.execute(create('a'), { kind: 'ai', id: 'agent', sessionId: 'chat' })).toMatchObject({ ok: false, error: 'preview-only' });
    expect(await service.editPreview('other', { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 0, graph })).toMatchObject({ ok: false });
    expect(await service.editPreview('chat', { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 0, graph })).toMatchObject({ ok: true, preview: { revision: 1 } });
    expect(await service.editPreview('chat', { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 0, graph })).toMatchObject({ ok: true, preview: { revision: 1 } });
    expect(await service.editPreview('chat', { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 0, graph: { ...graph, entryNodeId: null } })).toMatchObject({ ok: false });
    expect(await service.execute({ ...create('a'), payload: { ...create('a').payload, graph, previewId: 'preview', previewRevision: 0 } }, user)).toMatchObject({ ok: false, error: 'preview-conflict' });
    await service.preview({ action: 'discard', projectId: 'project', previewId: 'preview' });
    expect(await service.editPreview('chat', { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 1, graph })).toMatchObject({ ok: false });
    await service.preview({ action: 'open', projectId: 'project', sessionId: 'chat', previewId: 'preview', graph });
    expect(await service.editPreview('chat', { commandId: 'late-edit', previewId: 'preview', expectedRevision: 0, graph })).toMatchObject({ ok: false });
    expect((await snapshot()).subprojects).toHaveLength(0);
  });
  it('freezes stage documents until explicit refresh, without false staleness from link revisions', async () => {
    const command = create('a'); const graph = createWorkflowGraph('research', 'a'); graph.nodes[0].document = 'x'.repeat(100_000);
    await service.execute({ ...command, payload: { ...command.payload, graph } }, user);
    await service.execute({ ...base, commandId: 'link', subprojectId: 'a', type: 'session.link', payload: { sessionId: 'chat', nodeId: 'a:research', scope: 'stage' } }, user);
    expect((await snapshot()).sessionLinks[0]).toMatchObject({ referenceStale: false });
    expect((await service.conversationContext('project', 'chat'))?.document).toHaveLength(100_000);
    graph.nodes[0].document = 'new saved document';
    await service.execute({ ...base, commandId: 'document', subprojectId: 'a', expectedRevision: 1, type: 'workflow.patch', payload: { graph, summary: 'Update document' } }, user);
    expect((await snapshot()).sessionLinks[0].referenceStale).toBe(true);
    expect((await service.conversationContext('project', 'chat'))?.document).toHaveLength(100_000);
    await service.execute({ ...base, commandId: 'refresh', subprojectId: 'a', expectedRevision: 2, type: 'session.refresh', payload: { sessionId: 'chat' } }, user);
    expect((await snapshot()).sessionLinks[0].referenceStale).toBe(false);
    expect((await service.conversationContext('project', 'chat'))?.document).toBe('new saved document');
  });
  it('copies graph identities and planning documents without sessions, history or execution authority', async () => {
    await service.execute(create('a'), user);
    await seedPlanning(planning, 'project', { items: [{ id: 'item', revision: 0, title: 'Source', kind: 'requirement', body: 'document', status: 'draft', acceptance: [] }] }, { subprojectId: 'a' });
    const command: WorkflowCommand = { ...base, commandId: 'copy', subprojectId: 'a', type: 'subproject.copy', payload: { id: 'b', title: 'Copied' } };
    expect(await service.execute(command, user)).toMatchObject({ ok: true });
    expect(await service.execute(command, user)).toMatchObject({ ok: true, duplicate: true });
    const state = await snapshot(); expect(state.subprojects).toHaveLength(2);
    expect(state.subprojects[1].graph.nodes.some(node => state.subprojects[0].graph.nodes.some(source => source.id === node.id))).toBe(false);
    expect(state.subprojects[1].history).toEqual([]); expect(state.sessionLinks).toEqual([]); expect(state.runs).toEqual([]);
    expect(await planning.read('project', 'b')).toMatchObject({ ok: true, snapshot: { history: [], baselines: [], draft: { items: [{ body: 'document', status: 'review-needed' }] } } });
  });
  it('saves 반복 with a canonical zone, only on with a review AI, and starts a copy with it off', async () => {
    const repeatConsent = vi.fn<(projectId: string, subprojectId: string, change: WorkflowRepeatConsentChange) => Promise<void>>(async () => undefined);
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, repeatConsent });
    await service.execute(create('a'), user);
    const update = (commandId: string, expectedRevision: number, payload: Record<string, unknown>) => service.execute({ ...base, commandId, subprojectId: 'a', expectedRevision, type: 'subproject.update', payload } as WorkflowCommand, user);
    const daily = { cadence: 'daily', time: '09:00', timezone: 'US/Eastern', enabled: true };
    expect(await update('no-reviewer', 0, { repeat: daily })).toMatchObject({ ok: false, error: 'missing-reviewer' });
    expect(await update('bad-zone', 0, { repeat: { ...daily, timezone: 'Mars/Olympus' }, runSettings: { reviewer: { providerId: 'codex', model: 'm' } } })).toMatchObject({ ok: false, error: 'invalid-command' });
    // A bare offset is not a zone (the run bar sends the matching Etc zone instead).
    expect(await update('offset-zone', 0, { repeat: { ...daily, timezone: '+00:00' }, runSettings: { reviewer: { providerId: 'codex', model: 'm' } } })).toMatchObject({ ok: false, error: 'invalid-command' });
    expect(await update('on', 0, { repeat: daily, runSettings: { reviewer: { providerId: 'codex', model: 'm' } } })).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects[0].repeat).toEqual({ ...daily, timezone: 'America/New_York' });
    // Right after saving, the host records the person's consent for exactly the saved flow, and arms it then.
    const savedFlow = (await snapshot()).subprojects[0]!;
    expect(repeatConsent).toHaveBeenCalledOnce();
    // The person confirmed this flow: the schedule runs it (pinned) until they confirm another (decision 8).
    expect(repeatConsent).toHaveBeenCalledWith('project', 'a', { set: true, after: repeatContentDigest(savedFlow), config: repeatConfigDigest(savedFlow.repeat!), runnable: true,
      pinned: expect.objectContaining({ id: 'a', revision: savedFlow.revision, history: [], archivedNodes: [] }) });
    // Any other edit through this host moves that consent from the flow before it to the flow after it.
    expect(await update('rename', 1, { title: 'Renamed' })).toMatchObject({ ok: true });
    const renamed = (await snapshot()).subprojects[0]!;
    expect(repeatConsent).toHaveBeenLastCalledWith('project', 'a', { set: false, before: repeatContentDigest(savedFlow), after: repeatContentDigest(renamed), config: repeatConfigDigest(renamed.repeat!), runnable: true });
    // A command that leaves the flow as it was moves nothing; a consent the host cannot record leaves the flow saved (unconfirmed).
    repeatConsent.mockClear();
    repeatConsent.mockRejectedValueOnce(new Error('The repeat record cannot be read, so 반복 cannot be changed now.'));
    expect(await update('consent-fails', 2, { repeat: { ...daily, time: '10:00' } })).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects[0].repeat?.time).toBe('10:00');
    expect(repeatConsent).toHaveBeenCalledOnce();
    // Off: consent goes (no `after`) and nothing is armed.
    expect(await update('off', 3, { repeat: { ...daily, time: '10:00', enabled: false } })).toMatchObject({ ok: true });
    expect(repeatConsent).toHaveBeenLastCalledWith('project', 'a', expect.objectContaining({ set: true, runnable: false }));
    expect(repeatConsent.mock.calls.at(-1)![2]).not.toHaveProperty('after');
    // A weekly repeat names its weekday.
    expect(() => WorkflowCommandSchema.parse({ ...base, commandId: 'weekly', subprojectId: 'a', type: 'subproject.update', payload: { repeat: { ...daily, cadence: 'weekly' } } })).toThrow();
    expect(await service.execute({ ...base, commandId: 'copy-repeat', subprojectId: 'a', expectedRevision: 4, type: 'subproject.copy', payload: { id: 'b', title: 'Copied' } }, user)).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects.find(entry => entry.id === 'b')?.repeat).toMatchObject({ enabled: false, cadence: 'daily' });
  });
  it('answers each read with the repeat status of the registry it returns, and tells the schedule what it saved', async () => {
    const onCommitted = vi.fn();
    const repeatStatus = vi.fn((registry: { subprojects: readonly { id: string; repeat?: unknown }[] }) =>
      Object.fromEntries(registry.subprojects.filter(entry => entry.repeat).map(entry => [entry.id, { nextAt: '2026-10-26T00:00:00.000Z' }])));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, repeatStatus, onCommitted, repeatConsent: async () => undefined });
    expect(await service.repeatSources('project')).toEqual([]);
    await service.execute(create('a'), user);
    expect(onCommitted).toHaveBeenLastCalledWith('project');
    expect((await snapshot()).repeatStatus).toBeUndefined();
    const daily = { cadence: 'daily' as const, time: '09:00', timezone: 'Asia/Seoul', enabled: true };
    const saved = await service.execute({ ...base, commandId: 'on', subprojectId: 'a', expectedRevision: 0, type: 'subproject.update', payload: { repeat: daily, runSettings: { reviewer: { providerId: 'codex', model: 'm' } } } }, user);
    // The saving reply already carries the status of what it saved.
    expect(saved).toMatchObject({ ok: true, snapshot: { repeatStatus: { a: { nextAt: '2026-10-26T00:00:00.000Z' } } } });
    expect(onCommitted).toHaveBeenCalledTimes(2);
    expect(await service.repeatSources('project')).toEqual([{ subprojectId: 'a', revision: 1, status: 'active', repeat: daily, reviewer: { providerId: 'codex', model: 'm' },
      contentDigest: repeatContentDigest((await snapshot()).subprojects[0]!), pinnable: expect.objectContaining({ id: 'a', history: [], archivedNodes: [] }) }]);
    // A refused command saves nothing and tells nobody.
    await service.execute({ ...base, commandId: 'stale', subprojectId: 'a', expectedRevision: 0, type: 'subproject.update', payload: { title: 'Stale' } }, user);
    expect(onCommitted).toHaveBeenCalledTimes(2);
  });
  it('tells the repeat schedule what a recorded launch would run when it is replayed', async () => {
    let transient = true;
    const executeRun = vi.fn(async () => (transient ? { ok: false as const, error: 'unavailable', message: 'Provider down.', transient: true as const } : { ok: true as const }));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, executeRun, repeatConsent: async () => undefined });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const reviewer = { providerId: 'claude', model: 'model' };
    await service.execute({ ...base, commandId: 'settings', subprojectId: 'a', expectedRevision: 0, type: 'subproject.update', payload: { runSettings: { reviewer } } }, user);
    const schedule = { kind: 'schedule' as const, id: 'workflow-schedule' };
    const launch = { ...base, commandId: 'schedule-1', subprojectId: 'a', expectedRevision: 1, type: 'run.launch', payload: { runId: 'repeat-1' } } as WorkflowCommand;
    expect(await service.launchReceipt('project', 'schedule-1')).toEqual({ state: 'none' });
    expect(await service.execute(launch, schedule)).toMatchObject({ ok: false, error: 'execution-unavailable' });
    const saved = (await snapshot()).subprojects[0]!;
    expect(await service.launchReceipt('project', 'schedule-1')).toEqual({ state: 'pending', intent: launchIntentDigest(repeatContentDigest(saved), { runId: 'repeat-1', reviewer }) });
    transient = false;
    // A replay checked against another intent (the flow file changed after the schedule looked) runs nothing.
    executeRun.mockClear();
    expect(await service.execute(launch, schedule, { launchIntent: 'f'.repeat(64) })).toMatchObject({ ok: false, error: 'flow-changed' });
    expect(executeRun).not.toHaveBeenCalled();
    expect(await service.launchReceipt('project', 'schedule-1')).toMatchObject({ state: 'pending' });
    expect(await service.execute(launch, schedule, { launchIntent: launchIntentDigest(repeatContentDigest(saved), { runId: 'repeat-1', reviewer }) })).toMatchObject({ ok: true });
    expect(await service.launchReceipt('project', 'schedule-1')).toEqual({ state: 'settled' });
    // A first launch is checked the same way, before its receipt is written.
    const next = { ...launch, commandId: 'schedule-2', expectedRevision: 1, payload: { runId: 'repeat-2' } } as WorkflowCommand;
    expect(await service.execute(next, schedule, { launchIntent: 'e'.repeat(64) })).toMatchObject({ ok: false, error: 'flow-changed' });
    expect(await service.launchReceipt('project', 'schedule-2')).toEqual({ state: 'none' });
  });
  it('runs the confirmed flow for the repeat schedule, not an edit saved after it (decision 8)', async () => {
    const executeRun = vi.fn<NonNullable<ConstructorParameters<typeof WorkflowService>[0]['executeRun']>>(async () => ({ ok: true as const }));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, executeRun, repeatConsent: async () => undefined });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research the confirmed thing', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const reviewer = { providerId: 'claude', model: 'model' };
    await service.execute({ ...base, commandId: 'settings', subprojectId: 'a', expectedRevision: 0, type: 'subproject.update', payload: { runSettings: { reviewer } } }, user);
    const confirmed = repeatPin((await snapshot()).subprojects[0]!);
    const edited = structuredClone(graph); edited.nodes[0] = { ...edited.nodes[0]!, instructions: 'Something else entirely' };
    expect(await service.execute({ ...base, commandId: 'later-edit', subprojectId: 'a', expectedRevision: 1, type: 'workflow.patch', payload: { graph: edited, summary: 'Edit' } }, user)).toMatchObject({ ok: true });
    const schedule = { kind: 'schedule' as const, id: 'workflow-schedule' };
    const launch = { ...base, commandId: 'schedule-pinned', subprojectId: 'a', expectedRevision: 2, type: 'run.launch', payload: { runId: 'repeat-pinned' } } as WorkflowCommand;
    expect(await service.execute(launch, schedule, { launchIntent: launchIntentDigest(repeatContentDigest(confirmed), { runId: 'repeat-pinned', reviewer }), pinned: confirmed })).toMatchObject({ ok: true });
    const ran = executeRun.mock.calls[0]![1] as WorkflowSubproject;
    expect(ran.graph.nodes[0]!.instructions).toBe('Research the confirmed thing');
    // A person's own launch runs the flow as saved now.
    expect(await service.execute({ ...launch, commandId: 'person-launch', payload: { runId: 'person-run' } } as WorkflowCommand, user)).toMatchObject({ ok: true });
    expect((executeRun.mock.calls[1]![1] as WorkflowSubproject).graph.nodes[0]!.instructions).toBe('Something else entirely');
  });
  it('lets the repeat schedule run a flow and nothing else', async () => {
    await service.execute(create('a'), user);
    const schedule = { kind: 'schedule' as const, id: 'workflow-schedule' };
    expect(await service.execute({ ...base, commandId: 'by-schedule', subprojectId: 'a', type: 'subproject.update', payload: { title: 'Renamed' } }, schedule)).toMatchObject({ ok: false, error: 'user-required' });
    expect(await service.execute({ ...base, commandId: 'by-schedule-approve', subprojectId: 'a', type: 'run.approve', payload: { runId: 'run-1', activationId: 'x', decision: 'approve' } } as WorkflowCommand, schedule)).toMatchObject({ ok: false, error: 'user-required' });
  });
  it('reserves run intent before a side effect and rejects changed retries after a lost commit', async () => {
    const executeRun = vi.fn(async () => ({ ok: true as const }));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, executeRun });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const originalRename = fs.rename.bind(fs); let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { calls++; if (calls === 2) throw new Error('disk unavailable after run'); return originalRename(...args); });
    const command: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'prepare', type: 'run.prepare', payload: { runId: 'run', reviewer: { providerId: 'claude', model: 'model' } } };
    expect(await service.execute(command, user)).toMatchObject({ ok: false }); expect(executeRun).toHaveBeenCalledTimes(1);
    expect(await service.execute({ ...command, payload: { ...command.payload, runId: 'changed' } }, user)).toMatchObject({ ok: false, error: 'command-conflict' });
    expect(await service.execute(command, { ...user, id: 'different' })).toMatchObject({ ok: false, error: 'command-conflict' });
    await service.execute({ ...base, commandId: 'invalid-next-draft', subprojectId: 'a', type: 'workflow.patch', payload: { graph: createWorkflowGraph('custom', 'a'), summary: 'next draft incomplete' } }, user);
    expect((await service.execute(command, user)).ok).toBe(true); expect(executeRun).toHaveBeenCalledTimes(2);
    // The execution adapter receives exactly the same command/graph, allowing its durable receipt to reconcile.
    expect(executeRun.mock.calls[0]).toEqual(executeRun.mock.calls[1]);
  });
  it('replays a phone’s pending run command after the phone updated from a v16 to a v17 connection', async () => {
    const executeRun = vi.fn<(...args: unknown[]) => Promise<{ ok: true }>>(async () => ({ ok: true as const }));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, executeRun });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const originalRename = fs.rename.bind(fs); let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { calls++; if (calls === 2) throw new Error('reply lost'); return originalRename(...args); });
    const command: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'phone-prepare', type: 'run.prepare', payload: { runId: 'run', reviewer: { providerId: 'claude', model: 'model' } } };
    const phone = { kind: 'android' as const, id: 'android:phone' };
    expect(await service.execute(command, { ...phone, reducedFlowView: true })).toMatchObject({ ok: false });
    // The same phone, updated, retries the same command: same request, not a conflict.
    expect(await service.execute(command, phone)).toMatchObject({ ok: true });
    expect(executeRun.mock.calls[1]![0]).toEqual(executeRun.mock.calls[0]![0]);
  });
  it('answers ownership from the committed file while a run command holds the workflow gate', async () => {
    // The execution service checks ownership under its own gate; a run command holds this gate while it
    // waits for that one. A gated read here would wait forever.
    let ownedDuringRun: boolean | undefined; let gatedDuringRun: 'answered' | 'waiting' | undefined; let writableDuringRun: boolean | undefined;
    const executeRun = vi.fn(async () => {
      ownedDuringRun = await service.ownsCommitted('project', 'a', true);
      // The daemon asks these while the pump submits a stage or review prompt under the execution gate.
      writableDuringRun = await service.conversationWritable('project', 'chat');
      expect(await service.conversationContext('project', 'chat')).toBeUndefined();
      gatedDuringRun = await Promise.race([service.owns('project', 'a').then(() => 'answered' as const), new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50))]);
      return { ok: true as const };
    });
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [], session: () => undefined, executeRun });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const command: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'prepare', type: 'run.prepare', payload: { runId: 'run', reviewer: { providerId: 'claude', model: 'model' } } };
    expect(await service.execute(command, user)).toMatchObject({ ok: true });
    expect(ownedDuringRun).toBe(true);
    expect(writableDuringRun).toBe(true);
    expect(gatedDuringRun).toBe('waiting');
    expect(await service.ownsCommitted('project', 'missing')).toBe(false);
    expect(await service.execute({ ...base, commandId: 'archive', subprojectId: 'a', expectedRevision: 0, type: 'subproject.update', payload: { status: 'archived' } }, user)).toMatchObject({ ok: true });
    expect(await service.ownsCommitted('project', 'a')).toBe(true);
    expect(await service.ownsCommitted('project', 'a', true)).toBe(false);
  });
  it('refuses a registry another writer replaced, also for gate-free reads', async () => {
    expect((await service.execute(create('a'), user)).ok).toBe(true);
    expect(await service.ownsCommitted('project', 'a')).toBe(true);
    // A different, internally valid registry written by someone else.
    const file = path.join(directory, '.ezterminal', 'planning', 'workflows.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { registry: { subprojects: { title: string }[] }; receipts: unknown[]; integrity: string };
    stored.registry.subprojects[0]!.title = 'Changed elsewhere';
    stored.integrity = workflowDigest({ registry: stored.registry, receipts: stored.receipts });
    await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}
`);
    expect(await service.read('project')).toMatchObject({ ok: false, error: 'external-change' });
    expect(await service.ownsCommitted('project', 'a')).toBe(false);
    expect(await service.conversationWritable('project', 'chat')).toBe(false);
    await expect(service.conversationContext('project', 'chat')).rejects.toThrow(/changed outside/u);
  });
  it('keeps a stage’s effort through copy and undo, and refuses v16 phone edits that would drop or change it', async () => {
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0]!, reasoningEffort: 'high' };
    expect((await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user)).ok).toBe(true);
    expect((await service.execute({ ...create('b'), expectedRevision: 1 }, user)).ok).toBe(true);
    const phone = { kind: 'android' as const, id: 'android:phone', reducedFlowView: true as const };
    const seen = async (id: string) => { const result = legacyWorkflowResult(await service.read('project')); if (!result.ok) throw new Error(result.message); return result.snapshot.subprojects.find(entry => entry.id === id)!; };
    // What a v16 phone sees has no effort; saving that graph back would erase it.
    const reduced = await seen('a'); expect(JSON.stringify(reduced.graph)).not.toContain('reasoningEffort');
    const moved = { ...reduced.graph, nodes: reduced.graph.nodes.map((node, index) => index === 1 ? { ...node, position: { x: 999, y: 9 } } : node) };
    expect(await service.execute({ ...base, commandId: 'phone-move', subprojectId: 'a', type: 'workflow.patch', payload: { graph: moved, summary: 'move' } }, phone)).toMatchObject({ ok: false, error: 'unsupported' });
    // A flow without v17 fields stays editable from the old phone.
    const plain = await seen('b');
    expect(await service.execute({ ...base, commandId: 'phone-edit-b', subprojectId: 'b', type: 'workflow.patch', payload: { graph: { ...plain.graph, nodes: plain.graph.nodes.map((node, index) => index === 0 ? { ...node, title: 'Renamed' } : node) }, summary: 'rename' } }, phone)).toMatchObject({ ok: true });
    // Deleting the stage that carries the effort keeps it intact among removed stages.
    const without = { ...reduced.graph, entryNodeId: reduced.graph.entryNodeId === graph.nodes[0]!.id ? reduced.graph.nodes[1]!.id : reduced.graph.entryNodeId,
      nodes: reduced.graph.nodes.slice(1), edges: reduced.graph.edges.filter(edge => edge.from !== graph.nodes[0]!.id && edge.to !== graph.nodes[0]!.id) };
    expect(await service.execute({ ...base, commandId: 'phone-delete', subprojectId: 'a', type: 'workflow.patch', payload: { graph: without, summary: 'delete' } }, phone)).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects.find(entry => entry.id === 'a')!.archivedNodes[0]).toMatchObject({ id: graph.nodes[0]!.id, reasoningEffort: 'high' });
    // Undo restores it on the desktop; an old phone may not undo an effort change it cannot see.
    const restore = await service.execute({ ...base, expectedRevision: 1, commandId: 'desktop-undo', subprojectId: 'a', type: 'workflow.undo', payload: { changeId: 'phone-delete' } }, user);
    expect(restore).toMatchObject({ ok: true });
    const restored = (await snapshot()).subprojects.find(entry => entry.id === 'a')!;
    expect(restored.graph.nodes.find(node => node.id === graph.nodes[0]!.id)).toMatchObject({ reasoningEffort: 'high' });
    const raised = { ...restored.graph, nodes: restored.graph.nodes.map(node => node.id === graph.nodes[0]!.id ? { ...node, reasoningEffort: 'max' } : node) };
    expect(await service.execute({ ...base, expectedRevision: 2, commandId: 'desktop-max', subprojectId: 'a', type: 'workflow.patch', payload: { graph: raised, summary: 'max' } }, user)).toMatchObject({ ok: true });
    expect(await service.execute({ ...base, expectedRevision: 3, commandId: 'phone-undo', subprojectId: 'a', type: 'workflow.undo', payload: { changeId: 'desktop-max' } }, phone)).toMatchObject({ ok: false, error: 'unsupported' });
    // Copies keep it.
    expect(await service.execute({ ...base, expectedRevision: 3, commandId: 'copy-a', subprojectId: 'a', type: 'subproject.copy', payload: { id: 'c', title: 'Copy' } }, user)).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects.find(entry => entry.id === 'c')!.graph.nodes.some(node => node.reasoningEffort === 'max')).toBe(true);
  });
  it('lets a v16 phone create from a creation preview it sees without effort, keeping the effort', async () => {
    const graph = createWorkflowGraph('research', 'p'); graph.nodes[0] = { ...graph.nodes[0]!, reasoningEffort: 'high' };
    expect(await service.preview({ action: 'open', projectId: 'project', sessionId: 'chat', previewId: 'preview-p', graph })).toMatchObject({ ok: true });
    const read = legacyWorkflowPreviewResult(await service.preview({ action: 'read', projectId: 'project', previewId: 'preview-p' }));
    if (!read.ok || !read.preview) throw new Error('preview missing');
    expect(JSON.stringify(read.preview.graph)).not.toContain('reasoningEffort');
    const create = (principal: { kind: 'android'; id: string; reducedFlowView?: true }, commandId: string): Promise<unknown> => service.execute({ ...base, commandId, type: 'subproject.create',
      payload: { id: 'p', title: 'From preview', goal: '', presetId: 'research', graph: read.preview!.graph, previewId: 'preview-p', previewRevision: read.preview!.revision } }, principal);
    // A v17 client must confirm the exact preview; the reduced one is only accepted from a v16 reader.
    expect(await create({ kind: 'android', id: 'android:new' }, 'create-new')).toMatchObject({ ok: false, error: 'preview-conflict' });
    expect(await create({ kind: 'android', id: 'android:old', reducedFlowView: true }, 'create-old')).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects.find(entry => entry.id === 'p')!.graph.nodes[0]).toMatchObject({ reasoningEffort: 'high' });
  });
  it('lets a project conversation run its flow while approvals, integration and 자동 승인 stay with the person', async () => {
    const executeRun = vi.fn(async () => ({ ok: true as const }));
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => [],
      session: id => id === 'chat' ? { projectId: 'project', managed: false } : undefined, executeRun });
    const graph = createWorkflowGraph('research', 'a'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'claude', model: 'model', instructions: 'Research', acceptance: ['Report evidence'] };
    await service.execute({ ...create('a'), payload: { ...create('a').payload, graph } }, user);
    const agent = { kind: 'ai' as const, id: 'agent', sessionId: 'chat' };
    const prepare: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'agent-prepare', expectedRevision: 0, type: 'run.prepare', payload: { runId: 'run', reviewer: { providerId: 'claude', model: 'model' } } };
    expect((await service.execute(prepare, agent)).ok).toBe(true);
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ type: 'run.prepare' }), expect.anything(), agent);
    const approve: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'agent-approve', expectedRevision: 0, type: 'run.approve', payload: { runId: 'run', activationId: 'x', decision: 'approve' } };
    expect(await service.execute(approve, agent)).toMatchObject({ ok: false, error: 'user-required' });
    const autoApprove: WorkflowCommand = { ...base, subprojectId: 'a', commandId: 'agent-auto', expectedRevision: 0, type: 'subproject.update', payload: { autoApprove: true } };
    expect(await service.execute(autoApprove, agent)).toMatchObject({ ok: false, error: 'user-required' });
    expect((await service.execute({ ...autoApprove, commandId: 'person-auto' }, user)).ok).toBe(true);
    expect((await snapshot()).subprojects[0]).toMatchObject({ autoApprove: true });
  });
  it('puts a run’s stage and review agents under their stage in the project list', async () => {
    let runs: unknown[] = [];
    service = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning, runs: () => runs as never, session: () => undefined });
    await service.execute(create('a'), user);
    const first = await service.navigation('project');
    expect(first.ok && first.snapshot.sessionLinks).toEqual([]);
    runs = [{ runId: 'run', preparation: { subprojectId: 'a', workflow: { subprojectId: 'a', graph: { nodes: [{ id: 'a:research' }] } } },
      attempts: [{ attemptId: 'attempt', taskId: 'a:research', sessionId: 'planning-attempt' }], reviews: [{ attemptId: 'attempt', reviewerSessionId: 'planning-review' }] }];
    // Runs change without the registry file: the projection follows them.
    const second = await service.navigation('project');
    expect(second.ok && second.snapshot.sessionLinks).toEqual([
      { sessionId: 'planning-attempt', subprojectId: 'a', nodeId: 'a:research', scope: 'stage' },
      { sessionId: 'planning-review', subprojectId: 'a', nodeId: 'a:research', scope: 'stage' },
    ]);
  });
  it('reconciles a copied planning file after the registry response is lost without copying later source edits', async () => {
    await service.execute(create('a'), user);
    const originalRename = fs.rename.bind(fs); let count = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { count++; if (count === 3) throw new Error('Lost copied registry commit'); return originalRename(...args); });
    const command: WorkflowCommand = { ...base, commandId: 'copy-lost', subprojectId: 'a', type: 'subproject.copy', payload: { id: 'b', title: 'Copy' } };
    expect(await service.execute(command, user)).toMatchObject({ ok: false });
    expect(await service.execute({ ...command, payload: { ...command.payload, title: 'Changed request' } }, user)).toMatchObject({ ok: false, error: 'command-conflict' });
    expect(await service.execute(command, user)).toMatchObject({ ok: true });
    expect((await snapshot()).subprojects.map(value => value.id)).toEqual(['a', 'b']);
    expect(await planning.read('project', 'b')).toMatchObject({ ok: true, snapshot: { baselines: [], history: [], revision: 0 } });
  });
});
