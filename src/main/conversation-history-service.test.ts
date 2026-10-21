import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonCommand, type DaemonCommandType } from '../shared/daemon-protocol';
import type { AgentTranscriptPage } from '../shared/agent-history';
import { createWorkflowGraph } from '../shared/workflow';
import type { AgentProviderAdapter, ProviderProbeResult } from './agent-provider-adapter';
import type { AgentHistoryProviderAdapter, ProviderHistorySession } from './agent-history-provider';
import { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';
import { AgentProviderRegistry, createProviderReviewDigest } from './agent-provider-registry';
import { ConversationHistoryService } from './conversation-history-service';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore, type DaemonTranscriptItemInput } from './daemon-store';
import { PlanningService } from './planning-service';
import { WorkflowService } from './workflow-service';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const now = () => new Date('2026-10-14T00:00:00.000Z');

async function harness(providerId: 'codex' | 'claude' = 'codex') {
  // The project store keeps real paths and the app syncs those to the daemon, so the fixture
  // must not hand the daemon an 8.3 alias of TEMP (as it is on the CI runner).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ez-unified-history-')));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  const probe: ProviderProbeResult = { providerId, displayName: providerId, protocol: providerId === 'codex' ? 'codex-app-server' : 'claude-agent-sdk',
    available: true, executablePath: path.join(directory, 'provider.exe'), executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: ['create', 'resume'] };
  const provider: AgentProviderAdapter = { providerId, probe: vi.fn(async () => probe), listModels: vi.fn(async () => []),
    createSession: vi.fn(async input => ({ ...input, providerSessionId: 'created-provider-session' })),
    resumeSession: vi.fn(async input => ({ ...input })), submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
    setSettings: vi.fn(async input => ({ ...input, permissionPreset: input.permissionPreset ?? 'standard' })), resolveApproval: vi.fn(async () => undefined),
    subscribe: () => () => undefined, reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })), disposeSession: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
  const store = new DaemonStore(path.join(directory, 'daemon'), { now }); await store.init();
  cleanups.push(() => store.close());
  const registry = new AgentProviderRegistry([provider]);
  const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({ providers: registry, getSnapshot: () => daemon.getSnapshot(),
    applySystemCommit: commit => daemon.applySystemCommit(commit), applySystemTransition: transition => daemon.applySystemTransition(transition),
    readTranscript: (sessionId, after, limit) => store.getTranscript(sessionId, after, limit), findCommand: id => store.findCommand(id)?.command, now });
  const daemon: DaemonCommandRouter = new DaemonCommandRouter(store, { handlers: runtime.handlers() }); await runtime.start(); cleanups.push(() => runtime.dispose());
  let commandSequence = 0;
  const execute = async <T extends DaemonCommandType>(type: T, payload: Parameters<typeof createDaemonCommand<T>>[0]['payload']) => {
    const id = `test-${++commandSequence}`;
    const result = await daemon.execute(createDaemonCommand({ commandId: id, idempotencyKey: id, expectedRevision: store.getRevision(), issuedAt: now().toISOString(), principal: { kind: 'desktop', id: 'test' }, type, payload }));
    await runtime.whenIdle(); expect(result.ok, JSON.stringify(result)).toBe(true); return result;
  };
  await execute('project.create', { projectId: 'project', name: 'Example', rootPath: root });
  await execute('workspace.create', { workspaceId: 'workspace', projectId: 'project', name: 'Local', rootPath: root, kind: 'local' });
  await registry.inspect(providerId);
  await execute('provider.enable', { providerId, displayName: providerId, protocol: probe.protocol, executablePath: probe.executablePath,
    executableVersion: probe.executableVersion, argv: [], environmentVariableNames: [], capabilities: probe.capabilities, reviewDigest: createProviderReviewDigest(probe) });
  const providerSessionId = 'c43f20cf-1111-4222-8333-000000000001';
  const source: ProviderHistorySession = { privateId: providerId === 'claude' ? path.join(root, `${providerSessionId}.jsonl`) : providerSessionId,
    parentPrivateId: null, title: 'Native task', preview: 'Old question', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000,
    cwd: root, roots: [root], source: 'cli', rolloutPath: null };
  const longText = `  한글 ${'long text '.repeat(4_000)} end  `;
  const turn = (id: string, text: string): AgentTranscriptPage['turns'][number] => ({ id, status: 'completed', entries: [{ type: 'message', id: `item-${id}`, role: id === 'old' ? 'user' : 'assistant', markdown: text }] });
  const pages: Record<string, AgentTranscriptPage> = {
    latest: { historyId: '', provider: providerId, turns: [turn('middle', 'middle'), turn('new', 'new')], nextCursor: 'older' },
    older: { historyId: '', provider: providerId, turns: [turn('old', longText), turn('middle', 'middle')], nextCursor: null },
  };
  const adapter: AgentHistoryProviderAdapter = { provider: providerId, listSessions: vi.fn(async () => ({ items: [source], nextCursor: null })),
    resolveProviderSessionId: privateId => privateId === source.privateId ? providerSessionId : null,
    readTranscript: vi.fn(async () => pages.latest), readTranscriptForAdoption: vi.fn(async (_id, cursor) => pages[cursor ?? 'latest']),
    buildResumeCommand: () => null, dispose: async () => undefined };
  const projectStore = new AgentProjectStore(path.join(directory, 'history')); await projectStore.init();
  const history = new AgentHistoryService(projectStore, [adapter]);
  expect((await history.saveProject({ name: 'Example', primaryRoot: root, additionalRoots: [], pinned: false })).ok).toBe(true);
  const workflow = new WorkflowService({ hostId: 'host', resolveProjectRoot: id => id === 'project' ? root : null,
    planning: new PlanningService({ resolveProjectRoot: () => root }), runs: () => [], continuationSource: id => store.pendingConversationSource(id),
    session: id => daemon.getSnapshot().sessions.some(item => item.id === id) ? { projectId: 'project', managed: false } : undefined });
  const service = new ConversationHistoryService({ history, daemon, store, runtime, workflow: id => workflow.navigation(id),
    continueWorkflow: (projectId, from, to) => workflow.continueConversation(projectId, from, to), now });
  const first = async () => { const result = await service.listConversations(); if (!result.ok) throw new Error(result.message); return result.items[0]!; };
  const request = async (commandId = 'resume-1') => {
    const entry = await first(); const prepared = await service.prepareHistoryResume({ conversationId: entry.conversationId, model: 'current-model', permissionPreset: 'plan' });
    if (!prepared.ok || !prepared.canResume) throw new Error(JSON.stringify(prepared));
    return { conversationId: entry.conversationId, revision: prepared.revision, model: 'current-model', permissionPreset: 'plan' as const, commandId };
  };
  return { directory, root, providerId, providerSessionId, provider, store, daemon, runtime, registry, execute, history, adapter, source, pages, longText, workflow, service, first, request };
}

