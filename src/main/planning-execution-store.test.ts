import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ExecutionPreparation } from '../shared/planning-execution';
import { DAEMON_DATABASE_SCHEMA_VERSION, DaemonStore } from './daemon-store';
import { PlanningExecutionStore } from './planning-execution-store';

const NOW = '2026-10-13T00:00:00.000Z';
const baseline = { baselineId: 'baseline-1', revision: 6, fingerprint: 'a'.repeat(64) };
const artifacts = [{ artifactId: 'implementation', revision: 1 }];
const validationPlan = {
  acceptance: [{ acceptanceId: 'AC1', description: 'Works as designed' }],
  validations: [{ validationId: 'V1', acceptanceIds: ['AC1'], method: 'command' as const, environment: 'Windows', command: 'pnpm test' }],
};
const evidenceMetadata = { validationId: 'V1', acceptanceIds: ['AC1'], environment: 'Windows', command: 'pnpm test', exitCode: 0 };
const reviewerMetadata = { reviewerSessionId: 'SR', reviewerTurnId: 'review-turn' };
const preparation: ExecutionPreparation = {
  baseline, artifacts: [{ artifactId: 'screen', revision: 6 }], teamMode: 'division', progressPolicy: 'checkpoint',
  tasks: [{
    ...validationPlan, taskId: 'T1', taskRevision: 6, stage: 'implementation', title: 'Implement', brief: 'Implement the approved design', dependsOn: [], retryLimit: 2,
    profile: { profileId: 'windows', revision: 3, role: 'implementation', providerId: 'codex', model: 'model-a', prompt: 'Use the approved baseline', permissionPreset: 'standard', capabilities: ['write'] },
  }, {
    ...validationPlan, taskId: 'T2', taskRevision: 6, stage: 'review', title: 'Verify', brief: 'Verify the implementation', dependsOn: ['T1'], retryLimit: 2,
    profile: { profileId: 'review', revision: 2, role: 'verification', providerId: 'codex', model: 'model-a', prompt: 'Verify independently', permissionPreset: 'plan', capabilities: ['read'] },
  }],
};

const stores: DaemonStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function fixture(directory = mkdtempSync(path.join(os.tmpdir(), 'ezterminal-planning-execution-'))) {
  const authority = new DaemonStore(directory, { now: () => new Date(NOW) });
  stores.push(authority);
  await authority.init();
  if (authority.getSnapshot().projects.length === 0) await authority.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: 'P1', name: 'Example', source: 'native' } },
    { kind: 'workspace.upsert', value: { id: 'W1', projectId: 'P1', name: 'Main', kind: 'local', rootPath: directory } },
    { kind: 'provider.upsert', value: { id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: ['create'], enabled: true, health: 'ready' } },
    { kind: 'session.upsert', value: { id: 'S1', projectId: 'P1', workspaceId: 'W1', kind: 'agent', title: 'Work', state: 'running', source: 'structured' } },
    { kind: 'agent.upsert', value: { sessionId: 'S1', providerId: 'codex', model: 'model-a', permissionPreset: 'standard', state: 'working', queuedTurnCount: 0, orchestrationEnabled: true } },
    { kind: 'session.upsert', value: { id: 'S2', projectId: 'P1', workspaceId: 'W1', kind: 'agent', title: 'Parallel work', state: 'running', source: 'structured' } },
    { kind: 'agent.upsert', value: { sessionId: 'S2', providerId: 'codex', model: 'model-a', permissionPreset: 'standard', state: 'working', queuedTurnCount: 0, orchestrationEnabled: true } },
    { kind: 'session.upsert', value: { id: 'SR', projectId: 'P1', workspaceId: 'W1', kind: 'agent', title: 'Independent review', state: 'running', source: 'structured' } },
    { kind: 'agent.upsert', value: { sessionId: 'SR', providerId: 'codex', model: 'model-a', permissionPreset: 'plan', state: 'working', queuedTurnCount: 0, orchestrationEnabled: true } },
  ] });
  const ledger = new PlanningExecutionStore(authority, () => new Date(NOW));
  let sequence = 0;
  const send = (type: string, payload: Record<string, unknown>, principal = 'desktop', options: { commandId?: string; expectedRevision?: number } = {}) => ledger.execute({
    commandId: options.commandId ?? `test-${++sequence}-${ledger.read('P1').revision}`,
    projectId: 'P1', expectedRevision: options.expectedRevision ?? ledger.read('P1').revision,
    principal: { kind: principal, id: 'test-client' }, type, payload: { runId: 'R1', ...payload },
  });
  const makeTurn = async (turnId: string, sessionId = 'S1', state: 'working' | 'completed' | 'queued' = 'working') => {
    const commandId = `daemon-${turnId}`;
    await authority.beginOutbox(createDaemonCommand({
      commandId, idempotencyKey: commandId, expectedRevision: authority.getRevision(), issuedAt: NOW,
      principal: { kind: 'desktop', id: 'test' }, type: 'agent.submit', payload: { sessionId, prompt: 'Work' },
    }));
    await authority.commitCommand(commandId, { mutations: [{ kind: 'turn.upsert', value: {
      id: turnId, sessionId, commandId, state,
    } }] });
  };
  const prepare = async (value = preparation) => {
    expect(await send('run.prepare', { preparation: value })).toMatchObject({ ok: true });
    expect(await send('run.start', {})).toMatchObject({ ok: true });
  };
  const start = async (attemptId = 'A1', taskId = 'T1', sessionId = 'S1') => {
    await makeTurn(`turn-${attemptId}`, sessionId);
    return send('attempt.start', { attemptId, taskId, dispatchId: `dispatch-${attemptId}`, sessionId, turnId: `turn-${attemptId}` }, 'runtime');
  };
  return { directory, authority, ledger, send, makeTurn, prepare, start };
}

