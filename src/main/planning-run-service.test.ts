import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planningProfilePresets } from '../shared/planning-profile-presets';
import type { PlanningRunRequest } from '../shared/planning-run';
import type { AgentProviderAdapter, AgentProviderEvent } from './agent-provider-adapter';
import { AgentProviderRegistry } from './agent-provider-registry';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';
import { PlanningService } from './planning-service';
import { PlanningExecutionStore } from './planning-execution-store';
import { PlanningRunService, type PlanningRunServiceOptions } from './planning-run-service';
import { PlanningResultService } from './planning-result-service';
import { WorkflowService } from './workflow-service';
import { createWorkflowGraph } from '../shared/workflow';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(realResults = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ez-planning-run-'));
  const store = new DaemonStore(directory);
  await store.init();
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const adapter: AgentProviderAdapter = {
    providerId: 'codex',
    probe: vi.fn(),
    listModels: vi.fn(async () => [{ id: 'model', displayName: 'Model', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }]),
    createSession: vi.fn(async (context) => ({ sessionId: context.sessionId, providerSessionId: `provider-${context.sessionId}`, model: context.model, permissionPreset: context.permissionPreset })),
    resumeSession: vi.fn(async (context) => ({ sessionId: context.sessionId, providerSessionId: context.providerSessionId, model: context.model, permissionPreset: context.permissionPreset })),
    submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
    setSettings: vi.fn(), resolveApproval: vi.fn(),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
  };
  const providers = new AgentProviderRegistry([adapter]);
  const ledger = new PlanningExecutionStore(store);
  const planning = new PlanningService({ resolveProjectRoot: (id) => id === 'project' ? directory : null });
  let service: PlanningRunService;
  const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({ providers, getSnapshot: () => daemon.getSnapshot(),
    applySystemCommit: (commit) => daemon.applySystemCommit(commit), applySystemTransition: (transition) => daemon.applySystemTransition(transition),
    readTranscript: (...args) => daemon.readTranscript(...args), findCommand: (id) => store.findCommand(id)?.command,
    beforeProviderDispatch: (turn) => service.beforeProviderDispatch(turn),
    canDispatchTurn: (turn) => service.canDispatchTurn(turn),
    preparedSessionSettings: (id) => service.preparedSessionSettings(id),
  });
  const daemon: DaemonCommandRouter = new DaemonCommandRouter(store, { handlers: runtime.handlers() });
  const errors: unknown[] = [];
  let results: PlanningResultService | undefined;
  const options = { store, ledger, planning, daemon, providers,
    worktrees: { execute: vi.fn() }, git: { run: vi.fn(async () => { throw new Error('No Git repository'); }) },
    wakeQueuedTurns: () => runtime.wakeQueuedTurns(), captureResult: vi.fn<PlanningRunServiceOptions['captureResult']>(async (...args) => results ? results.captureResult(...args) : [{ artifactId: 'result', revision: 1 }]),
    workflowResultContext: async (...args: Parameters<PlanningResultService['workflowResultContext']>) => results ? results.workflowResultContext(...args) : '',
    processReview: vi.fn<PlanningRunServiceOptions['processReview']>(async (...args) => { await results?.processReview(...args); }), decideReview: vi.fn(), reportError: (error: unknown) => errors.push(error),
    processIntegration: vi.fn(async () => undefined),
  };
  if (realResults) results = new PlanningResultService({ userDataDir: directory, store, ledger, daemon, git: options.git, worktrees: options.worktrees,
    validationRunner: { run: vi.fn() }, wakeQueuedTurns: options.wakeQueuedTurns, wakeExecution: () => service.requestTick(), reportError: options.reportError });
  service = new PlanningRunService(options);
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: 'project', name: 'Project', rootPath: directory, source: 'native' } },
    { kind: 'workspace.upsert', value: { id: 'workspace', projectId: 'project', name: 'Main', kind: 'local', rootPath: directory } },
    { kind: 'provider.upsert', value: { id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' } },
  ] });
  const patched = await planning.execute({ commandId: 'planning', projectId: 'project', expectedRevision: 0, actor: { kind: 'user', id: 'test' },
    type: 'planning.patch', payload: { summary: 'Define tasks', operations: [
      ...planningProfilePresets('en').map((value) => ({ op: 'profile.put', value })),
      { op: 'task.put', value: { id: 'task', revision: 0, title: 'Plan', objective: 'Review the plan', featureIds: [], screenIds: [], inputRefs: [], dependencyIds: [], allowedPaths: [], interfaceRefs: [],
        acceptance: [{ id: 'acceptance', description: 'Plan reviewed' }], validationPlan: [{ id: 'inspection', acceptanceIds: ['acceptance'], description: 'Inspect result', method: 'inspection', environment: 'Windows' }], status: 'ready' } },
    ] } });
  if (!patched.ok) throw new Error(patched.message);
  const frozen = await planning.execute({ commandId: 'freeze', projectId: 'project', expectedRevision: patched.revision, actor: { kind: 'user', id: 'test' }, type: 'planning.freeze', payload: { baselineId: 'baseline', title: 'Ready' } });
  if (!frozen.ok) throw new Error(frozen.message);
  await service.start();
  await runtime.start();
  cleanups.push(async () => { await service.dispose(); await results?.dispose(); await runtime.dispose('process-loss'); await store.close(); });
  const send = (request: PlanningRunRequest) => service.execute(request, { kind: 'desktop', id: 'test' });
  const prepare: PlanningRunRequest = { commandId: 'prepare', projectId: 'project', expectedRevision: 0, type: 'prepare', payload: {
    runId: 'run', baselineId: 'baseline', teamMode: 'single', progressPolicy: 'checkpoint',
    assignments: [{ taskId: 'task', profileId: 'profile-planning', providerId: 'codex', model: 'model', permissionPreset: 'plan' }],
    reviewer: { profileId: 'profile-review', providerId: 'codex', model: 'model', permissionPreset: 'plan' },
  } };
  return { store, ledger, runtime, adapter, send, prepare, errors, options, service, results, emit: (event: AgentProviderEvent) => { for (const listener of listeners) listener(event); },
    restart: async () => { await service.dispose(); service = new PlanningRunService(options); await service.start(); } };
}

