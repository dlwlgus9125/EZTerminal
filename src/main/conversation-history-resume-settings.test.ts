// Resuming a Claude CLI conversation continues with the model, effort and permission it last ran
// with: the real Claude history adapter, conversation history service and daemon runtime.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonCommand, type DaemonCommandType } from '../shared/daemon-protocol';
import type { AgentProviderAdapter, ProviderProbeResult } from './agent-provider-adapter';
import { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';
import { AgentProviderRegistry, createProviderReviewDigest } from './agent-provider-registry';
import { ClaudeHistoryAdapter, encodeClaudeProjectDirName } from './claude-history-adapter';
import { ConversationHistoryService } from './conversation-history-service';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const now = () => new Date('2026-10-16T00:00:00.000Z');
const t = (n: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, n)).toISOString();

async function claudeConversation(options: { readonly withModel: boolean }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-resume-settings-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  const home = path.join(directory, 'home');
  const sessionId = 'c43f20cf-1111-4222-8333-000000000009';
  const projectDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDirName(root));
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const records: Record<string, unknown>[] = [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId },
    { uuid: 'u1', parentUuid: null, sessionId, cwd: root, isSidechain: false, type: 'user', timestamp: t(1), origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Fix the build' } },
    { uuid: 'a1', parentUuid: 'u1', sessionId, cwd: root, isSidechain: false, type: 'assistant', timestamp: t(2),
      ...(options.withModel ? { effort: 'xhigh' } : {}),
      message: { role: 'assistant', ...(options.withModel ? { model: 'claude-opus-5-5' } : {}), content: [{ type: 'text', text: 'Done.' }] } },
    // Neither a synthetic notice nor a subagent's sidechain is the conversation's own model.
    { uuid: 'a2', parentUuid: 'a1', sessionId, cwd: root, isSidechain: false, type: 'assistant', timestamp: t(3), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Interrupted.' }] } },
    { uuid: 's1', parentUuid: 'a1', sessionId, cwd: root, isSidechain: true, type: 'assistant', timestamp: t(4), effort: 'low', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Sub.' }] } },
  ];
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await fs.writeFile(path.join(home, '.claude', 'history.jsonl'), JSON.stringify({ display: 'Fix the build', timestamp: Date.parse(t(1)), project: root, sessionId }) + '\n');
  const appendAssistant = (model: string, effort: string) => fs.appendFile(file, JSON.stringify({ uuid: 'a3', parentUuid: 'a1', sessionId, cwd: root,
    isSidechain: false, type: 'assistant', timestamp: t(5), effort, message: { role: 'assistant', model, content: [{ type: 'text', text: 'Later.' }] } }) + '\n');

  const probe: ProviderProbeResult = { providerId: 'claude', displayName: 'claude', protocol: 'claude-agent-sdk', available: true,
    executablePath: path.join(directory, 'provider.exe'), executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: ['create', 'resume'] };
  const provider: AgentProviderAdapter = { providerId: 'claude', probe: vi.fn(async () => probe), listModels: vi.fn(async () => []),
    createSession: vi.fn(async (input) => ({ ...input, providerSessionId: 'created' })), resumeSession: vi.fn(async (input) => ({ ...input })),
    submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
    setSettings: vi.fn(async (input) => ({ ...input, permissionPreset: input.permissionPreset ?? 'standard' })), resolveApproval: vi.fn(async () => undefined),
    subscribe: () => () => undefined, reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })), disposeSession: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
  const store = new DaemonStore(path.join(directory, 'daemon'), { now }); await store.init(); cleanups.push(() => store.close());
  const registry = new AgentProviderRegistry([provider]);
  const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({ providers: registry, getSnapshot: () => daemon.getSnapshot(),
    applySystemCommit: (commit) => daemon.applySystemCommit(commit), applySystemTransition: (transition) => daemon.applySystemTransition(transition),
    readTranscript: (id, after, limit) => store.getTranscript(id, after, limit), findCommand: (id) => store.findCommand(id)?.command, now });
  const daemon: DaemonCommandRouter = new DaemonCommandRouter(store, { handlers: runtime.handlers() }); await runtime.start(); cleanups.push(() => runtime.dispose());
  let seq = 0;
  const execute = async <T extends DaemonCommandType>(type: T, payload: Parameters<typeof createDaemonCommand<T>>[0]['payload']) => {
    const id = `cmd-${++seq}`;
    const result = await daemon.execute(createDaemonCommand({ commandId: id, idempotencyKey: id, expectedRevision: store.getRevision(), issuedAt: now().toISOString(), principal: { kind: 'desktop', id: 'test' }, type, payload }));
    await runtime.whenIdle(); expect(result.ok, JSON.stringify(result)).toBe(true);
  };
  await execute('project.create', { projectId: 'project', name: 'Example', rootPath: root });
  await execute('workspace.create', { workspaceId: 'workspace', projectId: 'project', name: 'Local', rootPath: root, kind: 'local' });
  await registry.inspect('claude');
  await execute('provider.enable', { providerId: 'claude', displayName: 'claude', protocol: probe.protocol, executablePath: probe.executablePath,
    executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: probe.capabilities, reviewDigest: createProviderReviewDigest(probe) });
  const projectStore = new AgentProjectStore(path.join(directory, 'history')); await projectStore.init();
  const history = new AgentHistoryService(projectStore, [new ClaudeHistoryAdapter({ homeDir: home })]);
  expect((await history.saveProject({ name: 'Example', primaryRoot: root, additionalRoots: [], pinned: false })).ok).toBe(true);
  const service = new ConversationHistoryService({ history, daemon, store, runtime, now });
  // What the app has after a restart: the same stores, with no history listed yet.
  const restarted = () => new ConversationHistoryService({ history: new AgentHistoryService(projectStore, [new ClaudeHistoryAdapter({ homeDir: home })]), daemon, store, runtime, now });
  return { service, daemon, runtime, execute, appendAssistant, restarted };
}

