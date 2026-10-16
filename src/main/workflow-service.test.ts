import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowService } from './workflow-service';
import { PlanningService } from './planning-service';
import { createWorkflowGraph, type WorkflowCommand, type WorkflowSnapshot } from '../shared/workflow';

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
    await planning.execute({ projectId: 'project', commandId: 'legacy', actor: { kind: 'user', id: 'u' }, expectedRevision: 0, type: 'planning.patch', payload: { summary: 'legacy', operations: [{ op: 'item.put', value: { id: 'item', revision: 0, title: 'old', kind: 'requirement', body: 'record', status: 'ready', acceptance: [] } }] } });
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
    await planning.execute({ projectId: 'project', commandId: 'legacy', actor: { kind: 'user', id: 'u' }, expectedRevision: 0, type: 'planning.patch', payload: { summary: 'legacy', operations: [{ op: 'item.put', value: { id: 'item', revision: 0, title: 'old', kind: 'requirement', body: 'record', status: 'ready', acceptance: [] } }] } });
    await planning.execute({ projectId: 'project', commandId: 'legacy-freeze', actor: { kind: 'user', id: 'u' }, expectedRevision: 1, type: 'planning.freeze', payload: { baselineId: 'old-baseline', title: 'Old baseline' } });
    const source = path.join(directory, '.ezterminal', 'planning', 'project.json'); const before = await fs.readFile(source);
    const migrated = await snapshot(); expect(migrated.subprojects[0].id).toBe('legacy-default');
    expect((await service.execute(create('a'), user)).ok).toBe(true);
    expect(await fs.readFile(source)).toEqual(before);
    expect((await fs.readdir(path.dirname(source))).filter(name => name.includes('workflow-backup')).length).toBe(1);
    expect(migrated.legacyBaselineOwners['old-baseline']).toBe('legacy-default');
    expect(await planning.execute({ projectId: 'project', commandId: 'legacy-freeze', actor: { kind: 'user', id: 'u' }, expectedRevision: 1, type: 'planning.freeze', payload: { baselineId: 'old-baseline', title: 'Old baseline' } })).toMatchObject({ ok: true, duplicate: true });
    await planning.execute({ projectId: 'project', commandId: 'later-freeze', actor: { kind: 'user', id: 'u' }, expectedRevision: 2, type: 'planning.freeze', payload: { baselineId: 'later-baseline', title: 'Later baseline' } });
    expect((await snapshot()).legacyBaselineOwners['later-baseline']).toBe('legacy-default');
    await planning.execute({ projectId: 'project', commandId: 'quick-freeze', actor: { kind: 'user', id: 'u' }, expectedRevision: 3, type: 'planning.quick-freeze', payload: { baselineId: 'quick', title: 'Quick', profileIds: [], task: { id: 'quick-task', revision: 0, title: 'Quick', objective: 'Check one thing', featureIds: [], screenIds: [], inputRefs: [], dependencyIds: [], allowedPaths: [], interfaceRefs: [], acceptance: [{ id: 'ac', description: 'Checked' }], validationPlan: [{ id: 'v', acceptanceIds: ['ac'], description: 'Inspect', method: 'inspection', environment: 'Host' }], status: 'ready' } } });
    expect((await snapshot()).legacyBaselineOwners.quick).toBeNull();
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
    await planning.execute({ projectId: 'project', subprojectId: 'a', commandId: 'doc', actor: { kind: 'user', id: 'u' }, expectedRevision: 0, type: 'planning.patch', payload: { summary: 'source', operations: [{ op: 'item.put', value: { id: 'item', revision: 0, title: 'Source', kind: 'requirement', body: 'document', status: 'draft', acceptance: [] } }] } });
    const command: WorkflowCommand = { ...base, commandId: 'copy', subprojectId: 'a', type: 'subproject.copy', payload: { id: 'b', title: 'Copied' } };
    expect(await service.execute(command, user)).toMatchObject({ ok: true });
    expect(await service.execute(command, user)).toMatchObject({ ok: true, duplicate: true });
    const state = await snapshot(); expect(state.subprojects).toHaveLength(2);
    expect(state.subprojects[1].graph.nodes.some(node => state.subprojects[0].graph.nodes.some(source => source.id === node.id))).toBe(false);
    expect(state.subprojects[1].history).toEqual([]); expect(state.sessionLinks).toEqual([]); expect(state.runs).toEqual([]);
    expect(await planning.read('project', 'b')).toMatchObject({ ok: true, snapshot: { history: [], baselines: [], draft: { items: [{ body: 'document', status: 'review-needed' }] } } });
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