describe('unified conversation history', () => {
  it('retains one conversation identity and all aliases through adoption and continuation', async () => {
    const h = await harness(); const native = await h.first();
    await h.service.readConversation(native.conversationId);
    expect(h.provider.resumeSession).not.toHaveBeenCalled();
    const adopted = await h.service.resumeHistory(await h.request()); if (!adopted.ok) throw new Error(adopted.message);
    await h.runtime.whenIdle();
    await h.execute('agent.archive', { sessionId: adopted.sessionId });
    const prepared = await h.service.prepareHistoryResume({ conversationId: native.conversationId });
    if (!prepared.ok) throw new Error(prepared.message);
    const continued = await h.service.resumeHistory({ conversationId: native.conversationId, revision: prepared.revision, commandId: 'continue-again' }); if (!continued.ok) throw new Error(continued.message);
    await h.runtime.whenIdle();
    const page = await h.service.listConversations({ archived: 'include' });
    expect(page).toMatchObject({ ok: true, items: [{ conversationId: native.conversationId, linkedSessionId: continued.sessionId,
      sessionAliases: expect.arrayContaining([adopted.sessionId, continued.sessionId]) }] });
    if (!page.ok) throw new Error(page.message);
    expect(page.items).toHaveLength(1);
    expect(await h.service.resolveConversation({ kind: 'session', id: adopted.sessionId })).toMatchObject({ ok: true, entry: { conversationId: native.conversationId, linkedSessionId: continued.sessionId } });
    const before = await h.service.readConversation(native.conversationId);
    expect(before.ok).toBe(true);
  });
  it('continues a stopped conversation with the effort and permission it last ran with', async () => {
    const h = await harness(); const native = await h.first();
    const adopted = await h.service.resumeHistory(await h.request()); if (!adopted.ok) throw new Error(adopted.message);
    await h.runtime.whenIdle();
    await h.execute('agent.set-settings', { sessionId: adopted.sessionId, permissionPreset: 'full-access', reasoningEffort: 'high' });
    await h.execute('agent.archive', { sessionId: adopted.sessionId });
    // No overrides: the continuation must not fall back to defaults.
    const prepared = await h.service.prepareHistoryResume({ conversationId: native.conversationId }); if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared).toMatchObject({ model: 'current-model', permissionPreset: 'full-access' });
    expect(prepared).not.toHaveProperty('reasoningEffort');
    const continued = await h.service.resumeHistory({ conversationId: native.conversationId, revision: prepared.revision, commandId: 'continue-settings' });
    if (!continued.ok) throw new Error(continued.message);
    await h.runtime.whenIdle();
    expect(h.daemon.getSnapshot().agents.find((agent) => agent.sessionId === continued.sessionId))
      .toMatchObject({ model: 'current-model', permissionPreset: 'full-access', reasoningEffort: 'high' });
  });

  it('lists a subagent chat only through its parent, until it is detached', async () => {
    const h = await harness();
    const chat = (id: string) => [
      { kind: 'session.upsert' as const, value: { id, projectId: 'project', workspaceId: 'workspace', kind: 'agent' as const, title: id, state: 'completed' as const, source: 'structured' as const } },
      { kind: 'agent.upsert' as const, value: { sessionId: id, providerId: 'codex', permissionPreset: 'standard' as const, state: 'done' as const, queuedTurnCount: 0, orchestrationEnabled: true } },
    ];
    const child = (id: string, owner: 'managed' | 'provider-native', detachedAt?: string) => ({ kind: 'agent-relation.upsert' as const,
      value: { id: `relation-${id}`, treeId: 'parent', parentSessionId: 'parent', childSessionId: id, owner, depth: 1, ...(detachedAt ? { detachedAt } : {}) } });
    await h.daemon.applySystemCommit({ mutations: [...chat('parent'), ...chat('native-child'), ...chat('managed-child'), ...chat('detached-child'),
      child('native-child', 'provider-native'), child('managed-child', 'managed'), child('detached-child', 'managed', now().toISOString())] });
    const page = await h.service.listConversations({ source: 'app', archived: 'include' }); if (!page.ok) throw new Error(page.message);
    expect(page.items.map(entry => entry.linkedSessionId).sort()).toEqual(['detached-child', 'parent']);
  });

  it('keeps complete interleaved message groups across backwards page boundaries', async () => {
    const h = await harness(); const result = await h.service.resumeHistory(await h.request()); if (!result.ok) throw new Error(result.message); await h.runtime.whenIdle();
    const base = { sessionId: result.sessionId, kind: 'assistant-message' as const, isSensitive: false, createdAt: now().toISOString() };
    await h.daemon.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [
      { ...base, id: 'a-first', messageId: 'a', text: 'A', isDelta: false },
      { ...base, id: 'b', messageId: 'b', text: 'B', isDelta: false },
      { ...base, id: 'a-last', messageId: 'a', text: 'C', isDelta: true },
    ] }] });
    const latest = h.store.getConversationTranscript(result.sessionId, undefined, 1); expect(latest.items.map(item => item.text)).toEqual(['B']);
    const previous = h.store.getConversationTranscript(result.sessionId, Number(latest.nextCursor), 1); expect(previous.items.map(item => item.text)).toEqual(['AC']);
    expect(h.store.getConversationPreview(result.sessionId)).toBe('AC');
  });

  it('recovers a pending stage continuation from the durable command without importing or resuming twice', async () => {
    const h = await harness(); const imported = await h.service.resumeHistory(await h.request()); if (!imported.ok) throw new Error(imported.message); await h.runtime.whenIdle();
    const envelope = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    expect((await h.workflow.execute({ ...envelope, commandId: 'create', type: 'subproject.create', payload: { id: 'sub', title: 'Saved stage', goal: '', presetId: 'research' } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    expect((await h.workflow.execute({ ...envelope, commandId: 'link', subprojectId: 'sub', type: 'session.link', payload: { sessionId: imported.sessionId, scope: 'stage', nodeId: 'sub:research' } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    await h.execute('agent.archive', { sessionId: imported.sessionId });
    const rows = await h.service.listConversations({ archived: 'include' }); if (!rows.ok) throw new Error(rows.message);
    const prepared = await h.service.prepareHistoryResume({ conversationId: rows.items[0].conversationId }); if (!prepared.ok) throw new Error(prepared.message);
    const request = { conversationId: rows.items[0].conversationId, revision: prepared.revision, commandId: 'continued-with-gap' };
    const continueWorkflow = vi.fn().mockResolvedValueOnce({ ok: false, message: 'Simulated file write interruption.' })
      .mockImplementation((projectId: string, from: string, to: string) => h.workflow.continueConversation(projectId, from, to));
    const service = new ConversationHistoryService({ history: h.history, daemon: h.daemon, store: h.store, runtime: h.runtime,
      workflow: id => h.workflow.navigation(id), continueWorkflow });
    expect(await service.resumeHistory(request)).toMatchObject({ ok: false, reason: 'conflict' }); await h.runtime.whenIdle();
    const target = h.daemon.getSnapshot().agents.find(agent => agent.providerSessionId === h.providerSessionId)!;
    expect(h.store.pendingConversationSource(target.sessionId)).toBe(imported.sessionId);
    expect(await h.workflow.conversationContext('project', target.sessionId)).toEqual(await h.workflow.conversationContext('project', imported.sessionId));
    expect(await service.listConversations()).toMatchObject({ ok: true, items: [expect.objectContaining({ linkedSessionId: target.sessionId, subprojectId: 'sub' })] });
    expect(await service.resumeHistory(request)).toMatchObject({ ok: true, sessionId: target.sessionId, alreadyLinked: true });
    expect(h.store.pendingConversationSource(target.sessionId)).toBeUndefined();
    expect(h.provider.resumeSession).toHaveBeenCalledTimes(2); // original adoption + one continuation, no retry resume.
    expect(h.store.getTranscript(target.sessionId).map(item => item.text)).toEqual([h.longText, 'middle', 'new']);
    const navigation = await h.workflow.navigation('project'); expect(JSON.stringify(navigation)).not.toMatch(/referenceSnapshot|instructions|"graph"|"runs"/u);
  });
  it.each(['codex', 'claude'] as const)('adopts %s with its original provider identity and complete chronological messages, once across restart', async providerId => {
    const h = await harness(providerId); const entry = await h.first();
    expect(entry).toMatchObject({ source: 'native', projectId: 'project', action: 'resume' });
    expect(JSON.stringify(entry)).not.toContain(h.providerSessionId);
    expect(h.adapter.readTranscript).not.toHaveBeenCalled(); expect(h.adapter.readTranscriptForAdoption).not.toHaveBeenCalled();
    const request = await h.request(); const result = await h.service.resumeHistory(request); if (!result.ok) throw new Error(result.message);
    await h.runtime.whenIdle();
    expect(h.provider.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: h.providerSessionId, workspaceRoot: h.root, model: 'current-model', permissionPreset: 'plan' }), expect.any(AbortSignal));
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(h.store.getTranscript(result.sessionId).map(item => item.text)).toEqual([h.longText, 'middle', 'new']);
    const list = await h.service.listConversations(); expect(list).toMatchObject({ ok: true, items: [{ linkedSessionId: result.sessionId, source: 'app', preview: 'new', action: 'open' }] });
    if (!list.ok) throw new Error(list.message); expect(list.items).toHaveLength(1);
    await expect(h.service.resumeHistory(request)).resolves.toMatchObject({ ok: true, sessionId: result.sessionId, alreadyLinked: true });
    await expect(h.service.resumeHistory({ ...request, model: 'other' })).resolves.toMatchObject({ ok: false, reason: 'conflict' });
    await h.runtime.dispose(); await h.store.close();
    const reopened = new DaemonStore(path.join(h.directory, 'daemon')); await reopened.init(); cleanups.push(() => reopened.close());
    const daemon = new DaemonCommandRouter(reopened);
    const restarted = new ConversationHistoryService({ history: h.history, daemon, store: reopened, runtime: h.runtime });
    await expect(restarted.resumeHistory(request)).resolves.toMatchObject({ ok: true, sessionId: result.sessionId, alreadyLinked: true });
    expect(reopened.getTranscript(result.sessionId).map(item => item.text)).toEqual([h.longText, 'middle', 'new']);
    expect(h.provider.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched roots, changed preparation, missing sources, and provider bypasses without claiming a session', async () => {
    const h = await harness(); const entry = await h.first(); const request = await h.request();
    const other = path.join(h.directory, 'other'); await fs.mkdir(other);
    await h.execute('workspace.create', { workspaceId: 'other', projectId: 'project', name: 'Other', rootPath: other, kind: 'local' });
    expect(await h.service.prepareHistoryResume({ conversationId: entry.conversationId, workspaceId: 'other' })).toMatchObject({ ok: true, canResume: false, blockedReason: 'root-mismatch' });
    expect(await h.service.resumeHistory({ ...request, permissionPreset: 'full-access' })).toMatchObject({ ok: false, reason: 'stale' });
    await h.execute('provider.disable', { providerId: h.providerId });
    expect(await h.service.prepareHistoryResume({ conversationId: entry.conversationId })).toMatchObject({ ok: true, canResume: false, blockedReason: 'provider-unavailable' });
    expect(await h.service.readConversation(h.providerSessionId)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.daemon.getSnapshot().sessions).toHaveLength(0); expect(h.provider.resumeSession).not.toHaveBeenCalled();
  });

  it('continues stopped stage conversations with full transcript and frozen lineage, and gates archived stages', async () => {
    const h = await harness(); const imported = await h.service.resumeHistory(await h.request()); if (!imported.ok) throw new Error(imported.message); await h.runtime.whenIdle();
    const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0].document = 'frozen stage instructions';
    const envelope = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    expect((await h.workflow.execute({ ...envelope, commandId: 'create', type: 'subproject.create', payload: { id: 'sub', title: 'Work', goal: '', presetId: 'research', graph } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    expect((await h.workflow.execute({ ...envelope, commandId: 'link', subprojectId: 'sub', type: 'session.link', payload: { sessionId: imported.sessionId, scope: 'stage', nodeId: graph.nodes[0].id } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    const reference = await h.workflow.conversationContext('project', imported.sessionId);
    const fragments: DaemonTranscriptItemInput[] = Array.from({ length: 620 }, (_, index) => ({ id: `delta-${index}`, messageId: 'one-message', sessionId: imported.sessionId,
      kind: 'assistant-message', text: String(index % 10), isDelta: index > 0, isSensitive: false, createdAt: now().toISOString() }));
    for (let offset = 0; offset < fragments.length; offset += 100) await h.daemon.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: fragments.slice(offset, offset + 100) }] });
    await h.execute('agent.archive', { sessionId: imported.sessionId });
    const list = await h.service.listConversations({ archived: 'include' }); if (!list.ok) throw new Error(list.message);
    const entry = list.items[0]; expect(entry).toMatchObject({ subprojectId: 'sub', nodeId: graph.nodes[0].id, action: 'resume', archived: true });
    const prepared = await h.service.prepareHistoryResume({ conversationId: entry.conversationId }); if (!prepared.ok) throw new Error(prepared.message);
    const request = { conversationId: entry.conversationId, revision: prepared.revision, commandId: 'continued' };
    const result = await h.service.resumeHistory(request); if (!result.ok) throw new Error(result.message); await h.runtime.whenIdle();
    expect(result.sessionId).not.toBe(imported.sessionId);
    expect(await h.workflow.conversationContext('project', result.sessionId)).toEqual(reference);
    expect(h.store.getTranscript(result.sessionId, 0, 2_000).map(item => item.text)).toEqual([h.longText, 'middle', 'new', ...fragments.map(item => item.text)]);
    expect(h.store.pendingConversationSource(result.sessionId)).toBeUndefined();
    const rows = await h.service.listConversations(); if (!rows.ok) throw new Error(rows.message);
    const current = rows.items.find(item => item.linkedSessionId === result.sessionId)!;
    const page = await h.service.readConversation(current.conversationId, undefined, 2); if (!page.ok) throw new Error(page.message);
    expect(page.transcript.turns[0].entries).toMatchObject([{ markdown: 'new' }, { markdown: fragments.map(item => item.text).join('') }]);
    const previous = await h.service.readConversation(current.conversationId, page.transcript.nextCursor!, 2); if (!previous.ok) throw new Error(previous.message);
    expect(previous.transcript.turns[0].entries).toMatchObject([{ markdown: h.longText }, { markdown: 'middle' }]); expect(previous.transcript.nextCursor).toBeNull();
    const archivedGraph = structuredClone(graph); archivedGraph.nodes = archivedGraph.nodes.slice(1); archivedGraph.edges = []; archivedGraph.entryNodeId = archivedGraph.nodes[0]?.id ?? null;
    expect((await h.workflow.execute({ ...envelope, expectedRevision: 1, commandId: 'remove-stage', subprojectId: 'sub', type: 'workflow.patch', payload: { graph: archivedGraph, summary: 'Retire the original stage' } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    expect(await h.service.prepareHistoryResume({ conversationId: current.conversationId })).toMatchObject({ ok: true, canResume: false, blockedReason: 'archived-project', entry: { nodeId: graph.nodes[0].id, nodeTitle: graph.nodes[0].title } });
    expect((await h.workflow.execute({ ...envelope, expectedRevision: 2, commandId: 'archive-stage', subprojectId: 'sub', type: 'subproject.update', payload: { status: 'archived' } }, { kind: 'desktop', id: 'test' })).ok).toBe(true);
    expect(await h.service.prepareHistoryResume({ conversationId: current.conversationId })).toMatchObject({ ok: true, canResume: false, blockedReason: 'archived-project' });
    const archivedProject = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => null, resolveNavigationRoot: () => h.root,
      planning: new PlanningService({ resolveProjectRoot: () => null }), runs: () => [], session: () => undefined });
    expect(await archivedProject.navigation('project')).toMatchObject({ ok: true, snapshot: { subprojects: [{ id: 'sub', status: 'archived' }] } });
    expect(await archivedProject.read('project')).toMatchObject({ ok: false, error: 'not-found' });
  });
});