it('a resumed Claude CLI conversation keeps its model, effort and permission', async () => {
  const { service, daemon, runtime } = await claudeConversation({ withModel: true });
  const list = await service.listConversations(); if (!list.ok) throw new Error(list.message);
  const entry = list.items[0]!;
  const prepared = await service.prepareHistoryResume({ conversationId: entry.conversationId }); if (!prepared.ok) throw new Error(prepared.message);
  expect(prepared).toMatchObject({ model: 'claude-opus-5-5', permissionPreset: 'full-access', canResume: true });
  const resumed = await service.resumeHistory({ conversationId: entry.conversationId, revision: prepared.revision, commandId: 'resume' });
  if (!resumed.ok) throw new Error(resumed.message);
  await runtime.whenIdle();
  const agent = daemon.getSnapshot().agents.find((item) => item.sessionId === resumed.sessionId)!;
  expect({ model: agent.model, reasoningEffort: agent.reasoningEffort, permissionPreset: agent.permissionPreset })
    .toEqual({ model: 'claude-opus-5-5', reasoningEffort: 'xhigh', permissionPreset: 'full-access' });
});

it('fills what an already imported conversation never recorded from its native transcript', async () => {
  const { service, daemon, runtime, execute, appendAssistant, restarted } = await claudeConversation({ withModel: false });
  const list = await service.listConversations(); if (!list.ok) throw new Error(list.message);
  const entry = list.items[0]!;
  const first = await service.prepareHistoryResume({ conversationId: entry.conversationId }); if (!first.ok) throw new Error(first.message);
  const imported = await service.resumeHistory({ conversationId: entry.conversationId, revision: first.revision, commandId: 'import' });
  if (!imported.ok) throw new Error(imported.message);
  await runtime.whenIdle();
  expect(daemon.getSnapshot().agents.find((item) => item.sessionId === imported.sessionId)?.model).toBeUndefined();
  // The CLI later ran this conversation on a concrete model and effort.
  await appendAssistant('claude-opus-5-5', 'xhigh');
  await execute('agent.archive', { sessionId: imported.sessionId });
  const linked = await service.listConversations({ archived: 'include' }); if (!linked.ok) throw new Error(linked.message);
  const conversationId = linked.items[0]!.conversationId;
  // A restored chat tab asks before anything has listed the provider's history.
  const cold = await restarted().prepareHistoryResume({ conversationId }); if (!cold.ok) throw new Error(cold.message);
  expect(cold).toMatchObject({ model: 'claude-opus-5-5', permissionPreset: 'full-access' });
  const prepared = await service.prepareHistoryResume({ conversationId }); if (!prepared.ok) throw new Error(prepared.message);
  expect(prepared).toMatchObject({ model: 'claude-opus-5-5' });
  const continued = await service.resumeHistory({ conversationId, revision: prepared.revision, commandId: 'continue' });
  if (!continued.ok) throw new Error(continued.message);
  await runtime.whenIdle();
  expect(daemon.getSnapshot().agents.find((item) => item.sessionId === continued.sessionId))
    .toMatchObject({ model: 'claude-opus-5-5', reasoningEffort: 'xhigh' });
});
