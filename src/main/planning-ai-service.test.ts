import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanningService } from './planning-service';
import { PlanningAiService, type PlanningAiServiceOptions } from './planning-ai-service';
import { DaemonStore } from './daemon-store';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { AgentProviderRegistry } from './agent-provider-registry';
import type { AgentProviderAdapter, AgentProviderEvent } from './agent-provider-adapter';
import type { PlanningAiResult, PlanningAiStart } from '../shared/planning-ai';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request: PlanningAiStart = { requestId: 'proposal-1', projectId: 'P', expectedRevision: 1, target: { kind: 'item', id: 'requirement', revision: 1 }, instruction: 'Clarify the private request', providerId: 'claude', model: 'exact-model', reasoningEffort: 'high', contextIds: [] };
function job(result: PlanningAiResult) { if (!result.ok || !result.jobs[0]) throw new Error(JSON.stringify(result)); return result.jobs[0]; }
async function fixture(ownsSubproject?: PlanningAiServiceOptions['ownsSubproject']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-planning-ai-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DaemonStore(path.join(root, 'runtime')); await store.init();
  const planning = new PlanningService({ resolveProjectRoot: id => id === 'P' ? root : null });
  await planning.execute({ commandId: 'seed', projectId: 'P', expectedRevision: 0, actor: { kind: 'user', id: 'desktop-user' }, type: 'planning.patch', payload: { summary: 'Seed', operations: [{ op: 'item.put', value: { id: 'requirement', revision: 0, title: 'Private request', kind: 'requirement', body: 'Private body', status: 'draft', acceptance: [] } }] } });
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const adapter: AgentProviderAdapter = { providerId: 'claude', probe: vi.fn(),
    listModels: vi.fn(async () => [{ id: 'exact-model', displayName: 'Exact model', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }]),
    createSession: vi.fn(async context => ({ sessionId: context.sessionId, providerSessionId: `provider-${context.sessionId}`, model: context.model, permissionPreset: context.permissionPreset })),
    resumeSession: vi.fn(async context => ({ sessionId: context.sessionId, providerSessionId: context.providerSessionId, model: context.model, permissionPreset: context.permissionPreset })),
    submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), setSettings: vi.fn(), resolveApproval: vi.fn(),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
  const providers = new AgentProviderRegistry([adapter]);
  let current: PlanningAiService;
  const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({ providers, getSnapshot: () => daemon.getSnapshot(),
    applySystemCommit: commit => daemon.applySystemCommit(commit), applySystemTransition: transition => daemon.applySystemTransition(transition),
    readTranscript: (...args) => daemon.readTranscript(...args), findCommand: id => store.findCommand(id)?.command,
    preparedSessionSettings: id => current?.preparedSessionSettings(id), canDispatchTurn: turn => current?.canDispatchTurn(turn) ?? false });
  const daemon = new DaemonCommandRouter(store, { handlers: runtime.handlers() });
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: 'P', name: 'Planning', source: 'native', rootPath: root } },
    { kind: 'provider.upsert', value: { id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' } },
  ] });
  const key = randomBytes(32);
  const options: PlanningAiServiceOptions = { directory: path.join(root, 'proposals'), windowsAcl: async () => undefined, planning, daemon, store, providers,
    ownsSubproject,
    resolveProjectRoot: id => id === 'P' ? root : null, wakeQueuedTurns: () => runtime.wakeQueuedTurns(),
    protector: { available: vi.fn(() => true), encrypt: text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
      decrypt: bytes => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); } } };
  current = new PlanningAiService(options); await current.init(); await runtime.start();
  cleanups.push(async () => { await current.dispose(); await runtime.dispose('process-loss'); await store.close(); await planning.flush(); });
  const complete = async (output?: unknown, realProvider = false) => {
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledOnce()); await runtime.whenIdle();
    const turn = daemon.getSnapshot().turns[0];
    const value = output ?? { summary: 'Clarify the requirement', operation: { op: 'item.put', value: { id: 'requirement', revision: 1, title: 'Clear private request', kind: 'requirement', body: 'Improved private body', status: 'draft', acceptance: [] } } };
    // A real provider marks its reply sensitive (metadata) and streams it before the final row.
    const text = JSON.stringify(value); const half = Math.floor(text.length / 2);
    const rows = realProvider ? [{ text: text.slice(0, half), isDelta: true }, { text: text.slice(half), isDelta: true }, { text, isDelta: false }] : [{ text, isDelta: false }];
    rows.forEach((row, index) => { for (const listener of listeners) listener({ kind: 'transcript', item: { id: `response-${index}`, sessionId: turn.sessionId, turnId: turn.id, sequence: index + 1, kind: 'assistant-message', text: row.text, isDelta: row.isDelta, isSensitive: realProvider, ...(realProvider ? { messageId: 'response' } : {}), createdAt: new Date().toISOString() } }); });
    for (const listener of listeners) listener({ kind: 'turn-finished', sessionId: turn.sessionId, turnId: turn.id, outcome: 'completed' });
    await runtime.whenIdle();
  };
  return { root, options, get service() { return current; }, adapter, planning, daemon, complete,
    restart: async () => { await current.dispose(); current = new PlanningAiService(options); await current.init(); return current; } };
}
describe('planning AI generation authority', () => {
  it('generates and applies the same entity ID only within its explicitly selected subproject', async () => {
    const f = await fixture(async (_project, owner) => ['a', 'b'].includes(owner));
    for (const owner of ['a', 'b']) await f.planning.execute({ projectId: 'P', subprojectId: owner, commandId: `seed-${owner}`, expectedRevision: 0, actor: { kind: 'user', id: 'u' }, type: 'planning.patch', payload: { summary: 'Scoped seed', operations: [{ op: 'item.put', value: { id: 'requirement', revision: 0, title: owner, kind: 'requirement', body: `Body ${owner}`, status: 'draft', acceptance: [] } }] } });
    await f.service.request({ type: 'start', request: { ...request, subprojectId: 'a' } }, 'desktop-user'); await f.complete();
    expect(await f.service.request({ type: 'read', projectId: 'P', subprojectId: 'b' }, 'desktop-user')).toMatchObject({ ok: true, jobs: [] });
    expect(await f.service.request({ type: 'apply', projectId: 'P', subprojectId: 'b', requestId: request.requestId }, 'desktop-user')).toMatchObject({ ok: false });
    expect(await f.service.request({ type: 'apply', projectId: 'P', subprojectId: 'a', requestId: request.requestId }, 'desktop-user')).toMatchObject({ ok: true });
    expect(await f.planning.read('P', 'b')).toMatchObject({ ok: true, snapshot: { draft: { items: [{ body: 'Body b' }] } } });
    expect(await f.planning.read('P')).toMatchObject({ ok: true, snapshot: { draft: { items: [{ body: 'Private body' }] } } });
  });
  it('generates with exact tool-free settings, keeps planning unchanged until apply, and records one undoable mutation', async () => {
    const f = await fixture();
    expect(job(await f.service.request({ type: 'start', request }, 'desktop-user')).state).toBe('prepared');
    await f.complete();
    expect(f.adapter.createSession).toHaveBeenCalledWith(expect.objectContaining({ toolsDisabled: true, managedExecution: true, model: 'exact-model', reasoningEffort: 'high', permissionPreset: 'plan' }), expect.any(AbortSignal));
    expect(job(await f.service.request({ type: 'read', projectId: 'P' }, 'desktop-user')).state).toBe('ready');
    expect(await f.planning.read('P')).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    const applied = await f.service.request({ type: 'apply', projectId: 'P', requestId: request.requestId }, 'desktop-user');
    expect(applied).toMatchObject({ ok: true, mutation: { ok: true, revision: 2, duplicate: false } });
    expect(await f.service.request({ type: 'apply', projectId: 'P', requestId: request.requestId }, 'desktop-user')).toMatchObject({ ok: true, mutation: { ok: true, duplicate: true } });
  });
  it('reads a real provider proposal (marked sensitive and streamed) as one reply', async () => {
    const f = await fixture();
    expect(job(await f.service.request({ type: 'start', request }, 'desktop-user')).state).toBe('prepared');
    await f.complete(undefined, true);
    expect(job(await f.service.request({ type: 'read', projectId: 'P' }, 'desktop-user')).state).toBe('ready');
  });
  it('persists encrypted input and recovers the same request after restart without another submission', async () => {
    const f = await fixture(); await f.service.request({ type: 'start', request }, 'desktop-user'); await f.complete();
    await f.service.request({ type: 'read', projectId: 'P' }, 'desktop-user');
    const ciphertext = await fs.readFile(path.join(f.options.directory, 'proposals.bin'), 'utf8');
    expect(ciphertext).not.toContain('Private body'); expect(ciphertext).not.toContain(request.instruction);
    await f.restart();
    expect(job(await f.service.request({ type: 'start', request }, 'desktop-user')).state).toBe('ready');
    expect(f.adapter.submit).toHaveBeenCalledOnce();
    expect(await f.service.request({ type: 'start', request: { ...request, instruction: 'Different' } }, 'desktop-user')).toMatchObject({ ok: false });
  });
  it('rejects unverified providers, unavailable models, forged scope, and encrypted storage failure before dispatch', async () => {
    const f = await fixture();
    expect(await f.service.request({ type: 'start', request: { ...request, providerId: 'codex' } }, 'desktop-user')).toMatchObject({ ok: false });
    expect(await f.service.request({ type: 'start', request: { ...request, model: 'fallback' } }, 'desktop-user')).toMatchObject({ ok: false });
    expect(await f.service.request({ type: 'start', request: { ...request, target: { ...request.target, revision: 9 } } }, 'desktop-user')).toMatchObject({ ok: false });
    vi.mocked(f.options.protector.available).mockReturnValue(false);
    expect(await f.service.request({ type: 'start', request }, 'desktop-user')).toMatchObject({ ok: false });
    expect(f.adapter.createSession).not.toHaveBeenCalled();
  });
  it('rejects malicious output and a manual revision change during generation without applying either', async () => {
    const f = await fixture(); await f.service.request({ type: 'start', request }, 'desktop-user');
    await f.complete({ summary: 'Escape', operation: { op: 'entity.delete', kind: 'item', id: 'requirement' } });
    expect(job(await f.service.request({ type: 'read', projectId: 'P' }, 'desktop-user')).state).toBe('failed');
    expect(await f.service.request({ type: 'apply', projectId: 'P', requestId: request.requestId }, 'desktop-user')).toMatchObject({ ok: false });
    expect(await f.planning.read('P')).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  });
  it('persists the exact inherited profile and reference snapshots before generation and keeps them after restart', async () => {
    const f = await fixture();
    const parent = { id: 'planning-base', revision: 0, title: 'Planning base', role: 'planning' as const, instructions: 'Always include acceptance criteria.', contextRefs: [{ kind: 'item' as const, id: 'requirement', revision: 1 }], allowedTools: ['planning.read' as const], retryLimit: 2 };
    const child = { ...parent, id: 'planning-mobile', title: 'Mobile planning', parentProfileId: parent.id, instructions: 'Preserve offline drafts.', contextRefs: [] };
    expect(await f.planning.execute({ commandId: 'seed-profiles', projectId: 'P', expectedRevision: 1, actor: { kind: 'user', id: 'desktop-user' }, type: 'planning.patch', payload: { summary: 'Roles', operations: [{ op: 'profile.put', value: parent }, { op: 'profile.put', value: child }] } })).toMatchObject({ ok: true });
    const withRole = { ...request, expectedRevision: 2, profileId: child.id, profileVersion: 2 };
    const started = job(await f.service.request({ type: 'start', request: withRole }, 'desktop-user'));
    expect(started.profileSnapshots?.map(profile => profile.id)).toEqual([parent.id, child.id]);
    expect(started.contextSnapshots).toMatchObject([{ reference: { id: 'requirement', revision: 1 }, content: { body: 'Private body' } }]);
    await f.complete();
    const serializedDispatch = JSON.stringify(vi.mocked(f.adapter.submit).mock.calls);
    expect(serializedDispatch).toContain(parent.instructions); expect(serializedDispatch).toContain(child.instructions);
    await f.restart();
    const restored = job(await f.service.request({ type: 'read', projectId: 'P', requestId: request.requestId }, 'desktop-user'));
    expect(restored.profileSnapshots).toEqual(started.profileSnapshots); expect(restored.contextSnapshots).toEqual(started.contextSnapshots);
    expect(f.adapter.submit).toHaveBeenCalledOnce();
    expect(await f.service.request({ type: 'start', request: { ...withRole, requestId: 'stale-role', profileVersion: 3 } }, 'desktop-user')).toMatchObject({ ok: false });
  });
});