describe('PlanningExecutionStore', () => {
  it('cancels prepared runs and waits for active cancellation acknowledgement without losing evidence', async () => {
    const f = await fixture(); await f.prepare();
    expect(await f.send('run.cancel', {}, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('run.cancel', {})).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(await f.send('run.start', {})).toMatchObject({ ok: false, error: 'invalid-transition' });
    const active = await fixture(); await active.prepare(); await active.start();
    const before = active.ledger.read('P1').runs[0].preparation;
    expect(await active.send('run.cancel', {})).toMatchObject({ ok: true });
    expect(active.ledger.read('P1').runs[0].state).toBe('paused');
    expect(await active.send('attempt.finish', { attemptId: 'A1', outcome: 'interrupted', summary: 'Provider acknowledged cancellation', artifacts }, 'runtime')).toMatchObject({ ok: true });
    expect(active.ledger.read('P1').runs[0]).toMatchObject({ state: 'cancelled', preparation: before, attempts: [{ artifacts }] });
    expect(await active.send('run.continue', {})).toMatchObject({ ok: false, error: 'invalid-transition' });
  });
  it('records one explicitly extended repair, deduplicates it, and preserves its limit on restart', async () => {
    const f = await fixture();
    await f.prepare({ ...preparation, tasks: preparation.tasks.map(task => ({ ...task, retryLimit: 0 })) });
    await f.start();
    await f.send('attempt.finish', { attemptId: 'A1', outcome: 'failed', summary: 'Failed', artifacts: [] }, 'runtime');
    expect(await f.send('attempt.extend', { taskId: 'T1', reason: 'Retry after fixing the environment' }, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    const payload = { taskId: 'T1', reason: 'Retry after fixing the environment' };
    const options = { commandId: 'extra-repair', expectedRevision: f.ledger.read('P1').revision };
    expect(await f.send('attempt.extend', payload, 'desktop', options)).toMatchObject({ ok: true });
    expect(await f.send('attempt.extend', payload, 'desktop', options)).toMatchObject({ ok: true, replayed: true });
    await f.start('A2');
    await f.send('attempt.finish', { attemptId: 'A2', outcome: 'failed', summary: 'Still failed', artifacts: [] }, 'runtime');
    expect(await f.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: false, error: 'retry-limit' });
    await f.authority.close(); const reopened = await fixture(f.directory);
    expect(reopened.ledger.read('P1').runs[0].tasks[0]).toMatchObject({ retriesUsed: 1, extraRetriesGranted: 1, state: 'failed' });
    expect(reopened.ledger.read('P1').runs[0].gates).toMatchObject([{ state: 'approved', resolvedBy: 'test-client' }, { state: 'pending' }]);
  });

  it('blocks replacement until the previous turn is reconciled and then retires only overlapping assignments', async () => {
    const f = await fixture(); await f.prepare(); await f.start();
    const replacement = { ...preparation, supersedesRunId: 'R1', tasks: [preparation.tasks[0]] };
    expect(await f.send('run.prepare', { runId: 'R2', preparation: replacement })).toMatchObject({ ok: true });
    expect(await f.send('run.start', { runId: 'R2' })).toMatchObject({ ok: false, error: 'invalid-transition' });
    await f.send('attempt.finish', { attemptId: 'A1', outcome: 'failed', summary: 'Provider unavailable', artifacts: [] }, 'runtime');
    expect(await f.send('run.start', { runId: 'R2' })).toMatchObject({ ok: true });
    const runs = f.ledger.read('P1').runs;
    expect(runs.find(run => run.runId === 'R1')?.tasks).toMatchObject([{ taskId: 'T1', state: 'stale' }, { taskId: 'T2', state: 'waiting' }]);
    expect(runs.find(run => run.runId === 'R2')?.tasks).toMatchObject([{ taskId: 'T1', state: 'ready' }]);
    expect(runs.find(run => run.runId === 'R1')?.preparation).toEqual(preparation);
  });

  it('protects archived transcript history referenced by a completed execution attempt', async () => {
    const f = await fixture(); await f.prepare(); await f.start();
    const snapshot = f.authority.getSnapshot();
    const session = snapshot.sessions.find(entry => entry.id === 'S1')!;
    const turn = snapshot.turns.find(entry => entry.id === 'turn-A1')!;
    await f.authority.applySystemCommit({ mutations: [
      { kind: 'session.upsert', value: { ...session, state: 'archived', archivedAt: NOW } },
      { kind: 'turn.upsert', value: { ...turn, state: 'completed' } },
    ] });
    await f.authority.appendTranscriptBatch([{ id: 'protected-output', sessionId: 'S1', turnId: turn.id, sequence: 1, kind: 'assistant-message', text: 'Required result evidence', isDelta: false, isSensitive: false, createdAt: NOW }]);
    const revision = f.authority.getRevision();
    await expect(f.authority.purgeArchivedSessionHistory('P1', ['S1'], revision)).rejects.toThrow(/references/u);
    expect(f.authority.getTranscript('S1')).toHaveLength(1); expect(f.authority.getRevision()).toBe(revision);
  });
  it('pauses after each manual dispatch and never auto-repairs a provider failure', async () => {
    const f = await fixture();
    await f.prepare({ ...preparation, progressPolicy: 'manual' });
    expect(await f.start()).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0].dispatchPaused).toBe(true);
    expect(await f.send('attempt.finish', { attemptId: 'A1', outcome: 'failed', summary: 'Provider disconnected', artifacts: [] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('attempt.retry', { taskId: 'T1' }, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    expect(f.ledger.read('P1').runs[0].tasks[0].retriesUsed).toBe(0);
    expect(await f.send('run.continue', {})).toMatchObject({ ok: true });
    expect(await f.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: true });
  });

  it('requires confirmed validation evidence before a runtime repair even in autonomous mode', async () => {
    const f = await fixture();
    await f.prepare({ ...preparation, progressPolicy: 'autonomous' });
    await f.start();
    await f.send('attempt.finish', { attemptId: 'A1', outcome: 'failed', summary: 'Provider failed', artifacts }, 'runtime');
    expect(await f.send('attempt.retry', { taskId: 'T1' }, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('evidence.record', { attemptId: 'A1', evidenceId: 'failed-check', ...evidenceMetadata, exitCode: 1,
      kind: 'test', status: 'failed', baseline, artifacts, summary: 'Command returned one', logRefs: ['log'], captureRefs: [] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('attempt.retry', { taskId: 'T1' }, 'runtime')).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0].tasks[0].retriesUsed).toBe(1);
  });

  it('separates prepare/start, freezes configuration and persists receipts in the existing database', async () => {
    const f = await fixture();
    const command = { commandId: 'prepare-exact', projectId: 'P1', expectedRevision: 0, principal: { kind: 'desktop', id: 'test' }, type: 'run.prepare', payload: { runId: 'R1', preparation } };
    const daemonRevision = f.authority.getRevision();
    expect(await f.ledger.execute(command)).toMatchObject({ ok: true, revision: 1 });
    expect(f.authority.getRevision()).toBe(daemonRevision);
    expect(f.ledger.read('P1').runs[0]).toMatchObject({ state: 'prepared', attempts: [], tasks: [{ state: 'waiting' }, { state: 'waiting' }] });
    const snapshot = f.ledger.read('P1').runs[0].preparation;
    await expect(f.authority.writePlanningExecution((database) => database.prepare(
      'UPDATE planning_execution_runs SET preparation_json = ? WHERE run_id = ?',
    ).run(JSON.stringify({ ...snapshot, teamMode: 'single' }), 'R1'))).rejects.toThrow(/immutable/u);
    expect(f.ledger.read('P1').runs[0].preparation).toEqual(snapshot);
    expect(await f.ledger.execute(command)).toMatchObject({ ok: true, revision: 1, replayed: true });
    expect(await f.ledger.execute({ ...command, payload: { ...command.payload, preparation: { ...preparation, teamMode: 'single' } } })).toMatchObject({ ok: false, error: 'command-conflict' });
    expect(await f.send('run.start', {}, 'runtime')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('run.start', {})).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0]).toMatchObject({ state: 'running', preparation: snapshot, tasks: [{ state: 'ready' }, { state: 'waiting' }] });
    await f.authority.close();
    const reopened = await fixture(f.directory);
    expect(reopened.ledger.getReceipt('P1', command.commandId)).toMatchObject({ ok: true, revision: 1 });
    expect(reopened.ledger.read('P1').runs[0].preparation).toEqual(snapshot);
    expect(readdirSync(f.directory).filter((entry) => /sqlite|json/u.test(entry))).toEqual(expect.arrayContaining(['orchestration.sqlite3']));
    expect(readdirSync(f.directory).some((entry) => /planning.*(?:json|sqlite)/u.test(entry))).toBe(false);
  });

  it('lets an agent run the flow but keeps approvals and integration for the person or an auto-approved run', async () => {
    const f = await fixture();
    expect(await f.send('run.prepare', { preparation }, 'agent')).toMatchObject({ ok: true });
    expect(await f.send('run.start', {}, 'agent')).toMatchObject({ ok: true });
    expect(await f.send('run.pause', {}, 'agent')).toMatchObject({ ok: true });
    expect(await f.send('workflow.integrate', {}, 'agent')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('task.cancel', { taskId: 'T1' }, 'agent')).toMatchObject({ ok: false, error: 'user-required' });
    const auto = (runId: string) => f.ledger.execute({ commandId: `auto-${runId}`, projectId: 'P1', expectedRevision: f.ledger.read('P1').revision,
      principal: { kind: 'runtime', id: 'auto-approval' }, type: 'workflow.integrate', payload: { runId } });
    // A run the person did not set to approve automatically waits for them.
    expect(await auto('R1')).toMatchObject({ ok: false, error: 'user-required' });
    expect(await f.send('run.prepare', { runId: 'R2', preparation: { ...preparation, approvalPolicy: 'auto' } })).toMatchObject({ ok: true });
    // Allowed to try; the run itself is not finished.
    expect(await auto('R2')).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await f.ledger.execute({ commandId: 'other-runtime', projectId: 'P1', expectedRevision: f.ledger.read('P1').revision,
      principal: { kind: 'runtime', id: 'planning-runtime' }, type: 'workflow.integrate', payload: { runId: 'R2' } })).toMatchObject({ ok: false, error: 'user-required' });
  });

  it('serializes racing commands and rolls back invalid dependency graphs and session references', async () => {
    const f = await fixture();
    const cyclic = { ...preparation, tasks: preparation.tasks.map((task) => task.taskId === 'T1' ? { ...task, dependsOn: ['T2'] } : task) };
    expect(await f.send('run.prepare', { preparation: cyclic })).toMatchObject({ ok: false, error: 'invalid-reference' });
    expect(f.ledger.read('P1')).toMatchObject({ revision: 0, runs: [] });
    await f.prepare();
    const revision = f.ledger.read('P1').revision;
    const results = await Promise.all([
      f.send('run.pause-impact', { gateId: 'G1', taskIds: ['T1'], reason: 'Changed' }, 'desktop', { expectedRevision: revision }),
      f.send('run.pause-impact', { gateId: 'G2', taskIds: ['T2'], reason: 'Changed' }, 'desktop', { expectedRevision: revision }),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ error: 'revision-conflict' });
    expect(f.ledger.read('P1').runs[0].gates).toHaveLength(1);
    expect(await f.send('run.prepare', { runId: 'R2', preparation })).toMatchObject({ ok: true });
    expect(await f.send('run.start', { runId: 'R2' })).toMatchObject({ ok: true });
    const before = f.ledger.read('P1');
    expect(await f.send('attempt.start', { runId: 'R2', attemptId: 'missing', dispatchId: 'dispatch-missing', taskId: 'T1', sessionId: 'S1', turnId: 'missing' }, 'runtime')).toMatchObject({ ok: false, error: 'invalid-reference' });
    expect(f.ledger.read('P1')).toEqual(before);
  });

  it('persists the default additional-two retry limit across restarts and never grants a fourth attempt', async () => {
    const f = await fixture();
    // Exercise default schema normalization instead of supplying the value.
    const raw = { ...preparation, tasks: preparation.tasks.map((task) => ({ ...task, retryLimit: undefined })) };
    expect(await f.send('run.prepare', { preparation: raw })).toMatchObject({ ok: true });
    expect(await f.send('run.start', {})).toMatchObject({ ok: true });
    for (let index = 1; index <= 3; index += 1) {
      expect(await f.start(`A${index}`)).toMatchObject({ ok: true });
      expect(await f.send('attempt.finish', { attemptId: `A${index}`, outcome: 'failed', summary: 'Validation failed', artifacts }, 'runtime')).toMatchObject({ ok: true });
      if (index < 3) expect(await f.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: true });
    }
    const before = f.ledger.read('P1').runs[0];
    expect(before.tasks[0].retriesUsed).toBe(2);
    expect(before.gates).toMatchObject([{ kind: 'repair-exhausted', state: 'pending' }]);
    await f.authority.close();
    const reopened = await fixture(f.directory);
    expect(await reopened.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: false, error: 'retry-limit' });
    expect(reopened.ledger.read('P1').runs[0].attempts.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
  });

  it('requires exact baseline/artifact/evidence review before releasing dependencies', async () => {
    const f = await fixture();
    await f.prepare();
    await f.makeTurn('review-turn', 'SR', 'completed');
    expect(await f.start()).toMatchObject({ ok: true });
    expect(await f.start('A2', 'T2')).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await f.send('attempt.finish', { attemptId: 'A1', outcome: 'succeeded', summary: 'Ready for independent review', artifacts }, 'runtime')).toMatchObject({ ok: true });
    const evidence = { ...evidenceMetadata, attemptId: 'A1', evidenceId: 'E1', kind: 'test', status: 'passed', baseline, artifacts, summary: 'Required tests passed' };
    expect(await f.send('evidence.record', { ...evidence, baseline: { ...baseline, revision: 5 } }, 'runtime')).toMatchObject({ ok: false, error: 'stale-review' });
    expect(await f.send('evidence.record', evidence, 'runtime')).toMatchObject({ ok: true });
    const review = { ...reviewerMetadata, attemptId: 'A1', reviewId: 'review-1', baseline, artifacts, evidenceIds: ['E1'], decision: 'approve', detail: 'Reviewed exact output' };
    expect(await f.send('review.decide', { ...review, artifacts: [{ artifactId: 'implementation', revision: 2 }] })).toMatchObject({ ok: false, error: 'stale-review' });
    expect(await f.send('review.decide', review)).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0].tasks).toMatchObject([{ state: 'completed' }, { state: 'ready' }]);
  });

  it('cannot approve failed/not-run evidence or replace immutable evidence', async () => {
    const f = await fixture();
    await f.prepare();
    await f.makeTurn('review-turn', 'SR', 'completed');
    await f.start();
    await f.send('attempt.finish', { attemptId: 'A1', outcome: 'succeeded', summary: 'Output exists', artifacts }, 'runtime');
    const evidence = { ...evidenceMetadata, exitCode: undefined, attemptId: 'A1', evidenceId: 'E1', kind: 'test', status: 'not-run', baseline, artifacts, summary: 'Device unavailable' };
    expect(await f.send('evidence.record', evidence, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('evidence.record', { ...evidence, status: 'passed' }, 'runtime')).toMatchObject({ ok: false, error: 'invalid-reference' });
    expect(await f.send('review.decide', { ...reviewerMetadata, attemptId: 'A1', reviewId: 'review-1', baseline, artifacts, evidenceIds: ['E1'], decision: 'approve', detail: 'Approve' })).toMatchObject({ ok: false, error: 'stale-review' });
    expect(f.ledger.read('P1').runs[0].tasks[0].state).toBe('awaiting-review');
  });

  it('pauses only affected/dependent tasks and reconciles uncertainty before replacing a frozen run', async () => {
    const f = await fixture();
    await f.prepare({ ...preparation, tasks: [...preparation.tasks, { ...preparation.tasks[0], taskId: 'T3', title: 'Independent' }] });
    await f.start();
    expect(await f.start('A3', 'T3', 'S2')).toMatchObject({ ok: true });
    expect(await f.send('run.pause-impact', { gateId: 'changed', taskIds: ['T1'], reason: 'Requirements changed' })).toMatchObject({ ok: true });
    let run = f.ledger.read('P1').runs[0];
    expect(run.state).toBe('running');
    expect(run.tasks.map((task) => task.state)).toEqual(['paused', 'paused', 'running']);
    expect(run.attempts.map((attempt) => attempt.state)).toEqual(['delivery-uncertain', 'running']);
    expect(await f.send('gate.resolve', { gateId: 'changed', decision: 'approve', detail: 'Replan' })).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await f.send('attempt.finish', { attemptId: 'A1', outcome: 'succeeded', summary: 'Late completion', artifacts }, 'runtime')).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await f.send('attempt.reconcile', { attemptId: 'A1', outcome: 'not-applied', proof: 'Provider confirmed interruption', artifacts: [] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('gate.resolve', { gateId: 'changed', decision: 'approve', detail: 'Prepare the new baseline' })).toMatchObject({ ok: true });
    run = f.ledger.read('P1').runs[0];
    expect(run.tasks.map((task) => task.state)).toEqual(['stale', 'stale', 'running']);
    expect(run.preparation.baseline).toEqual(baseline);
  });

  it('recovery records uncertainty without submitting or retrying and requires explicit reconciliation', async () => {
    const f = await fixture();
    await f.prepare();
    await f.start();
    await f.authority.close();
    const reopened = await fixture(f.directory);
    expect(await reopened.ledger.recoverInterrupted()).toBe(1);
    expect(await reopened.ledger.recoverInterrupted()).toBe(0);
    expect(reopened.ledger.read('P1').runs[0]).toMatchObject({ state: 'reconciling', tasks: [{ state: 'reconciling', retriesUsed: 0 }, { state: 'waiting' }] });
    expect(await reopened.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await reopened.send('attempt.reconcile', { attemptId: 'A1', outcome: 'succeeded', proof: 'Provider authoritative history confirmed completion', artifacts }, 'runtime')).toMatchObject({ ok: true });
    expect(reopened.ledger.read('P1').runs[0].tasks[0].state).toBe('awaiting-review');
  });

  it('migrates v4 with the daemon backup policy and preserves old transcript/session data', async () => {
    const f = await fixture();
    await f.authority.appendTranscriptBatch([{ id: 'old-message', sessionId: 'S1', kind: 'user-message', text: 'Keep me', isDelta: false, isSensitive: false }]);
    await f.authority.close();
    const db = new DatabaseSync(f.authority.databasePath);
    db.exec('DROP TABLE planning_execution_attempt_refs; DROP TABLE planning_execution_runs; DROP TABLE planning_execution_projects; DROP TABLE planning_execution_receipts; ALTER TABLE transcript_items DROP COLUMN payload_json; ALTER TABLE approvals DROP COLUMN request_json; ALTER TABLE agents DROP COLUMN reasoning_effort; ALTER TABLE transcript_items DROP COLUMN context_json; PRAGMA user_version = 4;');
    db.close();
    const reopened = await fixture(f.directory);
    expect(reopened.authority.getDiagnostics().schemaVersion).toBe(DAEMON_DATABASE_SCHEMA_VERSION);
    expect(reopened.authority.getTranscript('S1')).toMatchObject([{ text: 'Keep me' }]);
    expect(reopened.ledger.read('P1')).toMatchObject({ revision: 0, runs: [] });
    expect(readdirSync(f.directory)).toContain('orchestration-recovery');
    expect(await reopened.send('run.prepare', { preparation })).toMatchObject({ ok: true });
  });

  it('does not consume repair retries for a user interruption or confirmed unapplied dispatch', async () => {
    const f = await fixture();
    await f.prepare();
    await f.start();
    expect(await f.send('attempt.finish', { attemptId: 'A1', outcome: 'interrupted', summary: 'User stopped', artifacts: [] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('attempt.retry', { taskId: 'T1' })).toMatchObject({ ok: false, error: 'invalid-transition' });
    expect(await f.send('attempt.resume', { taskId: 'T1' })).toMatchObject({ ok: true });
    expect(await f.start('A2')).toMatchObject({ ok: true });
    await f.ledger.recoverInterrupted();
    expect(await f.send('attempt.reconcile', { attemptId: 'A2', outcome: 'not-applied', proof: 'No execution in provider history', artifacts: [] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('attempt.resume', { taskId: 'T1' })).toMatchObject({ ok: true });
    expect(await f.start('A3')).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0].tasks[0].retriesUsed).toBe(0);
    expect(f.ledger.read('P1').runs[0].attempts.map((attempt) => attempt.reason)).toEqual(['initial', 'resume', 'resume']);
  });

  it('rejects reused live sessions and queued or completed turns', async () => {
    const f = await fixture();
    await f.prepare({ ...preparation, tasks: [...preparation.tasks, { ...preparation.tasks[0], taskId: 'T3' }] });
    expect(await f.start()).toMatchObject({ ok: true });
    expect(await f.start('A3', 'T3')).toMatchObject({ ok: false, error: 'invalid-transition' });
    await f.makeTurn('queued-turn', 'S2', 'queued');
    expect(await f.send('attempt.start', { attemptId: 'queued', dispatchId: 'dispatch-queued', taskId: 'T3', sessionId: 'S2', turnId: 'queued-turn' }, 'runtime')).toMatchObject({ ok: false, error: 'invalid-reference' });
    await f.makeTurn('completed-turn', 'S2', 'completed');
    expect(await f.send('attempt.start', { attemptId: 'completed', dispatchId: 'dispatch-completed', taskId: 'T3', sessionId: 'S2', turnId: 'completed-turn' }, 'runtime')).toMatchObject({ ok: false, error: 'invalid-reference' });
    expect(f.ledger.read('P1').runs[0].attempts).toHaveLength(1);
  });

  it('requires all prepared validations and a completed independent reviewer turn', async () => {
    const f = await fixture();
    const extra = { validationId: 'V2', acceptanceIds: ['AC1'], method: 'device' as const, environment: 'Android' };
    await f.prepare({ ...preparation, tasks: preparation.tasks.map((task) => ({ ...task, validations: [...task.validations, extra] })) });
    await f.start();
    await f.send('attempt.finish', { attemptId: 'A1', outcome: 'succeeded', summary: 'Review ready', artifacts }, 'runtime');
    expect(await f.send('evidence.record', { ...evidenceMetadata, attemptId: 'A1', evidenceId: 'E1', kind: 'test', status: 'passed', baseline, artifacts, summary: 'Passed' }, 'runtime')).toMatchObject({ ok: true });
    await f.makeTurn('review-turn', 'SR', 'completed');
    const review = { ...reviewerMetadata, attemptId: 'A1', reviewId: 'review-1', baseline, artifacts, evidenceIds: ['E1'], decision: 'approve', detail: 'Reviewed' };
    expect(await f.send('review.decide', review)).toMatchObject({ ok: false, error: 'stale-review' });
    expect(await f.send('evidence.record', { validationId: 'V2', acceptanceIds: ['AC1'], environment: 'Android', attemptId: 'A1', evidenceId: 'E2', kind: 'preview', status: 'passed', baseline, artifacts, summary: 'Device verified', captureRefs: ['capture-1'] }, 'runtime')).toMatchObject({ ok: true });
    expect(await f.send('review.decide', { ...review, evidenceIds: ['E1', 'E2'], reviewerSessionId: 'S1', reviewerTurnId: 'turn-A1' })).toMatchObject({ ok: false, error: 'invalid-reference' });
    expect(await f.send('review.decide', { ...review, evidenceIds: ['E1', 'E2'] })).toMatchObject({ ok: true });
    expect(f.ledger.read('P1').runs[0].reviews[0]).toMatchObject({ reviewerSessionId: 'SR', reviewerTurnId: 'review-turn', decidedBy: 'test-client' });
  });
});
