import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ExecutionPreparation, ExecutionRun, PreparedExecutionTask } from '../shared/planning-execution';
import type { AgentProviderAdapter, AgentProviderEvent } from './agent-provider-adapter';
import { AgentProviderRegistry } from './agent-provider-registry';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';
import { PlanningExecutionStore } from './planning-execution-store';
import { PlanningResultService } from './planning-result-service';
import { PlanningResultRepository, resultHash } from './planning-result-repository';
import { GitRunner, WorktreeService } from './worktree-service';
import { createWorkflowGraph } from '../shared/workflow';
import { workflowDigest } from './workflow-service';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const NOW = '2026-10-13T00:00:00.000Z';
const baseline = { baselineId: 'B', revision: 6, fingerprint: 'a'.repeat(64) };
const check = "const fs=require('node:fs');if(fs.readFileSync('src/a.txt','utf8')!=='updated')process.exit(7);console.log('verified exact file')";
const validations: PreparedExecutionTask['validations'] = [
  { validationId: 'command', acceptanceIds: ['AC'], method: 'command', environment: process.platform, command: check },
  { validationId: 'inspection', acceptanceIds: ['AC'], method: 'inspection', environment: 'read-only review' },
];

async function fixture(options: { policy?: ExecutionPreparation['progressPolicy']; validations?: PreparedExecutionTask['validations']; workflow?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-result-'));
  const root = path.join(directory, 'repo');
  const userDataDir = path.join(directory, 'data');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const git = new GitRunner();
  await git.run(root, ['init', '-b', 'main']);
  await git.run(root, ['config', 'user.name', 'Result test']);
  await git.run(root, ['config', 'user.email', 'test@localhost']);
  await fs.writeFile(path.join(root, 'src/a.txt'), 'base');
  await fs.writeFile(path.join(root, 'keep.txt'), 'original');
  await git.run(root, ['add', '.']);
  await git.run(root, ['commit', '-m', 'base']);
  const baseCommit = (await git.run(root, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(root, 'keep.txt'), 'user uncommitted work');
  const worktrees = new WorktreeService({ userDataDir, gitRunner: git });
  await worktrees.init();
  const created = await worktrees.execute({ action: 'create', cwd: root, branch: 'worker', base: baseCommit, allowDirtyBase: true }, 'desktop');
  if (!created.ok || !created.opened) throw new Error(JSON.stringify(created));
  const worker = created.opened.path;
  const store = new DaemonStore(userDataDir);
  await store.init();
  const ledger = new PlanningExecutionStore(store);
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const adapter: AgentProviderAdapter = {
    providerId: 'codex', probe: vi.fn(),
    listModels: vi.fn(async () => [{ id: 'model', displayName: 'Model', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }]),
    createSession: vi.fn(async context => ({ sessionId: context.sessionId, providerSessionId: `provider-${context.sessionId}`, model: context.model, permissionPreset: context.permissionPreset })),
    resumeSession: vi.fn(async context => ({ sessionId: context.sessionId, providerSessionId: context.providerSessionId, model: context.model, permissionPreset: context.permissionPreset })),
    submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), setSettings: vi.fn(), resolveApproval: vi.fn(),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
  };
  const providers = new AgentProviderRegistry([adapter]);
  const runtime: DaemonAgentRuntime = new DaemonAgentRuntime({ providers, getSnapshot: () => daemon.getSnapshot(),
    applySystemCommit: commit => daemon.applySystemCommit(commit), applySystemTransition: transition => daemon.applySystemTransition(transition),
    readTranscript: (...args) => daemon.readTranscript(...args), findCommand: id => store.findCommand(id)?.command,
    preparedSessionSettings: id => service.preparedSessionSettings(id),
  });
  const daemon = new DaemonCommandRouter(store, { handlers: runtime.handlers() });
  const runner = { run: vi.fn(async (cwd: string, script: string) => new Promise<{ exitCode: number; durationMs: number; outputTail: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean }>(resolve => {
    execFile(process.execPath, ['-e', script], { cwd, windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => resolve({ exitCode: error ? Number(error.code) || 1 : 0, durationMs: 1,
      outputTail: `${stdout}${stderr}`, outputTruncated: false, timedOut: false, cancelled: false }));
  })) };
  const errors: unknown[] = [];
  const wakeExecution = vi.fn();
  const service = new PlanningResultService({ userDataDir, store, daemon, ledger, git, worktrees, validationRunner: runner,
    wakeQueuedTurns: () => runtime.wakeQueuedTurns(), reportError: error => errors.push(error), wakeExecution });
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: 'P', name: 'Project', source: 'native', rootPath: root } },
    { kind: 'workspace.upsert', value: { id: 'W', projectId: 'P', name: 'Worker', kind: 'worktree', rootPath: worker } },
    { kind: 'provider.upsert', value: { id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' } },
    { kind: 'session.upsert', value: { id: 'S', projectId: 'P', workspaceId: 'W', kind: 'agent', title: 'Worker', state: 'running', source: 'structured' } },
    { kind: 'agent.upsert', value: { sessionId: 'S', providerId: 'codex', model: 'model', permissionPreset: 'standard', state: 'working', queuedTurnCount: 0, orchestrationEnabled: false } },
  ] });
  const preparation: ExecutionPreparation = { baseline, baseCommit, artifacts: [], teamMode: 'single', progressPolicy: options.policy ?? 'checkpoint',
    reviewer: { profileId: 'review', revision: 1, role: 'review', providerId: 'codex', model: 'model', prompt: 'Review independently', permissionPreset: 'plan', capabilities: ['read'], reasoningEffort: 'high' },
    tasks: [{ taskId: 'T', taskRevision: 6, stage: 'implementation', title: 'Implement', brief: 'Update a', dependsOn: [], allowedPaths: ['src'], retryLimit: 2,
      profile: { profileId: 'impl', revision: 1, role: 'implementation', providerId: 'codex', model: 'model', prompt: 'Implement', permissionPreset: 'standard', capabilities: ['write'] },
      acceptance: [{ acceptanceId: 'AC', description: 'Correct file' }], validations: options.validations ?? validations }],
  };
  if (options.workflow) {
    const graph = createWorkflowGraph('research', 'sub'); const task = preparation.tasks[0];
    graph.nodes[0] = { ...graph.nodes[0], id: 'T', role: 'implementation', providerId: 'codex', model: 'model', permissionPreset: 'standard', allowedPaths: ['src'], instructions: 'Implement', acceptance: ['Correct file'] };
    graph.entryNodeId = 'T'; graph.edges[0].from = 'T';
    Object.assign(preparation, { subprojectId: 'sub', workflow: { subprojectId: 'sub', revision: 0, fingerprint: workflowDigest(graph), graph } });
    expect(task.taskId).toBe('T');
  }
  let sequence = 0;
  const send = (type: string, payload: Record<string, unknown>, principal = 'desktop') => ledger.execute({ commandId: `command-${++sequence}`, projectId: 'P', expectedRevision: ledger.read('P').revision,
    principal: { kind: principal, id: 'test' }, type, payload: { runId: 'R', ...payload } });
  expect(await send('run.prepare', { preparation })).toMatchObject({ ok: true });
  expect(await send('run.start', {})).toMatchObject({ ok: true });
  await store.beginOutbox(createDaemonCommand({ commandId: 'worker-submit', idempotencyKey: 'worker-submit', expectedRevision: store.getRevision(), issuedAt: NOW,
    principal: { kind: 'desktop', id: 'test' }, type: 'agent.submit', payload: { sessionId: 'S', prompt: 'Work' } }));
  await store.commitCommand('worker-submit', { mutations: [{ kind: 'turn.upsert', value: { id: 'worker-turn', sessionId: 'S', commandId: 'worker-submit', state: 'working' } }] });
  expect(await send('attempt.start', { attemptId: 'A', taskId: 'T', dispatchId: 'D', sessionId: 'S', turnId: 'worker-turn' }, 'runtime')).toMatchObject({ ok: true });
  const current = () => ledger.read('P').runs[0];
  await service.prepareWorkspace(current(), preparation.tasks[0], worker);
  await runtime.start();
  cleanups.push(async () => { await service.dispose(); await runtime.dispose('process-loss'); await store.close(); });
  const capture = async (content = 'updated') => {
    await fs.writeFile(path.join(worker, 'src/a.txt'), content);
    const artifacts = await service.captureResult(current(), preparation.tasks[0], current().attempts[0]);
    expect(await send('attempt.finish', { attemptId: 'A', outcome: 'succeeded', artifacts, summary: 'Result' }, 'runtime')).toMatchObject({ ok: true });
    return artifacts;
  };
  const review = async (decision = 'approve', fingerprint = baseline.fingerprint, realProvider = false) => {
    await service.processReview(current(), preparation.tasks[0], current().attempts[0]); await service.whenIdle();
    await vi.waitFor(() => expect(vi.mocked(adapter.submit).mock.calls.length).toBeGreaterThan(0));
    await runtime.whenIdle();
    const record = await service.readResult('P', 'A');
    const turn = daemon.getSnapshot().turns.find(entry => entry.id === record!.reviewerTurnId)!;
    const output = `EZTERMINAL_REVIEW_JSON\n${JSON.stringify({ schemaVersion: 1, baselineFingerprint: fingerprint,
      artifactIds: record!.artifacts.map(entry => entry.artifactId), decision, summary: 'Independent exact result inspection',
      inspections: preparation.tasks[0].validations.filter(entry => entry.method === 'inspection').map(entry => ({ validationId: entry.validationId, status: 'passed', summary: 'Inspected exact diff' })) })}`;
    const half = Math.floor(output.length / 2);
    const rows = realProvider
      ? [{ text: output.slice(0, half), isDelta: true }, { text: output.slice(half), isDelta: true }, { text: output, isDelta: false }]
      : [{ text: output, isDelta: false }];
    rows.forEach((row, index) => { for (const listener of listeners) listener({ kind: 'transcript', item: { id: `review-output-${turn.id}-${index}`, sessionId: turn.sessionId, turnId: turn.id, sequence: index + 1,
      kind: 'assistant-message', text: row.text, isDelta: row.isDelta, isSensitive: realProvider, ...(realProvider ? { messageId: `review-message-${turn.id}` } : {}), createdAt: NOW } }); });
    for (const listener of listeners) listener({ kind: 'turn-finished', sessionId: turn.sessionId, turnId: turn.id, outcome: 'completed' });
    await runtime.whenIdle();
    await vi.waitFor(() => expect(daemon.getSnapshot().turns.find(entry => entry.id === turn.id)?.state).toBe('completed'));
    await service.processReview(current(), preparation.tasks[0], current().attempts[0]); await service.whenIdle();
  };
  const approve = () => service.decideReview({ commandId: 'user-approve', projectId: 'P', expectedRevision: ledger.read('P').revision,
    type: 'review', payload: { runId: 'R', attemptId: 'A', decision: 'approve', detail: 'Accept independently checked result' } }, { kind: 'desktop', id: 'test' });
  return { root, worker, git, service, current, preparation, capture, review, approve, errors, runner, adapter, send, daemon, baseCommit, worktrees, userDataDir, wakeExecution, revision: () => ledger.read('P').revision };
}

