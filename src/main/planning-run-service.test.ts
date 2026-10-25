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
import { autoApprovalCommandId, autoApprovalCommands, autoApprovalRefused, PlanningRunService, workflowLaunchId, workflowLedgerId, type PlanningRunServiceOptions } from './planning-run-service';
import { PlanningResultService } from './planning-result-service';
import { WorkflowService, workflowDigest } from './workflow-service';
import { REPEAT_SCHEDULE_PRINCIPAL, WorkflowRepeatService, repeatOccurrenceIds } from './workflow-repeat-service';
import { decideStageBinding, type CommittedSubproject } from './workflow-stage-binding';
import { legacyPlanningRunResult } from '../shared/workflow-protocol-projection';
import { ProjectArchiveService } from './project-archive-service';
import { parseArchiveJson, verifyArchive } from './project-archive-package';
import { createWorkflowGraph, type WorkflowPrincipal } from '../shared/workflow';
import { stageEditScope } from '../shared/planning-execution';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const repeats = new WeakMap<WorkflowService, WorkflowRepeatService>();
/** The host's repeat schedule over a real flow service (fake clock, timers left to the test); it records consent for that service. */
function repeatService(workflows: WorkflowService, now: () => Date): WorkflowRepeatService {
  const created = new WorkflowRepeatService({ directory: mkdtempSync(path.join(os.tmpdir(), 'ez-repeat-run-')), hostId: 'host',
    projectIds: () => ['project'], sources: (projectId) => workflows.repeatSources(projectId), hasReceipt: (projectId, commandId) => workflows.hasReceipt(projectId, commandId),
    launch: (command, principal) => workflows.execute(command, principal), automationEnabled: () => true, now, setTimer: () => 0, clearTimer: () => undefined });
  repeats.set(workflows, created);
  return created;
}
async function fixture(realResults = false, bindStages = false) {
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
  // Stage bindings read the committed subproject through a WorkflowService the test attaches later.
  const committed: { source?: (projectId: string, subprojectId: string) => Promise<CommittedSubproject> } = {};
  if (bindStages) Object.assign(options, { committedSubproject: (projectId: string, subprojectId: string) => committed.source?.(projectId, subprojectId) ?? Promise.resolve({ ok: false, reason: 'missing' } as const) });
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
  return { store, ledger, runtime, adapter, send, prepare, errors, options, service, results, committed, emit: (event: AgentProviderEvent) => { for (const listener of listeners) listener(event); },
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
    // Review read, evidence, decision and the next dispatch are several async writes: a slow
    // Windows runner needs more than the 1 s default (the other waits here allow 5 s).
    await vi.waitFor(() => expect(f.ledger.read('project').runs[0].attempts.some(attempt => attempt.taskId === graph.nodes[1].id)).toBe(true), { timeout: 10_000 });
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
    // A run without 자동 승인 carries no policy field, so older clients still parse it.
    expect(frozen).not.toHaveProperty('approvalPolicy');
    // A stage without a chosen effort leaves the key out of its task profile.
    expect(frozen.tasks[0]!.profile).not.toHaveProperty('reasoningEffort');
    // This fixture has no committed-flow source, so an edit after prepare waits for the next run (see late binding below).
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
  it('replays a phone’s prepare in the real ledger after the phone moved from a v16 to a v17 connection', async () => {
    const f = await fixture(); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', instructions: 'Research with evidence', acceptance: ['Explain observed evidence'] };
    const common = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    expect(await workflows.execute({ ...common, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    const prepare = { ...common, commandId: 'phone-prepare', subprojectId: 'sub', type: 'run.prepare' as const, payload: { runId: 'phone-run', reviewer: { providerId: 'codex', model: 'model' } } };
    const phone = { kind: 'android' as const, id: 'android:phone' };
    const rename = fs.rename.bind(fs); let workflowWrites = 0;
    const lost = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]).endsWith('workflows.json') && ++workflowWrites === 2) throw new Error('Reply lost after the ledger prepared the run');
      return rename(...args);
    });
    expect(await workflows.execute(prepare, { ...phone, reducedFlowView: true })).toMatchObject({ ok: false });
    lost.mockRestore();
    expect(f.ledger.read('project').runs).toHaveLength(1);
    // Same phone, updated: the ledger's frozen request fingerprint still matches.
    expect(await workflows.execute(prepare, phone)).toMatchObject({ ok: true });
    expect(f.ledger.read('project').runs).toHaveLength(1);
  });
  it('carries a stage’s reasoning effort to its provider and refuses one its model does not offer', async () => {
    const f = await fixture(); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub');
    graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', reasoningEffort: 'high', instructions: 'Research with evidence', acceptance: ['Explain observed evidence'] };
    const common = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    const user = { kind: 'desktop' as const, id: 'test' };
    expect(await workflows.execute({ ...common, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, user)).toMatchObject({ ok: true });
    expect(await workflows.execute({ ...common, commandId: 'prepare-high', subprojectId: 'sub', type: 'run.prepare', payload: { runId: 'run-high', reviewer: { providerId: 'codex', model: 'model' } } }, user)).toMatchObject({ ok: true });
    const prepared = f.ledger.read('project').runs[0]!;
    expect(prepared.preparation.tasks.find((task) => task.taskId === graph.nodes[0]!.id)?.profile.reasoningEffort).toBe('high');
    expect(await workflows.execute({ ...common, commandId: 'start-high', subprojectId: 'sub', type: 'run.start', payload: { runId: 'run-high' } }, user)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'high' }), expect.anything()));
    // The fixture model only advertises 'high'. (The running stage itself is locked, so use a second flow.)
    const max = createWorkflowGraph('research', 'sub-max'); max.nodes[0] = { ...max.nodes[0]!, providerId: 'codex', model: 'model', reasoningEffort: 'max', instructions: 'Research with evidence', acceptance: ['Explain observed evidence'] };
    expect(await workflows.execute({ ...common, expectedRevision: 1, commandId: 'create-max', type: 'subproject.create', payload: { id: 'sub-max', title: 'Max', goal: '', presetId: 'research', graph: max } }, user)).toMatchObject({ ok: true });
    const refused = await workflows.execute({ ...common, commandId: 'prepare-max', subprojectId: 'sub-max', type: 'run.prepare', payload: { runId: 'run-max', reviewer: { providerId: 'codex', model: 'model' } } }, user);
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/does not advertise this reasoning setting/u) });
    expect(f.ledger.read('project').runs.map((run) => run.runId)).toEqual(['run-high']);

    // The ledger itself refuses a prepared task whose effort differs from its frozen stage.
    const frozen = structuredClone(prepared.preparation); const nodeId = graph.nodes[0]!.id;
    const withoutEffort = <T extends object>(value: T): T => { const copy = { ...value } as T & { reasoningEffort?: string }; delete copy.reasoningEffort; return copy; };
    const withTask = (effort: string | undefined) => frozen.tasks.map((task) => task.taskId !== nodeId ? task : { ...task, profile: effort ? { ...task.profile, reasoningEffort: effort } : withoutEffort(task.profile) });
    const withNode = (effort: string | undefined) => ({ ...frozen.workflow!.graph, nodes: frozen.workflow!.graph.nodes.map((node) => node.id !== nodeId ? node : effort ? { ...node, reasoningEffort: effort } : withoutEffort(node)) });
    const cases = [
      { label: 'different', tasks: withTask('max'), graph: withNode('high') },
      { label: 'task only unset', tasks: withTask(undefined), graph: withNode('high') },
      { label: 'stage only unset', tasks: withTask('high'), graph: withNode(undefined) },
    ];
    for (const [index, entry] of cases.entries()) {
      const preparation = { ...frozen, tasks: entry.tasks, workflow: { ...frozen.workflow!, graph: entry.graph, fingerprint: workflowDigest(entry.graph) } };
      const receipt = await f.ledger.execute({ commandId: `mismatch-${index}`, projectId: 'project', expectedRevision: f.ledger.read('project').revision,
        principal: { kind: 'desktop', id: 'test' }, type: 'run.prepare', payload: { runId: `mismatch-run-${index}`, preparation } });
      expect(receipt, entry.label).toMatchObject({ ok: false, error: 'invalid-reference' });
    }
    expect(f.ledger.read('project').runs.map((run) => run.runId)).toEqual(['run-high']);
  });
  it('lets a project conversation prepare and start a run, freezing 자동 승인 and who started it', async () => {
    const f = await fixture(); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs, session: id => id === 'chat' ? { projectId: 'project', managed: false } : undefined,
      executeRun: (...args) => f.service.executeWorkflow(...args) });
    const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0] = { ...graph.nodes[0], providerId: 'codex', model: 'model', instructions: 'Research with evidence', acceptance: ['Explain observed evidence'] };
    const common = { projectId: 'project', hostId: 'host', expectedRevision: 0 };
    const person = { kind: 'desktop' as const, id: 'test' };
    const agent = { kind: 'ai' as const, id: 'agent', sessionId: 'chat' };
    expect(await workflows.execute({ ...common, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, person)).toMatchObject({ ok: true });
    expect(await workflows.execute({ ...common, commandId: 'auto-on', subprojectId: 'sub', type: 'subproject.update', payload: { autoApprove: true } }, person)).toMatchObject({ ok: true });
    expect(await workflows.execute({ ...common, expectedRevision: 1, commandId: 'agent-prepare', subprojectId: 'sub', type: 'run.prepare', payload: { runId: 'agent-run', reviewer: { providerId: 'codex', model: 'model' } } }, agent)).toMatchObject({ ok: true });
    expect(f.ledger.read('project').runs[0].preparation).toMatchObject({ approvalPolicy: 'auto', startedBy: { sessionId: 'chat' } });
    expect(await workflows.execute({ ...common, expectedRevision: 1, commandId: 'agent-start', subprojectId: 'sub', type: 'run.start', payload: { runId: 'agent-run' } }, agent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(await workflows.execute({ ...common, expectedRevision: 1, commandId: 'agent-integrate', subprojectId: 'sub', type: 'run.integrate', payload: { runId: 'agent-run' } }, agent)).toMatchObject({ ok: false, error: 'user-required' });
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

describe('autoApprovalRefused', () => {
  const base = autoApprovalCommandId('run-1', 'activation-1');
  const reading = (receipts: Record<string, { ok: boolean; error?: string }>) => autoApprovalRefused(
    (_projectId, commandId) => (receipts[commandId] ? { commandId, projectId: 'project', revision: 1, ...receipts[commandId] } as never : null), 'project', 'run-1', 'activation-1');
  it('reads the host’s decision across its retries, as the runtime records them', () => {
    expect(reading({})).toBe(false);
    expect(reading({ [`${base}-0`]: { ok: true } })).toBe(false);
    expect(reading({ [`${base}-0`]: { ok: false, error: 'invalid-state' } })).toBe(true);
    expect(reading({ [`${base}-0`]: { ok: false, error: 'revision-conflict' }, [`${base}-1`]: { ok: false, error: 'user-required' } })).toBe(true);
    // Still retrying: not decided yet.
    expect(reading({ [`${base}-0`]: { ok: false, error: 'revision-conflict' } })).toBe(false);
    // Every retry met a conflict: the runtime gave up, the person decides.
    expect(reading(Object.fromEntries([0, 1, 2, 3, 4].map((retry) => [`${base}-${retry}`, { ok: false, error: 'revision-conflict' }])))).toBe(true);
  });
});

describe('auto-approval', () => {
  const run = (overrides: Record<string, unknown> = {}, preparation: Record<string, unknown> = {}) => ({
    runId: 'run', projectId: 'project', revision: 3, state: 'awaiting-review', createdAt: 'x', updatedAt: 'x', startedAt: 'x',
    preparation: { approvalPolicy: 'auto', workflow: { subprojectId: 'sub' }, ...preparation },
    tasks: [], attempts: [], evidence: [], reviews: [], gates: [],
    workflowRuntime: { activations: [{ id: 'gate-1', nodeId: 'approval', iteration: 0, state: 'awaiting-approval', incomingEdgeIds: [] }] },
    ...overrides,
  }) as unknown as Parameters<typeof autoApprovalCommands>[0];

  it('approves the stages a 자동 승인 run reached and allows integration once it completed', () => {
    expect(autoApprovalCommands(run())).toEqual([expect.objectContaining({ type: 'workflow.approve', payload: { activationId: 'gate-1', decision: 'approve' } })]);
    expect(autoApprovalCommands(run({ state: 'completed', workflowRuntime: { activations: [] } }))).toEqual([expect.objectContaining({ type: 'workflow.integrate' })]);
    // Stable identities: a restart repeats the same commands, which the ledger replays.
    expect(autoApprovalCommands(run())[0]!.commandId).toBe(autoApprovalCommands(run())[0]!.commandId);
  });

  it('leaves the person’s runs, and paused, cancelled, gated or integrated ones, alone', () => {
    expect(autoApprovalCommands(run({}, { approvalPolicy: 'user' }))).toEqual([]);
    expect(autoApprovalCommands(run({}, { approvalPolicy: undefined }))).toEqual([]);
    expect(autoApprovalCommands(run({ dispatchPaused: true }))).toEqual([]);
    expect(autoApprovalCommands(run({ cancelRequested: true }))).toEqual([]);
    const done = { state: 'completed', workflowRuntime: { activations: [] } };
    expect(autoApprovalCommands(run({ ...done, gates: [{ gateId: 'g', state: 'pending' }] }))).toEqual([]);
    expect(autoApprovalCommands(run({ ...done, integrationAuthorized: { by: 'auto-approval', at: 'x' } }))).toEqual([]);
  });
});

describe('auto-approval in the dispatch pump', () => {
  it('reports a refused automatic decision once and settles instead of retrying', async () => {
    const run = {
      runId: 'run', projectId: 'project', revision: 3, state: 'awaiting-review', createdAt: 'x', updatedAt: 'x', startedAt: 'x',
      preparation: { approvalPolicy: 'auto', teamMode: 'division', tasks: [], workflow: { subprojectId: 'sub', graph: { nodes: [] } } },
      tasks: [], attempts: [], evidence: [], reviews: [], gates: [],
      workflowRuntime: { activations: [{ id: 'gate-1', nodeId: 'approval', iteration: 0, state: 'awaiting-approval', incomingEdgeIds: [] }] },
    };
    const refused = { ok: false, error: 'invalid-transition', message: 'This exact workflow approval is no longer pending.' };
    const getReceipt = vi.fn(() => refused);
    const reportError = vi.fn();
    const service = new PlanningRunService({
      ledger: { recoverInterrupted: async () => 0, read: () => ({ revision: 3, runs: [run] }), getReceipt, execute: vi.fn() },
      daemon: { getSnapshot: () => ({ projects: [{ id: 'project' }], turns: [] }), onEvent: () => () => undefined },
      reportError, processReview: vi.fn(), wakeQueuedTurns: vi.fn(),
    } as unknown as PlanningRunServiceOptions);
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.requestTick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // One read per pump (start and the explicit tick), not a loop.
    expect(getReceipt.mock.calls.length).toBeLessThanOrEqual(2);
    expect(reportError).toHaveBeenCalledOnce();
    await service.dispose();
  });
});

describe('stage edits before a stage starts apply to the current run (late binding)', () => {
  async function flow(effort?: string) {
    const f = await fixture(false, true); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs, session: () => undefined, executeRun: (...args) => f.service.executeWorkflow(...args), executionGate: (work) => f.service.exclusive(work) });
    f.committed.source = (projectId, subprojectId) => workflows.committedSubproject(projectId, subprojectId);
    const graph = createWorkflowGraph('research', 'sub');
    graph.nodes[0] = { ...graph.nodes[0]!, providerId: 'codex', model: 'model', instructions: 'Original instructions', acceptance: ['Explain observed evidence'], ...(effort ? { reasoningEffort: effort } : {}) };
    const user = { kind: 'desktop' as const, id: 'test' };
    const common = { projectId: 'project', hostId: 'host' };
    let revision = 0; let sequence = 0;
    const run = async (type: 'run.prepare' | 'run.start', runId: string) => workflows.execute({ ...common, expectedRevision: revision, commandId: `${type}-${runId}`, subprojectId: 'sub', type,
      payload: type === 'run.prepare' ? { runId, reviewer: { providerId: 'codex', model: 'model' } } : { runId } } as never, user);
    const patch = async (change: (node: typeof graph.nodes[number]) => typeof graph.nodes[number]) => {
      const current = await workflows.read('project'); if (!current.ok) throw new Error(current.message);
      const subproject = current.snapshot.subprojects.find((entry) => entry.id === 'sub')!;
      const result = await workflows.execute({ ...common, expectedRevision: subproject.revision, commandId: `edit-${++sequence}`, subprojectId: 'sub', type: 'workflow.patch',
        payload: { graph: { ...subproject.graph, nodes: subproject.graph.nodes.map((node, index) => index === 0 ? change(node) : node) }, summary: 'Edit stage' } }, user);
      if (result.ok) revision = result.snapshot.subprojects.find((entry) => entry.id === 'sub')!.revision;
      return result;
    };
    expect(await workflows.execute({ ...common, expectedRevision: 0, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, user)).toMatchObject({ ok: true });
    return { f, workflows, graph, run, patch, nodeId: graph.nodes[0]!.id };
  }
  const submitted = (f: Awaited<ReturnType<typeof fixture>>) => (f.adapter.submit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { reasoningEffort?: string };

  it('binds settings edited after prepare but before the stage starts, and keeps the prepared run as stored', async () => {
    const { f, run, patch, nodeId } = await flow();
    expect(await run('run.prepare', 'r1')).toMatchObject({ ok: true });
    const frozen = structuredClone(f.ledger.read('project', { frozen: true }).runs[0]!.preparation);
    expect(await patch((node) => ({ ...node, instructions: 'Use the newer approach', reasoningEffort: 'high', position: { x: 500, y: 40 } }))).toMatchObject({ ok: true });
    expect(await run('run.start', 'r1')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(submitted(f).reasoningEffort).toBe('high');
    expect(JSON.stringify(submitted(f))).toContain('Use the newer approach');
    const current = f.ledger.read('project').runs[0]!;
    expect(current.stageBindings?.[nodeId]).toMatchObject({ outcome: 'applied', changed: ['instructions', 'reasoningEffort'] });
    expect(current.preparation.tasks[0]!.profile.reasoningEffort).toBe('high');
    // The frozen graph shows the applied stage settings but keeps its structure and canvas position.
    expect(current.preparation.workflow!.graph.nodes[0]).toMatchObject({ instructions: 'Use the newer approach', reasoningEffort: 'high', position: frozen.workflow!.graph.nodes[0]!.position });
    expect(current.attempts[0]!.requestedSettings).toMatchObject({ reasoningEffort: 'high' });
    expect(f.ledger.read('project', { frozen: true }).runs[0]!.preparation).toEqual(frozen);
    // An installed v16 phone sees what actually runs, without the v17 record.
    const legacy = legacyPlanningRunResult({ ok: true, snapshot: f.ledger.read('project') });
    if (!legacy.ok) throw new Error('unexpected');
    expect(legacy.snapshot.runs[0]).not.toHaveProperty('stageBindings');
    expect(legacy.snapshot.runs[0]!.preparation.tasks[0]!.profile.reasoningEffort).toBe('high');
    // A project backup keeps the prepared run as stored plus the binding record (views apply bindings when read).
    const archives = new ProjectArchiveService({ userDataDir: path.dirname(f.store.getSnapshot().projects[0].rootPath!), store: f.store, planning: f.options.planning, ledger: f.ledger, registerRestoredProject: vi.fn() });
    const target = path.join(path.dirname(f.store.getSnapshot().projects[0].rootPath!), 'binding-backup.json');
    await archives.exportProject('project', target, 'export-bindings');
    const archived = parseArchiveJson(verifyArchive(await fs.readFile(target)).entries.find((entry) => entry.kind === 'execution')!) as { runs: { preparation: unknown; stageBindings?: Record<string, unknown> }[] };
    expect(archived.runs[0]!.preparation).toEqual(frozen);
    expect(archived.runs[0]!.stageBindings?.[nodeId]).toMatchObject({ outcome: 'applied' });
    expect(f.errors).toEqual([]);
  });

  it('keeps the prepared settings for a structure change or a setting the model does not offer, and says why', async () => {
    const structure = await flow();
    expect(await structure.run('run.prepare', 'r1')).toMatchObject({ ok: true });
    expect(await structure.patch((node) => ({ ...node, role: 'review', instructions: 'Changed too' }))).toMatchObject({ ok: true });
    expect(await structure.run('run.start', 'r1')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(structure.f.adapter.submit).toHaveBeenCalledOnce());
    expect(JSON.stringify(submitted(structure.f))).toContain('Original instructions');
    expect(structure.f.ledger.read('project').runs[0]!.stageBindings?.[structure.nodeId]).toMatchObject({ outcome: 'kept', reason: 'structure-changed' });

    const unoffered = await flow();
    expect(await unoffered.run('run.prepare', 'r1')).toMatchObject({ ok: true });
    expect(await unoffered.patch((node) => ({ ...node, reasoningEffort: 'max' }))).toMatchObject({ ok: true });
    expect(await unoffered.run('run.start', 'r1')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(unoffered.f.adapter.submit).toHaveBeenCalledOnce());
    expect(submitted(unoffered.f).reasoningEffort).not.toBe('max');
    expect(unoffered.f.ledger.read('project').runs[0]!.stageBindings?.[unoffered.nodeId]).toMatchObject({ outcome: 'kept', reason: 'invalid', detail: expect.stringMatching(/reasoning setting/u) });
  });

  it('keeps the prepared settings when the flow file was changed outside this host', async () => {
    const { f, workflows, run, nodeId } = await flow();
    expect(await run('run.prepare', 'r1')).toMatchObject({ ok: true });
    const file = path.join(f.store.getSnapshot().projects[0].rootPath!, '.ezterminal', 'planning', 'workflows.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { registry: { subprojects: { graph: { nodes: { instructions: string }[] } }[] }; receipts: unknown[]; integrity: string };
    stored.registry.subprojects[0]!.graph.nodes[0]!.instructions = 'Written by another program';
    stored.integrity = workflowDigest({ registry: stored.registry, receipts: stored.receipts });
    await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
    // The execution side reads the committed flow without the workflow gate, with the same external-change rule.
    const committed = await workflows.committedSubproject('project', 'sub');
    expect(committed).toEqual({ ok: false, reason: 'unreadable' });
    const decision = await decideStageBinding(f.ledger.read('project').runs[0]!, nodeId, committed, { daemon: f.store.getSnapshot(), listModels: async () => [], now: () => new Date('2026-10-25T00:00:00.000Z') });
    expect(decision).toMatchObject({ kind: 'record', binding: { outcome: 'kept', reason: 'unreadable' } });
  });

  it('holds a stage whose edited settings cannot be checked, and sends it once the person continues', async () => {
    const { f, run, patch, nodeId } = await flow();
    expect(await run('run.prepare', 'r1')).toMatchObject({ ok: true });
    expect(await patch((node) => ({ ...node, reasoningEffort: 'high' }))).toMatchObject({ ok: true });
    (f.adapter.listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Codex is offline'));
    expect(await run('run.start', 'r1')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.ledger.read('project').runs[0]!.tasks[0]).toMatchObject({ state: 'paused', pauseReason: expect.stringMatching(/could not be checked/u) }));
    expect(f.adapter.submit).not.toHaveBeenCalled();
    expect(f.ledger.read('project').runs[0]!.stageBindings?.[nodeId]).toBeUndefined();
    // The held stage is not locked: an edit made now applies to this run.
    expect(stageEditScope(f.ledger.read('project').runs[0], nodeId)).toBe('this-run');
    expect(await patch((node) => ({ ...node, instructions: 'Edited while held' }))).toMatchObject({ ok: true });
    // Continue: the stage is ready again, binds now that the catalog answers, and is sent.
    const current = f.ledger.read('project');
    expect(await f.ledger.execute({ commandId: 'continue-held', projectId: 'project', expectedRevision: current.revision, principal: { kind: 'desktop', id: 'test' }, type: 'run.continue', payload: { runId: current.runs[0]!.runId } })).toMatchObject({ ok: true });
    f.service.requestTick();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(submitted(f).reasoningEffort).toBe('high');
    expect((submitted(f) as { prompt?: string }).prompt ?? JSON.stringify((f.adapter.submit as ReturnType<typeof vi.fn>).mock.calls[0])).toContain('Edited while held');
    expect(f.ledger.read('project').runs[0]!.stageBindings?.[nodeId]).toMatchObject({ outcome: 'applied' });
  });

  it('locks a working stage’s settings while letting it move, and the ledger takes one binding per stage from the host only', async () => {
    const { f, run, patch, nodeId } = await flow();
    expect(await run('run.prepare', 'r1')).toMatchObject({ ok: true });
    expect(await run('run.start', 'r1')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(await patch((node) => ({ ...node, instructions: 'Too late' }))).toMatchObject({ ok: false, error: 'stage-locked' });
    expect(await patch((node) => ({ ...node, position: { x: 900, y: 9 } }))).toMatchObject({ ok: true });
    const current = f.ledger.read('project').runs[0]!;
    const binding = { outcome: 'kept' as const, boundAt: new Date().toISOString(), reason: 'missing' as const };
    const command = (principal: 'runtime' | 'desktop', commandId: string) => f.ledger.execute({ commandId, projectId: 'project', expectedRevision: f.ledger.read('project').revision,
      principal: { kind: principal, id: 'test' }, type: 'task.bind', payload: { runId: current.runId, taskId: nodeId, binding } });
    expect(await command('desktop', 'bind-by-person')).toMatchObject({ ok: false, error: 'runtime-required' });
    // Once its first attempt started, a stage is never rebound.
    expect(await command('runtime', 'bind-late')).toMatchObject({ ok: false, error: 'invalid-transition' });
  });
});
describe('run settings and 다시 실행 (run.launch)', () => {
  async function launchFlow(options: { staleRuns?: boolean } = {}) {
    const f = await fixture(false, true); const directory = f.store.getSnapshot().projects[0].rootPath!;
    // `staleRuns`: the flow service sees no runs, so only the execution side can refuse a second start.
    const workflows: WorkflowService = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => options.staleRuns ? [] : f.ledger.read('project').runs, session: () => undefined,
      executeRun: (...args) => f.service.executeWorkflow(...args), executionGate: (work) => f.service.exclusive(work),
      repeatConsent: (projectId, subprojectId, repeat) => repeats.get(workflows)?.consent(projectId, subprojectId, repeat) ?? Promise.resolve() });
    f.committed.source = (projectId, subprojectId) => workflows.committedSubproject(projectId, subprojectId);
    const graph = createWorkflowGraph('research', 'sub');
    graph.nodes[0] = { ...graph.nodes[0]!, providerId: 'codex', model: 'model', instructions: 'Original instructions', acceptance: ['Explain observed evidence'] };
    const user = { kind: 'desktop' as const, id: 'test' };
    const common = { projectId: 'project', hostId: 'host' };
    expect(await workflows.execute({ ...common, expectedRevision: 0, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, user)).toMatchObject({ ok: true });
    const subproject = async () => { const result = await workflows.read('project'); if (!result.ok) throw new Error(result.message); return result.snapshot.subprojects.find((entry) => entry.id === 'sub')!; };
    const send = async (commandId: string, type: string, payload: object) => workflows.execute({ ...common, expectedRevision: (await subproject()).revision, commandId, subprojectId: 'sub', type, payload } as never, user);
    const save = (commandId: string, model = 'model') => send(commandId, 'subproject.update', { runSettings: { reviewer: { providerId: 'codex', model } } });
    const runs = () => f.ledger.read('project').runs;
    return { f, workflows, send, save, subproject, runs };
  }

  it('saves the review AI on the subproject and runs the saved flow with it, once per request', async () => {
    const { f, send, save, subproject, runs } = await launchFlow();
    expect(await save('settings')).toMatchObject({ ok: true });
    expect((await subproject()).runSettings).toEqual({ reviewer: { providerId: 'codex', model: 'model' } });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ runId: 'run-1', startedAt: expect.any(String), preparation: { reviewer: { providerId: 'codex', model: 'model' } } });
    // Its prepare and start carry ids derived from the request (81 characters in the ledger).
    expect(f.ledger.getReceipt('project', `workflow:${workflowLaunchId('launch-1')}:prepare`)).toMatchObject({ ok: true, runId: 'run-1' });
    expect(f.ledger.getReceipt('project', `workflow:${workflowLaunchId('launch-1')}:start`)).toMatchObject({ ok: true, runId: 'run-1' });
    // The same request again (even from a newer revision) is the same launch.
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(runs()).toHaveLength(1); expect(f.adapter.submit).toHaveBeenCalledOnce();
  });

  it('refuses a launch before any side effect: no review AI, a broken flow, or a run still going', async () => {
    const { f, send, save, runs, workflows } = await launchFlow();
    expect(await send('launch-a', 'run.launch', { runId: 'run-a' })).toMatchObject({ ok: false, error: 'missing-reviewer' });
    expect(runs()).toHaveLength(0);
    // Nothing was recorded for it: the same request runs once the review AI is chosen.
    expect(await save('settings')).toMatchObject({ ok: true });
    expect(await send('launch-a', 'run.launch', { runId: 'run-a' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    // One unfinished run per flow: another launch, or starting a run prepared meanwhile, waits.
    expect(await send('launch-b', 'run.launch', { runId: 'run-b' })).toMatchObject({ ok: false, error: 'active-run' });
    expect(await send('prepare-c', 'run.prepare', { runId: 'run-c', reviewer: { providerId: 'codex', model: 'model' } })).toMatchObject({ ok: true });
    expect(await send('start-c', 'run.start', { runId: 'run-c' })).toMatchObject({ ok: false, error: 'active-run' });
    // Paused still counts as going.
    expect(await send('pause-a', 'run.pause', { runId: 'run-a' })).toMatchObject({ ok: true });
    expect(await send('launch-d', 'run.launch', { runId: 'run-d' })).toMatchObject({ ok: false, error: 'active-run' });
    expect(runs().map((run) => run.runId)).toEqual(['run-a', 'run-c']);
    // Its own request is answered by what it did.
    expect(await send('launch-a', 'run.launch', { runId: 'run-a' })).toMatchObject({ ok: true, duplicate: true });
    // A flow that cannot run is refused before anything is recorded.
    const current = await workflows.read('project'); if (!current.ok) throw new Error(current.message);
    const broken = current.snapshot.subprojects.find((entry) => entry.id === 'sub')!;
    expect(await send('break', 'workflow.patch', { graph: { ...broken.graph, entryNodeId: null }, summary: 'Break' })).toMatchObject({ ok: true });
    expect(await send('launch-e', 'run.launch', { runId: 'run-e' })).toMatchObject({ ok: false, error: 'invalid-graph' });
  });

  it('replays its first intent after a lost reply, even after the review AI was changed', async () => {
    const { f, send, save, runs } = await launchFlow();
    expect(await save('settings')).toMatchObject({ ok: true });
    const rename = fs.rename.bind(fs); let writes = 0;
    const lost = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]).endsWith('workflows.json') && ++writes === 2) throw new Error('Lost the reply after the run started');
      return rename(...args);
    });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: false });
    lost.mockRestore();
    expect(await save('settings-2', 'other')).toMatchObject({ ok: true });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.preparation.reviewer).toMatchObject({ model: 'model' });
  });

  it('settles a launch whose preparation fails for good, and keeps one that could not reach the provider pending', async () => {
    const { f, send, save, runs } = await launchFlow();
    expect(await save('settings', 'missing-model')).toMatchObject({ ok: true });
    const failed = await send('launch-bad', 'run.launch', { runId: 'run-bad' });
    expect(failed).toMatchObject({ ok: false, error: 'preparation-invalid' });
    // Fixing the setting does not change what that request did: its retry answers the same without running again.
    expect(await save('settings-fixed')).toMatchObject({ ok: true });
    const execution = vi.spyOn(f.service, 'executeWorkflow');
    expect(await send('launch-bad', 'run.launch', { runId: 'run-bad' })).toEqual(failed);
    expect(execution).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
    // The provider could not be reached: the request stays open and runs once it answers.
    (f.adapter.listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Codex is offline'));
    expect(await send('launch-ok', 'run.launch', { runId: 'run-ok' })).toMatchObject({ ok: false });
    expect(execution).toHaveBeenCalledTimes(1);
    expect(await send('launch-ok', 'run.launch', { runId: 'run-ok' })).toMatchObject({ ok: true });
    expect(execution).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(runs().map((run) => run.runId)).toEqual(['run-ok']);
  });

  it('cancels the run a launch prepared when its start is refused for good, and nothing else', async () => {
    const { f, send, save, runs } = await launchFlow({ staleRuns: true });
    expect(await save('settings')).toMatchObject({ ok: true });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true });
    // The flow service missed run-1; the execution side refuses the second start and cleans up.
    expect(await send('launch-2', 'run.launch', { runId: 'run-2' })).toMatchObject({ ok: false, error: 'active-run' });
    expect(runs().find((run) => run.runId === 'run-2')).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(runs().find((run) => run.runId === 'run-2')!.startedAt).toBeUndefined();
    expect(await send('launch-2', 'run.launch', { runId: 'run-2' })).toMatchObject({ ok: false, error: 'active-run' });
    // The launch principal cancels nothing it did not prepare, and no started run.
    const cancel = (commandId: string, runId: string) => f.ledger.execute({ commandId, projectId: 'project', expectedRevision: f.ledger.read('project').revision,
      principal: { kind: 'runtime', id: 'workflow-launch' }, type: 'run.cancel', payload: { runId } });
    expect(await cancel(`workflow:${workflowLaunchId('launch-1')}:cancel`, 'run-1')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await cancel('workflow:some-other:cancel', 'run-1')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.ledger.execute({ commandId: 'launch-pause', projectId: 'project', expectedRevision: f.ledger.read('project').revision,
      principal: { kind: 'runtime', id: 'workflow-launch' }, type: 'run.pause', payload: { runId: 'run-1' } })).toMatchObject({ ok: false, error: 'user-required' });
    expect(runs().find((run) => run.runId === 'run-1')).toMatchObject({ state: 'running' });
  });

  it('lets the repeat schedule run the saved flow once a day under the host’s own principal, and nothing else', async () => {
    const { f, workflows, send, save, subproject, runs } = await launchFlow();
    expect(await save('settings')).toMatchObject({ ok: true });
    let clock = new Date('2026-10-25T23:00:00.000Z'); // 08:00 in Seoul
    const repeat = repeatService(workflows, () => clock);
    expect(await send('repeat-on', 'subproject.update', { repeat: { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true } })).toMatchObject({ ok: true });
    await repeat.start();
    clock = new Date('2026-10-26T00:00:02.000Z');
    await repeat.wake();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    const ids = repeatOccurrenceIds('project', 'sub', '2026-10-26');
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ runId: ids.runId, startedAt: expect.any(String), preparation: { reviewer: { providerId: 'codex', model: 'model' } } });
    expect(f.ledger.getReceipt('project', `workflow:${workflowLaunchId(ids.commandId)}:start`)).toMatchObject({ ok: true, runId: ids.runId });
    // A person's 다시 실행 while it goes is refused, and the schedule's next look starts nothing more.
    expect(await send('launch-by-person', 'run.launch', { runId: 'person-run' })).toMatchObject({ ok: false, error: 'active-run' });
    clock = new Date('2026-10-26T00:10:00.000Z'); await repeat.wake();
    expect(runs()).toHaveLength(1);
    // Neither the flow service nor the ledger lets the schedule do anything else with it.
    expect(await workflows.execute({ projectId: 'project', hostId: 'host', expectedRevision: (await subproject()).revision, commandId: 'schedule-cancel', subprojectId: 'sub',
      type: 'run.cancel', payload: { runId: ids.runId } }, REPEAT_SCHEDULE_PRINCIPAL)).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.ledger.execute({ commandId: 'schedule-ledger-cancel', projectId: 'project', expectedRevision: f.ledger.read('project').revision,
      principal: { kind: 'runtime', id: 'workflow-schedule' }, type: 'run.cancel', payload: { runId: ids.runId } })).toMatchObject({ ok: false, error: 'user-required' });
    expect(runs()[0]).toMatchObject({ state: 'running' });
    await repeat.dispose();
  });

  it('records a repeat day as skipped when the flow was already running, whichever side refused it', async () => {
    for (const staleRuns of [false, true]) {
      const { f, workflows, send, save, runs } = await launchFlow({ staleRuns });
      expect(await save('settings')).toMatchObject({ ok: true });
      let clock = new Date('2026-10-25T23:00:00.000Z');
      const repeat = repeatService(workflows, () => clock);
      expect(await send('repeat-on', 'subproject.update', { repeat: { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true } })).toMatchObject({ ok: true });
      await repeat.start();
      // The person's run started a minute before the schedule's time.
      expect(await send('launch-by-person', 'run.launch', { runId: 'person-run' })).toMatchObject({ ok: true });
      clock = new Date('2026-10-26T00:00:02.000Z');
      await repeat.wake();
      const ids = repeatOccurrenceIds('project', 'sub', '2026-10-26');
      const status = repeat.status(await workflows.exportRegistry('project')).sub;
      expect(status?.last).toMatchObject({ key: '2026-10-26', state: 'skipped-running' });
      expect(runs().filter((run) => run.startedAt).map((run) => run.runId)).toEqual(['person-run']);
      // The ledger side prepared the schedule's run before refusing its start: that run is cancelled.
      if (staleRuns) expect(runs().find((run) => run.runId === ids.runId)).toMatchObject({ state: 'cancelled' });
      else expect(runs().some((run) => run.runId === ids.runId)).toBe(false);
      await repeat.dispose();
      void f;
    }
  });

  it('keeps every ledger id within 160 characters without renaming the ids already in use', async () => {
    expect(workflowLedgerId('x'.repeat(151))).toBe(`workflow:${'x'.repeat(151)}`);
    expect(workflowLedgerId('x'.repeat(152))).toMatch(/^workflow:[0-9a-f]{64}$/u);
    expect(`workflow:${workflowLaunchId('y'.repeat(160))}:prepare`).toHaveLength(81);
    const { send, runs } = await launchFlow();
    expect(await send('p'.repeat(160), 'run.prepare', { runId: 'long', reviewer: { providerId: 'codex', model: 'model' } })).toMatchObject({ ok: true });
    expect(runs().map((run) => run.runId)).toEqual(['long']);
  });
});
describe('다시 실행 review fixes', () => {
  async function launchFlow() {
    const f = await fixture(false, true); const directory = f.store.getSnapshot().projects[0].rootPath!;
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: () => directory, planning: f.options.planning,
      runs: () => f.ledger.read('project').runs,
      session: (sessionId) => sessionId === 'chat' ? { projectId: 'project', managed: false } : undefined,
      conversationReviewer: (sessionId) => sessionId === 'chat' ? { providerId: 'codex', model: 'model' } : undefined,
      executeRun: (...args) => f.service.executeWorkflow(...args), executionGate: (work) => f.service.exclusive(work) });
    const graph = createWorkflowGraph('research', 'sub');
    graph.nodes[0] = { ...graph.nodes[0]!, providerId: 'codex', model: 'model', instructions: 'Original instructions', acceptance: ['Explain observed evidence'] };
    const user = { kind: 'desktop' as const, id: 'test' };
    expect(await workflows.execute({ projectId: 'project', hostId: 'host', expectedRevision: 0, commandId: 'create-sub', type: 'subproject.create', payload: { id: 'sub', title: 'Research', goal: '', presetId: 'research', graph } }, user)).toMatchObject({ ok: true });
    const revision = async () => { const result = await workflows.read('project'); if (!result.ok) throw new Error(result.message); return result.snapshot.subprojects.find((entry) => entry.id === 'sub')!.revision; };
    const send = async (commandId: string, type: string, payload: object, principal: WorkflowPrincipal = user) =>
      workflows.execute({ projectId: 'project', hostId: 'host', expectedRevision: await revision(), commandId, subprojectId: 'sub', type, payload } as never, principal);
    const save = (commandId: string, model = 'model') => send(commandId, 'subproject.update', { runSettings: { reviewer: { providerId: 'codex', model } } });
    const provider = (health: 'ready' | 'unavailable') => f.store.applySystemCommit({ mutations: [{ kind: 'provider.upsert', value: { id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health } }] });
    return { f, send, save, provider, runs: () => f.ledger.read('project').runs };
  }

  it('keeps a launch open while its provider or planning storage is unavailable, and runs it once they answer', async () => {
    const { f, send, save, provider, runs } = await launchFlow();
    expect(await save('settings')).toMatchObject({ ok: true });
    await provider('unavailable');
    // Clients keep the request pending on this one code and retry it as it was.
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: false, error: 'execution-unavailable' });
    await provider('ready');
    const storage = vi.spyOn(f.options.planning, 'captureWorkflowBaseline').mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'The planning file could not be read.' });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: false, error: 'execution-unavailable' });
    storage.mockRestore();
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(runs().map((run) => run.runId)).toEqual(['run-1']);
  });

  it('fixes an agent launch to the review AI it resolved first, so its retry is the same request', async () => {
    const { f, send, save, runs } = await launchFlow();
    const agent = { kind: 'ai' as const, id: 'session:chat', sessionId: 'chat' };
    const rename = fs.rename.bind(fs); let writes = 0;
    const lost = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]).endsWith('workflows.json') && ++writes === 2) throw new Error('Lost the reply');
      return rename(...args);
    });
    // No saved run settings: the agent's own conversation model reviews.
    expect(await send('agent-launch', 'run.launch', { runId: 'run-a' }, agent)).toMatchObject({ ok: false });
    lost.mockRestore();
    // The flow gains saved settings before the retry; the retry still answers the first request.
    expect(await save('settings', 'other')).toMatchObject({ ok: true });
    expect(await send('agent-launch', 'run.launch', { runId: 'run-a' }, agent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ startedAt: expect.any(String), preparation: { reviewer: { model: 'model' }, startedBy: { sessionId: 'chat' } } });
  });

  it('keeps a refused launch open until the run it prepared is cancelled', async () => {
    const { f, send, save, runs } = await launchFlow();
    expect(await save('settings')).toMatchObject({ ok: true });
    expect(await send('launch-1', 'run.launch', { runId: 'run-1' })).toMatchObject({ ok: true });
    // A second launch reaching the execution side (the flow side would refuse it first): its start is
    // refused while run-1 goes on, and the clean-up of the run it prepared keeps conflicting.
    const frozen = runs()[0]!.preparation.workflow!;
    const sub = { id: 'sub', title: 'Research', goal: '', status: 'active' as const, revision: frozen.revision, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
      presetId: 'research', graph: frozen.graph, history: [], archivedNodes: [] };
    const launch2 = () => f.service.executeWorkflow({ projectId: 'project', hostId: 'host', expectedRevision: frozen.revision, commandId: 'launch-2', subprojectId: 'sub', type: 'run.launch',
      payload: { runId: 'run-2', reviewer: { providerId: 'codex', model: 'model' } } }, sub, { kind: 'desktop', id: 'test' });
    // Earlier clean-up tries recorded as conflicting in the ledger itself, then more conflicts now.
    for (let index = 0; index < 7; index += 1) {
      expect(await f.ledger.execute({ commandId: `workflow:${workflowLaunchId('launch-2')}:cancel-${index}`, projectId: 'project', expectedRevision: f.ledger.read('project').revision + 9,
        principal: { kind: 'runtime', id: 'workflow-launch' }, type: 'run.cancel', payload: { runId: 'run-2' } })).toMatchObject({ ok: false, error: 'revision-conflict' });
    }
    const ledgerExecute = f.ledger.execute.bind(f.ledger);
    const conflicting = vi.spyOn(f.ledger, 'execute').mockImplementation(async (input) => String((input as { commandId?: string }).commandId).includes(':cancel')
      ? { ok: false, commandId: 'x', projectId: 'project', revision: 0, error: 'revision-conflict', message: 'Changed meanwhile.' } as never : ledgerExecute(input));
    expect(await launch2()).toMatchObject({ ok: false, error: 'execution-unavailable', transient: true });
    expect(runs().find((run) => run.runId === 'run-2')).toMatchObject({ state: 'prepared' });
    conflicting.mockRestore();
    // The same request again: still refused (run-1 goes on), and now the prepared run is cancelled and the refusal settles.
    const again = await launch2();
    expect(again).toMatchObject({ ok: false, error: 'active-run' });
    expect(again).not.toHaveProperty('transient');
    expect(runs().find((run) => run.runId === 'run-2')).toMatchObject({ state: 'cancelled' });
    // The refusal is recorded with the start itself: this launch never starts, whatever happens to run-1.
    expect(f.ledger.getReceipt('project', `workflow:${workflowLaunchId('launch-2')}:start`)).toMatchObject({ ok: false, error: 'active-run' });
    expect(runs().find((run) => run.runId === 'run-2')!.startedAt).toBeUndefined();
  });

  it('answers a refused prepare and a repeated legacy start from their receipts', async () => {
    const f = await fixture();
    Object.assign(f.options, { ownsSubproject: async () => true });
    const revision = () => f.ledger.read('project').revision;
    const scoped = { ...f.prepare, subprojectId: 'legacy-default' } as PlanningRunRequest;
    expect(await f.send(scoped)).toMatchObject({ ok: true });
    const start = { commandId: 'start-a', projectId: 'project', expectedRevision: revision(), subprojectId: 'legacy-default', type: 'start', payload: { runId: 'run' } } as PlanningRunRequest;
    expect(await f.send(start)).toMatchObject({ ok: true });
    // The original start, sent again, is answered by its receipt.
    expect(await f.send(start)).toMatchObject({ ok: true });
    // Another run of the same subproject cannot start while this one goes on.
    const preparation = f.ledger.read('project', { frozen: true }).runs[0]!.preparation;
    expect(await f.ledger.execute({ commandId: 'ledger-prepare-c', projectId: 'project', expectedRevision: revision(), principal: { kind: 'desktop', id: 'test' }, type: 'run.prepare', payload: { runId: 'run-c', preparation } })).toMatchObject({ ok: true });
    // (The dispatch of run A writes to the ledger meanwhile: a start sent on a stale revision is sent again.)
    let refusal: Awaited<ReturnType<typeof f.send>> | undefined;
    for (let attempt = 0; attempt < 5 && (!refusal || (!refusal.ok && refusal.error === 'revision-conflict')); attempt += 1) {
      refusal = await f.send({ commandId: `start-c-${attempt}`, projectId: 'project', expectedRevision: revision(), subprojectId: 'legacy-default', type: 'start', payload: { runId: 'run-c' } } as PlanningRunRequest);
    }
    expect(refusal).toMatchObject({ ok: false, error: 'active-run' });

    // A flow prepare the ledger refused answers that refusal on retry (it made no run to compare).
    const refused = await f.ledger.execute({ commandId: workflowLedgerId('refused-prepare'), projectId: 'project', expectedRevision: revision() + 5, principal: { kind: 'desktop', id: 'test' }, type: 'run.prepare', payload: { runId: 'run-x', preparation } });
    expect(refused).toMatchObject({ ok: false });
    const retried = await f.service.executeWorkflow({ projectId: 'project', hostId: 'host', expectedRevision: 0, commandId: 'refused-prepare', subprojectId: 'sub', type: 'run.prepare', payload: { runId: 'run-x', reviewer: { providerId: 'codex', model: 'model' } } },
      { id: 'sub' } as never, { kind: 'desktop', id: 'test' });
    expect(retried).toEqual({ ok: false, error: refused.ok ? '' : refused.error, message: refused.ok ? '' : refused.message });
  });
});