describe('planning provider dispatch', () => {
  it('delivers an independently accepted planning text to the next actual workflow provider turn', async () => {
    const f = await fixture(true); const root = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => root, planning: f.options.planning, runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub');
    graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', instructions: 'Write a planning result', acceptance: ['Concrete plan'] };
    graph.nodes[1] = { ...graph.nodes[1], operation: 'agent', role: 'design', providerId: 'codex', model: 'model', instructions: 'Use the exact accepted plan', acceptance: ['Concrete design'], inputs: [{ nodeId: graph.nodes[0].id, kind: 'result' }] };
    graph.edges[1].outcome = 'next';
    const base = { projectId: 'project', hostId: 'host', expectedRevision: 0 }; const principal = { kind: 'desktop' as const, id: 'test' };
    expect(await workflows.execute({ ...base, commandId: 'text-create', type: 'subproject.create', payload: { id: 'sub', title: 'Two stages', goal: '', presetId: 'research', graph } }, principal)).toMatchObject({ ok: true });
    expect(await workflows.execute({ ...base, subprojectId: 'sub', commandId: 'text-prepare', type: 'run.prepare', payload: { runId: 'text-run', reviewer: { providerId: 'codex', model: 'model' } } }, principal)).toMatchObject({ ok: true });
    expect(await workflows.execute({ ...base, subprojectId: 'sub', commandId: 'text-start', type: 'run.start', payload: { runId: 'text-run' } }, principal)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    const first = f.ledger.read('project').runs[0].attempts[0];
    const output = 'The accepted plan requires a durable inbox keyed by the original command ID.';
    f.emit({ kind: 'transcript', item: { id: 'worker-output', sessionId: first.sessionId, turnId: first.turnId, sequence: 1, kind: 'assistant-message', text: output, isDelta: false, isSensitive: false, createdAt: new Date().toISOString() } });
    f.emit({ kind: 'turn-finished', sessionId: first.sessionId, turnId: first.turnId, outcome: 'completed' });
    await vi.waitFor(async () => expect((await f.results!.readResult('project', first.attemptId))?.reviewerTurnId, JSON.stringify({ run: f.ledger.read('project').runs[0], errors: f.errors.map(String) })).toBeTruthy(), { timeout: 5_000 });
    const record = (await f.results!.readResult('project', first.attemptId))!;
    const current = f.ledger.read('project').runs[0]; const task = current.preparation.tasks[0];
    const review = `EZTERMINAL_REVIEW_JSON\n${JSON.stringify({ schemaVersion: 1, baselineFingerprint: current.preparation.baseline.fingerprint, artifactIds: record.artifacts.map(artifact => artifact.artifactId), decision: 'approve', summary: 'Checked planning evidence', inspections: task.validations.map(validation => ({ validationId: validation.validationId, status: 'passed', summary: 'Concrete plan checked' })) })}`;
    f.emit({ kind: 'transcript', item: { id: 'review-output', sessionId: record.reviewerSessionId!, turnId: record.reviewerTurnId!, sequence: 1, kind: 'assistant-message', text: review, isDelta: false, isSensitive: false, createdAt: new Date().toISOString() } });
    f.emit({ kind: 'turn-finished', sessionId: record.reviewerSessionId!, turnId: record.reviewerTurnId!, outcome: 'completed' });
    await vi.waitFor(() => expect(f.ledger.read('project').runs[0].attempts.some(attempt => attempt.taskId === graph.nodes[1].id)).toBe(true));
    const second = f.ledger.read('project').runs[0].attempts.find(attempt => attempt.taskId === graph.nodes[1].id)!;
    const sent = vi.mocked(f.adapter.submit).mock.calls.find(([input]) => input.sessionId === second.sessionId)![0];
    expect(sent.prompt).toContain(output);
    const durable = f.store.getTranscript(second.sessionId, 0, 500).find(item => item.kind === 'user-message');
    expect(durable?.text).toContain(output);
    expect(f.errors).toEqual([]);
  }, 30_000);
  it('cancels an accepted queued workflow turn before attempt binding without dispatching it later', async () => {
    const f = await fixture(); const root = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => root, planning: f.options.planning, runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', instructions: 'Research', acceptance: ['Evidence'] };
    const base = { projectId: 'project', hostId: 'host', expectedRevision: 0 }; const principal = { kind: 'desktop' as const, id: 'test' };
    await workflows.execute({ ...base, commandId: 'create-queued', type: 'subproject.create', payload: { id: 'sub', title: 'Queued', goal: '', presetId: 'research', graph } }, principal);
    expect(await workflows.execute({ ...base, subprojectId: 'sub', commandId: 'prepare-queued', type: 'run.prepare', payload: { runId: 'queued-run', reviewer: { providerId: 'codex', model: 'model' } } }, principal)).toMatchObject({ ok: true });
    const dispatchGate = vi.spyOn(f.service, 'canDispatchTurn').mockReturnValue(false);
    expect(await workflows.execute({ ...base, subprojectId: 'sub', commandId: 'start-queued', type: 'run.start', payload: { runId: 'queued-run' } }, principal)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.store.getSnapshot().turns.some(turn => turn.state === 'queued')).toBe(true));
    expect(f.ledger.read('project').runs[0].attempts).toEqual([]);
    expect(await workflows.execute({ ...base, subprojectId: 'sub', commandId: 'cancel-queued', type: 'run.cancel', payload: { runId: 'queued-run' } }, principal)).toMatchObject({ ok: true });
    dispatchGate.mockRestore(); await f.runtime.whenIdle();
    expect(f.ledger.read('project').runs[0].state).toBe('cancelled'); expect(f.store.getSnapshot().turns.every(turn => turn.state === 'interrupted')).toBe(true); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('prepares a frozen workflow, starts through the same attempt authority and never auto-integrates it', async () => {
    const f = await fixture(); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', instructions: 'Research with evidence', acceptance: ['Explain observed evidence'] };
    const common = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    expect(await workflows.execute({ ...common, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    const prepare = { ...common, commandId: 'workflow-prepare', subprojectId: 'sub', type: 'run.prepare' as const, payload: { runId: 'workflow-run', reviewer: { providerId: 'codex', model: 'model' } } };
    expect(await workflows.execute(prepare, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true }); expect(f.adapter.submit).not.toHaveBeenCalled();
    const frozen = structuredClone(f.ledger.read('project').runs[0].preparation);
    graph.nodes[0].instructions = 'Next run only';
    expect(await workflows.execute({ ...common, commandId: 'draft-edit', subprojectId: 'sub', type: 'workflow.patch', payload: { graph, summary: 'Next run' } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    const start = { ...common, expectedRevision: 1, commandId: 'workflow-start', subprojectId: 'sub', type: 'run.start' as const, payload: { runId: 'workflow-run' } };
    const rename = fs.rename.bind(fs); let workflowWrites = 0;
    const renameFault = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]).endsWith('workflows.json') && ++workflowWrites === 2) throw new Error('Lost registry commit after execution started');
      return rename(...args);
    });
    expect(await workflows.execute(start, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false });
    renameFault.mockRestore();
    expect(await workflows.execute(start, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce()); expect(f.ledger.read('project').runs[0].preparation).toEqual(frozen);
    expect(await workflows.execute(start, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true, duplicate: true });
    expect(await f.service.executeWorkflow({ ...start, payload: { runId: 'another' } }, { id: 'sub' } as never, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false, error: 'command-conflict' });
    expect(f.options.processIntegration).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
  });
  it('blocks replacement reviewers after execution authority stops', async () => {
    const f = await fixture();
    const turn = { sessionId: `planning-review-${'a'.repeat(32)}-g2` } as Parameters<PlanningRunService['canDispatchTurn']>[0];
    expect(f.service.canDispatchTurn(turn)).toBe(true);
    await f.service.dispose();
    expect(f.service.canDispatchTurn(turn)).toBe(false);
    expect(await f.service.beforeProviderDispatch(turn)).toBe(false);
  });

  it('does not launch during preparation; binds a durable attempt before provider submission and deduplicates start', async () => {
    const f = await fixture();
    expect(await f.send(f.prepare)).toMatchObject({ ok: true });
    expect(await f.send(f.prepare)).toMatchObject({ ok: true });
    expect(f.adapter.submit).not.toHaveBeenCalled();
    vi.mocked(f.adapter.submit).mockImplementation(async (input) => {
      expect(f.ledger.read('project').runs[0].attempts).toMatchObject([{ turnId: input.turnId, sessionId: input.sessionId, state: 'running' }]);
    });
    const start: PlanningRunRequest = { commandId: 'start', projectId: 'project', expectedRevision: 1, type: 'start', payload: { runId: 'run' } };
    expect(await f.send(start)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(await f.send(start)).toMatchObject({ ok: true });
    await f.runtime.whenIdle();
    expect(f.adapter.submit).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
    const attempt = f.ledger.read('project').runs[0].attempts[0];
    f.emit({ kind: 'turn-finished', sessionId: attempt.sessionId, turnId: attempt.turnId, outcome: 'completed' });
    await vi.waitFor(() => expect(f.ledger.read('project').runs[0].tasks[0].state).toBe('awaiting-review'));
    expect(f.options.processReview).toHaveBeenCalled();
    expect(f.ledger.read('project').runs[0].state).not.toBe('completed');
  });

  it('reconciles a restarted execution without issuing another provider turn or resetting retries', async () => {
    const f = await fixture();
    expect(await f.send(f.prepare)).toMatchObject({ ok: true });
    expect(await f.send({ commandId: 'start', projectId: 'project', expectedRevision: 1, type: 'start', payload: { runId: 'run' } })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    await f.runtime.whenIdle();
    await f.restart();
    await vi.waitFor(() => expect(f.ledger.read('project').runs[0].attempts[0].state).toBe('running'));
    expect(f.adapter.submit).toHaveBeenCalledOnce();
    expect(f.ledger.read('project').runs[0].tasks[0].retriesUsed).toBe(0);
  });
});