describe('planning result authority', () => {
  it('captures the exact read-only planning text in a Git project for independent review and downstream stages', async () => {
    const f = await fixture({ validations: [validations[1]] });
    const task = { ...f.preparation.tasks[0], profile: { ...f.preparation.tasks[0].profile, permissionPreset: 'plan' as const }, allowedPaths: [] };
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [{ id: 'planning-output', sessionId: 'S', turnId: 'worker-turn', sequence: 1, kind: 'assistant-message', text: 'Approved planning output: use a durable inbox.', isDelta: false, isSensitive: false, createdAt: NOW }] }] });
    const artifacts = await f.service.captureResult(f.current(), task, f.current().attempts[0]);
    const record = await f.service.readResult('P', 'A');
    expect(record?.transcript).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Approved planning output: use a durable inbox.' })]));
    expect(artifacts.some(artifact => artifact.artifactId.startsWith('transcript:'))).toBe(true);
  }, 30_000);
  it('captures a real provider reply once (marked sensitive, streamed) without its command output, and reads its sensitive review', async () => {
    const f = await fixture({ validations: [validations[1]] });
    const task = { ...f.preparation.tasks[0], profile: { ...f.preparation.tasks[0].profile, permissionPreset: 'plan' as const }, allowedPaths: [] };
    // Codex and Claude mark every user, assistant and reasoning row sensitive (metadata, not a hide rule) and stream deltas.
    const row = (sequence: number, kind: 'user-message' | 'assistant-message' | 'tool-result', text: string, extra: { isDelta?: boolean; messageId?: string } = {}) =>
      ({ id: `real-${sequence}`, sessionId: 'S', turnId: 'worker-turn', sequence, kind, text, isDelta: false, isSensitive: true, createdAt: NOW, ...extra });
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [
      row(1, 'user-message', 'Summarise the folder.'),
      row(2, 'assistant-message', 'I will read ', { isDelta: true, messageId: 'm1' }), row(3, 'assistant-message', 'the files.', { isDelta: true, messageId: 'm1' }),
      row(4, 'assistant-message', 'I will read the files.', { messageId: 'm1' }),
      row(5, 'tool-result', 'command output that stays out of results'),
      row(6, 'assistant-message', 'Two-line ', { isDelta: true, messageId: 'm2' }), row(7, 'assistant-message', 'summary.', { isDelta: true, messageId: 'm2' }),
    ] }] });
    const artifacts = await f.service.captureResult(f.current(), task, f.current().attempts[0]);
    const record = await f.service.readResult('P', 'A');
    expect(record?.transcript?.map(item => [item.kind, item.text])).toEqual([['assistant-message', 'I will read the files.'], ['assistant-message', 'Two-line summary.']]);
    expect(await f.send('attempt.finish', { attemptId: 'A', outcome: 'succeeded', artifacts, summary: 'Result' }, 'runtime')).toMatchObject({ ok: true });
    await f.review('approve', undefined, true);
    expect((await f.service.readResult('P', 'A'))?.review?.decision).toBe('approve');
  }, 30_000);
  it('gives a review another pass when it was asked for while the previous pass was still running', async () => {
    // A fast reviewer can finish before the pass that started it returns; that completion's request
    // must not be lost, or the stage waits in review for an unrelated later event.
    const f = await fixture({ validations: [validations[1]] });
    await f.capture();
    f.wakeExecution.mockClear();
    void f.service.processReview(f.current(), f.preparation.tasks[0], f.current().attempts[0]);
    void f.service.processReview(f.current(), f.preparation.tasks[0], f.current().attempts[0]);
    await f.service.whenIdle();
    expect(f.wakeExecution).toHaveBeenCalled();
  }, 30_000);
  it('quotes only exact accepted activation text, retains outer-loop inputs and blocks tampered or oversized output', async () => {
    const f = await fixture({ validations: [validations[1]] });
    const template = createWorkflowGraph('research', 'input').nodes[0];
    const graph = { entryNodeId: 'source', nodes: ['source', 'outer', 'other', 'consumer'].map(id => ({ ...template, id, inputs: id === 'consumer' ? [{ nodeId: 'source', kind: 'result' as const }, { nodeId: 'outer', kind: 'result' as const }] : [] })), edges: [] };
    const original = f.current(); const sourceTask = original.preparation.tasks[0];
    const chosen = [{ node: 'source', attempt: 'old', text: 'OLD LOOP OUTPUT' }, { node: 'source', attempt: 'chosen', text: 'CURRENT ACCEPTED OUTPUT' }, { node: 'outer', attempt: 'retained', text: 'ACCEPTED OUTSIDE LOOP' }, { node: 'other', attempt: 'unselected', text: 'UNSELECTED BRANCH OUTPUT' }];
    const attempts = []; const reviews = [];
    for (const input of chosen) {
      // 'outer' was answered by a real provider: its reply carries the sensitive marker and is still quoted.
      const transcript = [{ id: `text-${input.attempt}`, sessionId: 'S', turnId: 'worker-turn', sequence: 1, kind: 'assistant-message' as const, text: input.text, isDelta: false, isSensitive: input.node === 'outer', createdAt: NOW }];
      const artifacts = [{ artifactId: `transcript:${resultHash(transcript)}`, revision: 0 }];
      attempts.push({ ...original.attempts[0], taskId: input.node, attemptId: input.attempt, state: 'succeeded' as const, artifacts });
      reviews.push({ reviewId: `review-${input.attempt}`, attemptId: input.attempt, baseline: original.preparation.baseline, reviewerSessionId: 'reviewer', reviewerTurnId: 'review-turn', decidedBy: 'reviewer', artifacts, evidenceIds: [], decision: 'approve' as const, detail: 'Accepted exact result', decidedAt: NOW });
      await f.service.repository.saveResult({ version: 1, projectId: 'P', runId: 'R', taskId: input.node, attemptId: input.attempt, baselineFingerprint: original.preparation.baseline.fingerprint, artifacts, transcript, rootPath: f.worker, changedPaths: [], validations: [] });
    }
    const consumer = { ...sourceTask, taskId: 'consumer', dependsOn: ['source', 'outer', 'other'] };
    const run: ExecutionRun = { ...original, attempts, reviews,
      preparation: { ...original.preparation, workflow: { subprojectId: 'sub', revision: 0, fingerprint: workflowDigest(graph), graph }, tasks: [...['source', 'outer', 'other'].map(taskId => ({ ...sourceTask, taskId, profile: { ...sourceTask.profile, permissionPreset: 'plan' as const } })), consumer] },
      workflowRuntime: { completed: false, edgeCounts: {}, activations: [{ id: 'consumer:1', nodeId: 'consumer', iteration: 1, state: 'active', incomingEdgeIds: [], inputResults: { source: { attemptId: 'chosen', outcome: 'passed' }, outer: { attemptId: 'retained', outcome: 'passed' } } }] } };
    const output = await f.service.workflowResultContext(run, consumer, 100_000);
    expect(output).toContain('CURRENT ACCEPTED OUTPUT'); expect(output).toContain('ACCEPTED OUTSIDE LOOP');
    expect(output).not.toContain('OLD LOOP OUTPUT'); expect(output).not.toContain('UNSELECTED BRANCH OUTPUT');
    await expect(f.service.workflowResultContext(run, consumer, 20)).rejects.toThrow('nothing was truncated or sent');
    const exact = (await f.service.readResult('P', 'chosen'))!;
    expect(exact.transcript?.[0].text).toBe('CURRENT ACCEPTED OUTPUT');
    await f.service.repository.saveResult({ ...exact, transcript: exact.transcript!.map(item => ({ ...item, text: 'TAMPERED AFTER REVIEW' })) });
    await expect(f.service.workflowResultContext(run, consumer, 100_000)).rejects.toThrow('artifact identity');
    await f.service.repository.saveResult({ ...exact, runId: 'foreign-run' });
    await expect(f.service.workflowResultContext(run, consumer, 100_000)).rejects.toThrow('exact independently accepted');
  }, 30_000);
  it('keeps cancellation pending until an independent reviewer acknowledges and rejects its late acceptance', async () => {
    const f = await fixture({ workflow: true }); await f.capture();
    await f.service.processReview(f.current(), f.preparation.tasks[0], f.current().attempts[0]); await f.service.whenIdle();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    const record = (await f.service.readResult('P', 'A'))!;
    expect(await f.send('run.cancel', {})).toMatchObject({ ok: true }); expect(f.current().state).toBe('paused');
    expect(await f.service.cancelReviews(f.current())).toBe(true); expect(f.adapter.interrupt).toHaveBeenCalled();
    const turn = f.daemon.getSnapshot().turns.find(value => value.id === record.reviewerTurnId)!;
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'turn.upsert', value: { ...turn, state: 'interrupted' } }] });
    expect(await f.service.cancelReviews(f.current())).toBe(false);
    expect(await f.send('run.cancel-reconcile', {}, 'runtime')).toMatchObject({ ok: true }); expect(f.current().state).toBe('cancelled');
    expect(await f.approve()).toMatchObject({ ok: false });
    const adopt = vi.spyOn(f.service.repository, 'adoptIntegration'); await f.service.processIntegration(f.current()); await f.service.whenIdle(); expect(adopt).not.toHaveBeenCalled();
  }, 60_000);
  it('never adopts a workflow during approval or after completion until an explicit integration command', async () => {
    const f = await fixture({ workflow: true }); const adopt = vi.spyOn(f.service.repository, 'adoptIntegration');
    await f.capture(); await f.review(); expect(await f.approve()).toMatchObject({ ok: true });
    expect(f.current().workflowRuntime?.activations).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'awaiting-approval' })]));
    await f.service.processIntegration(f.current()); await f.service.whenIdle(); expect(adopt).not.toHaveBeenCalled();
    const activation = f.current().workflowRuntime!.activations.find(value => value.state === 'awaiting-approval')!;
    expect(await f.send('workflow.approve', { activationId: activation.id, decision: 'approve' })).toMatchObject({ ok: true });
    expect(f.current().state).toBe('completed');
    await f.service.processIntegration(f.current()); await f.service.whenIdle(); expect(adopt).not.toHaveBeenCalled();
    expect(await f.send('workflow.integrate', {}, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('workflow.integrate', {})).toMatchObject({ ok: true });
    await f.service.processIntegration(f.current()); await f.service.whenIdle(); expect(adopt).toHaveBeenCalledOnce();
    expect(await f.service.readIntegration('P', 'R')).toMatchObject({ status: 'passed' });
  }, 60_000);
  it('captures exact owned changes, preserves the dirty original and requires an independent read-only review before integration', async () => {
    const f = await fixture();
    const artifacts = await f.capture();
    expect(await f.git.run(f.root, ['show', `${artifacts[0].artifactId.slice(4)}:src/a.txt`])).toBe('updated');
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('user uncommitted work');
    expect((await f.git.run(f.worker, ['rev-parse', 'HEAD'])).trim()).toBe(f.baseCommit);
    expect(f.current().state).not.toBe('completed');
    expect(await f.approve()).toMatchObject({ ok: false, error: 'stale-review' });
    await f.review();
    expect(f.errors).toEqual([]);
    expect(f.adapter.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionPreset: 'plan', model: 'model', reasoningEffort: 'high' }), expect.any(AbortSignal));
    const record = await f.service.readResult('P', 'A');
    expect(record!.reviewerSessionId).not.toBe('S');
    expect(f.service.preparedSessionSettings(record!.reviewerSessionId!)).toEqual({ reasoningEffort: 'high', managedExecution: true });
    expect(record!.validations.map(entry => entry.status)).toEqual(['passed', 'passed']);
    expect(await f.service.readLog('P', record!.validations[0].logRefs[0])).toContain('verified exact file');
    expect(await f.service.readDiff('P', 'A')).toContain('+updated');
    expect(await f.approve()).toMatchObject({ ok: true });
    await f.service.processIntegration(f.current()); await f.service.whenIdle();
    const integrated = await f.service.readIntegration('P', 'R');
    expect(integrated).toMatchObject({ status: 'passed', inputArtifacts: artifacts });
    expect(f.runner.run).toHaveBeenCalledTimes(2);
    expect((await f.git.run(f.root, ['rev-parse', 'HEAD'])).trim()).toBe(f.baseCommit);
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('user uncommitted work');
    const conflictWorkspace = await f.service.repository.workspace('P', 'conflicting-result', f.baseCommit);
    await fs.writeFile(path.join(conflictWorkspace, 'src/a.txt'), 'conflict');
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'workspace.upsert', value: { id: 'conflict-W', projectId: 'P', name: 'Candidate', kind: 'worktree', rootPath: conflictWorkspace } }] });
    const conflicting = await f.service.repository.capture(f.current(), f.preparation.tasks[0], { ...f.current().attempts[0], attemptId: 'conflict-A', workspaceId: 'conflict-W' });
    const failed = await f.service.repository.integrationCandidate(f.current(), [...artifacts, ...conflicting.artifacts]);
    expect(failed).toMatchObject({ status: 'failed', previousSuccessfulCommit: integrated!.successfulCommit });
    expect((await f.git.run(failed!.workspacePath, ['status', '--porcelain'])).trim()).not.toBe('');
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('user uncommitted work');
  }, 60_000);

  it('rejects out-of-scope and hidden staged changes without resetting either checkout', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.worker, 'keep.txt'), 'outside');
    await expect(f.capture()).rejects.toThrow(/outside/u);
    await f.git.run(f.worker, ['add', 'keep.txt']);
    await fs.writeFile(path.join(f.worker, 'keep.txt'), 'original');
    await expect(f.capture()).rejects.toThrow(/staged result/u);
    expect(await f.git.run(f.worker, ['show', ':keep.txt'])).toBe('outside');
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('user uncommitted work');
  }, 30_000);

  it('records real failing command evidence and automatically rejects it even when the reviewer approves', async () => {
    const f = await fixture({ policy: 'autonomous' });
    await f.capture('wrong'); await f.review();
    expect(f.errors).toEqual([]);
    expect(f.current().evidence).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed', exitCode: 7 })]));
    expect(f.current().reviews).toMatchObject([{ decision: 'reject' }]);
    expect(f.current().tasks[0].state).toBe('failed');
    expect(await f.service.readIntegration('P', 'R')).toBeNull();
  }, 30_000);

  it('does not invent device evidence or execute a performance benchmark', async () => {
    const f = await fixture({ policy: 'autonomous', validations: [
      ...validations,
      { validationId: 'device', acceptanceIds: ['AC'], method: 'device', environment: 'Android physical device' },
      { validationId: 'benchmark', acceptanceIds: ['AC'], method: 'command', environment: process.platform, command: 'pnpm e2e:performance' },
    ] });
    await f.capture(); await f.review();
    expect(f.runner.run).toHaveBeenCalledOnce();
    expect(f.current().evidence.filter(entry => entry.status === 'not-run').map(entry => entry.validationId)).toEqual(['device', 'benchmark']);
    expect(f.current().reviews).toEqual([]);
    expect(await f.approve()).toMatchObject({ ok: false });
  }, 30_000);

  it('rejects a reviewer decision for a different frozen baseline', async () => {
    const f = await fixture({ policy: 'autonomous' });
    await f.capture(); await f.review('approve', 'b'.repeat(64));
    expect(f.current().reviews).toEqual([]);
    expect((await f.service.readResult('P', 'A'))?.error).toContain('exact result');
    expect(await f.approve()).toMatchObject({ ok: false });
    const record = (await f.service.readResult('P', 'A'))!;
    const turn = f.daemon.getSnapshot().turns.find(entry => entry.id === record.reviewerTurnId)!;
    const retry = { commandId: 'retry-review-1', projectId: 'P', expectedRevision: f.current().revision,
      type: 'retry-review' as const, payload: { runId: 'R', attemptId: 'A' } };
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'turn.upsert', value: { ...turn, state: 'delivery-uncertain' } }] });
    expect(await f.service.retryReview(retry, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false });
    expect(f.adapter.submit).toHaveBeenCalledOnce();
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'turn.upsert', value: { ...turn, state: 'completed' } }] });
    expect(await f.service.retryReview(retry, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    await f.service.whenIdle();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledTimes(2));
    expect(await f.service.retryReview(retry, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true, replayed: true });
    expect(await f.service.retryReview({ ...retry, payload: { ...retry.payload, attemptId: 'different' } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false, error: 'command-conflict' });
    expect((await f.service.readResult('P', 'A'))?.reviewAttempt).toBe(1);
    expect((await f.service.readResult('P', 'A'))?.reviewerSessionId).not.toBe(record.reviewerSessionId);
  }, 30_000);

  it('applies a failed artifact for repair while retaining the original result base', async () => {
    const f = await fixture();
    const previous = await f.capture('wrong');
    const created = await f.worktrees.execute({ action: 'create', cwd: f.root, branch: 'repair', base: f.baseCommit, allowDirtyBase: true }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('Repair workspace missing');
    const repairRoot = created.opened.path;
    await f.service.repository.prepareWorkspace(f.current(), f.preparation.tasks[0], repairRoot, [], previous);
    expect(await fs.readFile(path.join(repairRoot, 'src/a.txt'), 'utf8')).toBe('wrong');
    await fs.writeFile(path.join(repairRoot, 'src/a.txt'), 'updated');
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'workspace.upsert', value: { id: 'repair-W', projectId: 'P', name: 'Repair', kind: 'worktree', rootPath: repairRoot } }] });
    const repaired = await f.service.repository.capture(f.current(), f.preparation.tasks[0], { ...f.current().attempts[0], attemptId: 'A2', workspaceId: 'repair-W' });
    expect(repaired.baseCommit).toBe(f.baseCommit);
    expect(await f.git.run(f.root, ['show', `${repaired.commit}:src/a.txt`])).toBe('updated');
    expect(await f.git.run(f.root, ['show', `${previous[0].artifactId.slice(4)}:src/a.txt`])).toBe('wrong');
  }, 30_000);

  it('keeps timed-out checks unverified without starting an autonomous repair', async () => {
    const f = await fixture({ policy: 'autonomous' });
    f.runner.run.mockResolvedValue({ exitCode: 1, durationMs: 10, outputTail: 'timeout', outputTruncated: false, timedOut: true, cancelled: false });
    await f.capture(); await f.review();
    expect(f.current().evidence[0]).toMatchObject({ status: 'not-run' });
    expect(f.current().reviews).toEqual([]);
    expect(f.current().tasks[0].state).toBe('awaiting-review');
  }, 30_000);

  it('accepts a genuinely empty reviewed Git result and integrates without a cherry-pick dead end', async () => {
    const f = await fixture({ policy: 'autonomous', validations: [validations[1]] });
    await f.capture('base'); await f.review();
    expect(f.current().reviews).toMatchObject([{ decision: 'approve' }]);
    await f.service.processIntegration(f.current()); await f.service.whenIdle();
    expect(await f.service.readIntegration('P', 'R')).toMatchObject({ status: 'passed' });
    expect(f.errors).toEqual([]);
  }, 30_000);

  it('rejects index-only symlinks and preserves a foreign initial integration ref', async () => {
    const f = await fixture();
    const blob = (await f.git.run(f.worker, ['hash-object', '-w', 'keep.txt'])).trim();
    await f.git.run(f.worker, ['update-index', '--add', '--cacheinfo', `120000,${blob},src/link`]);
    await expect(f.capture()).rejects.toThrow(/symlink|gitlink/u);
    await f.git.run(f.worker, ['update-index', '--force-remove', 'src/link']);
    const artifacts = await f.capture();
    const candidate = (await f.service.repository.integrationCandidate(f.current(), artifacts))!;
    const ref = `refs/ezterminal/integrations/${resultHash(['P', 'R'])}`;
    await f.git.run(f.root, ['update-ref', ref, f.baseCommit]);
    await expect(f.service.repository.adoptIntegration(candidate)).rejects.toThrow(/changed/u);
    expect((await f.git.run(f.root, ['rev-parse', ref])).trim()).toBe(f.baseCommit);
  }, 30_000);

  it('reconciles a crash after Git cherry-pick without applying the prerequisite twice', async () => {
    const f = await fixture();
    const artifacts = await f.capture();
    const target = await f.service.repository.workspace('P', 'dependency-crash', f.baseCommit);
    let crash = true;
    const interrupted = new PlanningResultRepository({ userDataDir: f.userDataDir, worktrees: f.worktrees,
      getSnapshot: () => f.daemon.getSnapshot(), readTranscript: (...args) => f.daemon.readTranscript(...args),
      git: { run: async (cwd, args, signal) => {
        const output = await f.git.run(cwd, args, signal);
        if (args.includes('cherry-pick') && crash) { crash = false; throw new Error('Simulated process loss after Git commit'); }
        return output;
      } },
    });
    await expect(interrupted.prepareWorkspace(f.current(), f.preparation.tasks[0], target, artifacts)).rejects.toThrow(/process loss/u);
    const head = (await f.git.run(target, ['rev-parse', 'HEAD'])).trim();
    await f.service.repository.prepareWorkspace(f.current(), f.preparation.tasks[0], target, artifacts);
    expect((await f.git.run(target, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await fs.readFile(path.join(target, 'src/a.txt'), 'utf8')).toBe('updated');
  }, 30_000);

  it('registers attested exact device proof, replaces old unrun evidence and independently reviews a new generation before exact integration evidence', async () => {
    const f = await fixture({ validations: [...validations, { validationId: 'device', acceptanceIds: ['AC'], method: 'device', environment: 'Android physical device', command: 'maestro test smoke.yaml' }] });
    const artifacts = await f.capture(); await f.review();
    const old = (await f.service.readResult('P', 'A'))!;
    expect(await f.approve()).toMatchObject({ ok: false });
    const input = { scope: 'attempt' as const, runId: 'R', taskId: 'T', attemptId: 'A', validationId: 'device', baselineFingerprint: baseline.fingerprint,
      artifactIds: artifacts.map(entry => entry.artifactId), deviceId: 'test-emulator-5554', platformVersion: 'Android 15 API35', appVersion: '2.0.0 (76)',
      command: 'maestro test smoke.yaml', exitCode: 0, startedAt: '2026-10-13T00:00:00.000Z', finishedAt: '2026-10-13T00:01:00.000Z',
      summary: 'User ran smoke against this exact commit.', textLog: 'Smoke: passed; user supplied log', attest: true as const,
      capture: { mimeType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JX8AAAAASUVORK5CYII=' } };
    const request = { commandId: 'device-proof', projectId: 'P', expectedRevision: f.revision(), type: 'record-device-evidence' as const, payload: input };
    expect(await f.service.recordDeviceEvidence({ ...request, payload: { ...input, artifactIds: ['git:wrong'] } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false });
    expect(await f.service.recordDeviceEvidence({ ...request, payload: { ...input, textLog: 'x'.repeat(512 * 1024 + 1) } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false });
    const previousTurn = f.daemon.getSnapshot().turns.find(entry => entry.id === old.reviewerTurnId)!;
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'turn.upsert', value: { ...previousTurn, state: 'delivery-uncertain' } }] });
    expect(await f.service.recordDeviceEvidence(request, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false, message: expect.stringContaining('uncertain') });
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'turn.upsert', value: previousTurn }] });
    const registered = await f.service.recordDeviceEvidence(request, { kind: 'desktop', id: 'test' });
    expect(registered, JSON.stringify(registered)).toMatchObject({ ok: true });
    await f.service.whenIdle();
    expect(await f.service.recordDeviceEvidence(request, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true, replayed: true });
    expect(await f.service.recordDeviceEvidence({ ...request, payload: { ...input, exitCode: 1 } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: false, error: 'command-conflict' });
    const revised = (await f.service.readResult('P', 'A'))!;
    expect(revised).toMatchObject({ reviewAttempt: 1 });
    expect(revised.reviewerSessionId).not.toBe(old.reviewerSessionId);
    expect(revised.review).toBeUndefined();
    const proof = revised.validations.find(entry => entry.validationId === 'device')!;
    expect(proof.device).toMatchObject({ provenance: 'user-attested', deviceId: input.deviceId });
    expect(await f.service.readDeviceCapture('P', proof.device!.captureHash)).toEqual({ mimeType: 'image/png', dataBase64: input.capture.dataBase64 });
    expect(await f.service.readDeviceCapture('other-project', proof.device!.captureHash)).toBeNull();
    expect(await f.service.readLog('P', proof.logRefs[0])).toBe(input.textLog);
    await f.review();
    expect(f.current().evidence.filter(entry => entry.validationId === 'device').map(entry => entry.status)).toEqual(['not-run', 'passed']);
    // Prior failed approval reused the command ID; use a fresh explicit decision after the new review.
    expect(await f.service.decideReview({ commandId: 'accept-new-evidence', projectId: 'P', expectedRevision: f.current().revision, type: 'review',
      payload: { runId: 'R', attemptId: 'A', decision: 'approve', detail: 'Reviewed new attested device evidence' } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    await f.service.processIntegration(f.current()); await f.service.whenIdle();
    const candidate = (await f.service.readIntegration('P', 'R'))!;
    expect(candidate.status).toBe('awaiting-evidence');
    expect(candidate.successfulCommit).toBeUndefined();
    const { attemptId: _attemptId, artifactIds: _artifactIds, ...common } = input;
    expect(_attemptId).toBe('A'); expect(_artifactIds).toEqual(input.artifactIds);
    const integrationRequest = { ...request, commandId: 'integration-device-proof', expectedRevision: f.current().revision,
      payload: { ...common, scope: 'integration' as const, candidateCommit: candidate.candidateCommit } };
    expect(await f.service.recordDeviceEvidence({ ...integrationRequest, payload: { ...integrationRequest.payload, candidateCommit: f.baseCommit } }, { kind: 'android', id: 'phone' })).toMatchObject({ ok: false });
    expect(await f.service.recordDeviceEvidence(integrationRequest, { kind: 'android', id: 'phone' })).toMatchObject({ ok: true });
    await f.service.whenIdle();
    expect(await f.service.readIntegration('P', 'R')).toMatchObject({ status: 'passed', successfulCommit: candidate.candidateCommit });
    expect(f.errors).toEqual([]);
  }, 60_000);

  it('allows explicit review recovery when provider setup failed before a turn existed', async () => {
    const f = await fixture(); await f.capture();
    const provider = f.daemon.getSnapshot().providers[0];
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'provider.upsert', value: { ...provider, enabled: false, health: 'unavailable' } }] });
    await f.service.processReview(f.current(), f.preparation.tasks[0], f.current().attempts[0]); await f.service.whenIdle();
    expect((await f.service.readResult('P', 'A'))?.error).toBeTruthy();
    expect((await f.service.readResult('P', 'A'))?.reviewerTurnId).toBeUndefined();
    await f.daemon.applySystemCommit({ mutations: [{ kind: 'provider.upsert', value: provider }] });
    expect(await f.service.retryReview({ commandId: 'retry-setup', projectId: 'P', expectedRevision: f.current().revision, type: 'retry-review', payload: { runId: 'R', attemptId: 'A' } }, { kind: 'desktop', id: 'test' })).toMatchObject({ ok: true });
    await f.service.whenIdle();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    expect((await f.service.readResult('P', 'A'))?.reviewAttempt).toBe(1);
  }, 30_000);

  it('preserves interrupted artifacts and only applies them to explicit resume or same-baseline fallback', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.worker, 'src/a.txt'), 'partial');
    const artifacts = await f.service.capturePartialResult(f.current(), f.preparation.tasks[0], f.current().attempts[0]);
    expect(await f.send('attempt.finish', { attemptId: 'A', outcome: 'interrupted', artifacts, summary: 'Interrupted partial' }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.service.readResult('P', 'A')).toMatchObject({ disposition: 'partial' });
    expect(f.current().reviews).toEqual([]);
    const resumeRoot = await f.service.repository.workspace('P', 'explicit-resume', f.baseCommit);
    const run = f.current();
    await f.service.prepareWorkspace({ ...run, tasks: run.tasks.map(task => ({ ...task, nextAttemptKind: 'resume' as const })) }, f.preparation.tasks[0], resumeRoot);
    expect(await fs.readFile(path.join(resumeRoot, 'src/a.txt'), 'utf8')).toBe('partial');
    const fallback = { ...run, runId: 'fallback', attempts: [], preparation: { ...run.preparation, supersedesRunId: 'R' }, tasks: run.tasks.map(task => ({ ...task, currentAttemptId: undefined })) };
    const fallbackRoot = await f.service.repository.workspace('P', 'explicit-fallback', f.baseCommit);
    await f.service.prepareWorkspace(fallback, f.preparation.tasks[0], fallbackRoot);
    expect(await fs.readFile(path.join(fallbackRoot, 'src/a.txt'), 'utf8')).toBe('partial');
    const revisedRoot = await f.service.repository.workspace('P', 'changed-baseline', f.baseCommit);
    await f.service.prepareWorkspace({ ...fallback, runId: 'revised', preparation: { ...fallback.preparation, baseline: { ...baseline, fingerprint: 'b'.repeat(64) } } }, f.preparation.tasks[0], revisedRoot);
    expect(await fs.readFile(path.join(revisedRoot, 'src/a.txt'), 'utf8')).toBe('base');
  }, 60_000);
});
