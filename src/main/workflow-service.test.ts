import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowService, workflowDigest } from './workflow-service';
import { PlanningService } from './planning-service';
import { createWorkflowGraph, type WorkflowCommand, type WorkflowSnapshot } from '../shared/workflow';
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
