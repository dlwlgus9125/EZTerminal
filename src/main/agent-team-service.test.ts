import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentProjectCoordination } from '../shared/agent-coordination';
import { composeAgentTeamPlanningBrief, type AgentTeamPlanProposal } from '../shared/agent-team';
import type { AgentProjectRecord } from './agent-project-store';
import { AgentTeamService } from './agent-team-service';
import { AgentTeamStore } from './agent-team-store';

const project = {
  projectId: 'project-1',
  name: 'Project',
  primaryRoot: 'C:\\Project',
  additionalRoots: [],
  pinned: true,
  origin: 'manual',
  lastActiveAt: null,
  createdAt: 1,
  updatedAt: 1,
} as AgentProjectRecord;

const coordination: AgentProjectCoordination = {
  projectId: project.projectId,
  goal: 'Ship safely',
  defaultTargetBranch: 'main',
  validationCommands: [{ id: 'unit', name: 'Unit', command: 'pnpm test:unit', timeoutMs: 60_000 }],
  configRevision: 3,
  participants: [],
  updatedAt: 1,
};

async function fixture(options: {
  readonly inspectBase?: () => Promise<{ readonly head: string; readonly dirty: boolean } | null>;
} = {}) {
  const store = new AgentTeamStore(mkdtempSync(path.join(os.tmpdir(), 'ez-team-service-')));
  await store.init();
  const plannerResult = await store.savePersona({
    name: 'Planner', icon: 'search', role: 'Lead', instructions: 'Plan then implement.',
    launch: { provider: 'codex', sandbox: 'workspace-write' },
  });
  const workerResult = await store.savePersona({
    name: 'Worker', icon: 'code', role: 'Implementer', instructions: 'Implement a bounded slice.',
    launch: { provider: 'claude', permissionMode: 'acceptEdits' },
  });
  if (!plannerResult.ok || !workerResult.ok) throw new Error('fixture persona failed');
  const teamResult = await store.saveTeam({
    name: 'Core', instructions: 'Keep work reviewable.',
    personaIds: [plannerResult.value.personaId, workerResult.value.personaId],
    plannerPersonaId: plannerResult.value.personaId,
  });
  if (!teamResult.ok) throw new Error(teamResult.message);
  const service = new AgentTeamService({
    store,
    listProjects: () => [project],
    getCoordinationProject: () => coordination,
    capabilities: () => [
      { provider: 'codex', available: true, supportsModel: true, effortValues: [], permissionValues: ['read-only', 'workspace-write'], modelAvailability: 'launch-time' },
      { provider: 'claude', available: true, supportsModel: true, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], permissionValues: ['plan', 'manual', 'acceptEdits'], modelAvailability: 'launch-time' },
    ],
    ...(options.inspectBase ? { inspectBase: options.inspectBase } : {}),
  });
  const created = await service.createRun({
    projectId: project.projectId,
    teamId: teamResult.value.teamId,
    goal: 'Implement team runs',
    acceptanceCriteria: ['The approved Team run behavior is implemented and tested.'],
    warningAcknowledged: true,
  });
  if (!created.ok) throw new Error(created.message);
  return { service, run: created.value, planner: plannerResult.value, worker: workerResult.value };
}

function proposal(plannerId: string, workerId: string): AgentTeamPlanProposal {
  return {
    summary: 'Two independent slices.',
    assignments: [
      {
        taskId: crypto.randomUUID(), personaId: plannerId, title: 'Contracts', outcome: 'Contracts land',
        scopeHints: ['src/shared'], validationIds: ['unit'], acceptanceCriteria: ['Types pass'], brief: 'Implement contracts.',
      },
      {
        taskId: crypto.randomUUID(), personaId: workerId, title: 'UI', outcome: 'UI lands',
        scopeHints: ['src/renderer'], validationIds: ['unit'], acceptanceCriteria: ['UI tests pass'], brief: 'Implement UI.',
      },
    ],
    excludedMembers: [],
  };
}

async function activatePlanner(
  service: AgentTeamService,
  runId: string,
  personaId: string,
  revision: number,
) {
  const prepared = await service.bindMember(runId, personaId, revision, 'prepared');
  if (!prepared.ok) throw new Error(prepared.message);
  const launching = await service.bindMember(
    runId,
    personaId,
    prepared.value.revision,
    'launching',
    { sessionId: 'planner-session' },
  );
  if (!launching.ok) throw new Error(launching.message);
  const active = await service.bindMember(
    runId,
    personaId,
    launching.value.revision,
    'active',
    { activityId: 'planner-activity', sessionId: 'planner-session' },
  );
  if (!active.ok) throw new Error(active.message);
  return active;
}

describe('AgentTeamService', () => {
  it('freezes Project context separately from the run outcome and completion criteria', async () => {
    const { run } = await fixture();
    expect(run).toMatchObject({
      projectGoal: 'Ship safely',
      goal: 'Implement team runs',
      goalAcceptanceCriteria: ['The approved Team run behavior is implemented and tested.'],
    });
    const brief = composeAgentTeamPlanningBrief(run);
    expect(brief).toContain('## Project long-term context\nShip safely');
    expect(brief).toContain('## Run desired outcome\nImplement team runs');
    expect(brief).toContain('## Run completion criteria');
  });

  it('requires an observable completion criterion for every new run', async () => {
    const { service, run } = await fixture();
    const canceled = await service.decideRun({
      runId: run.runId,
      expectedRevision: run.revision,
      decision: 'cancel',
    });
    if (!canceled.ok) throw new Error(canceled.message);
    await expect(service.createRun({
      projectId: run.projectId,
      teamId: run.team.teamId,
      goal: 'Run without a finish line',
      acceptanceCriteria: [],
      warningAcknowledged: true,
    })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('revalidates starter permissions before committing any catalog item', async () => {
    const store = new AgentTeamStore(mkdtempSync(path.join(os.tmpdir(), 'ez-team-starter-service-')));
    await store.init();
    const service = new AgentTeamService({
      store,
      listProjects: () => [],
      getCoordinationProject: () => null,
      capabilities: () => [{
        provider: 'codex',
        available: true,
        supportsModel: true,
        effortValues: [],
        permissionValues: ['read-only'],
        modelAvailability: 'launch-time',
      }],
    });
    await expect(service.createStarterTeam({
      plannerProvider: 'codex',
      implementerProvider: 'codex',
    })).resolves.toMatchObject({ ok: false, error: 'unavailable' });
    expect(store.listPersonas()).toEqual([]);
    expect(store.listTeams()).toEqual([]);
    expect(store.catalogRevision).toBe(0);
  });

  it('accepts a plan only from the bound Planner and freezes a reviewed proposal', async () => {
    const { service, run, planner, worker } = await fixture();
    const planning = await activatePlanner(service, run.runId, planner.personaId, run.revision);
    const plan = proposal(planner.personaId, worker.personaId);
    await expect(service.submitPlan('other-activity', {
      runId: run.runId, expectedRevision: planning.value.revision, proposal: plan,
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    const submitted = await service.submitPlan('planner-activity', {
      runId: run.runId, expectedRevision: planning.value.revision, proposal: plan,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    expect(submitted.value.phase).toBe('awaiting-review');
    const waiting = service.waitForPlanDecision(run.runId, submitted.value.revision);
    await expect(service.approvePlan({
      runId: run.runId,
      expectedRevision: submitted.value.revision,
      proposal: { ...submitted.value.proposal!, summary: 'Changed after review.' },
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    const approved = await service.approvePlan({
      runId: run.runId,
      expectedRevision: submitted.value.revision,
      proposal: submitted.value.proposal!,
    });
    expect(approved).toMatchObject({ ok: true, value: { phase: 'launching' } });
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: { assignment: { personaId: planner.personaId }, brief: expect.stringContaining('Implement contracts.') },
    });
    expect(service.memberBrief(run.runId, worker.personaId)).toContain('Implement UI.');
  });

  it('rejects plans that omit a Team member without an exclusion', async () => {
    const { service, run, planner, worker } = await fixture();
    const planning = await activatePlanner(service, run.runId, planner.personaId, run.revision);
    const invalid = proposal(planner.personaId, worker.personaId);
    invalid.assignments.splice(1, 1);
    await expect(service.submitPlan('planner-activity', {
      runId: run.runId, expectedRevision: planning.value.revision, proposal: invalid,
    })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('rejects a second active run for the same Project', async () => {
    const { service, run } = await fixture();
    await expect(service.createRun({
      projectId: run.projectId,
      teamId: run.team.teamId,
      goal: 'Another run',
      acceptanceCriteria: ['The other run is complete.'],
      warningAcknowledged: true,
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
  });

  it('freezes one resolved target commit and emits the post-activation Planner revision', async () => {
    const head = 'a'.repeat(40);
    const { service, run, planner } = await fixture({
      inspectBase: async () => ({ head, dirty: false }),
    });
    expect(run).toMatchObject({ baseHead: head, baseDirty: false });
    const active = await activatePlanner(service, run.runId, planner.personaId, run.revision);
    expect(composeAgentTeamPlanningBrief(active.value)).toContain(`--revision ${String(active.value.revision)} --stdin`);
  });

  it('rejects a late failure that would overwrite an active member', async () => {
    const { service, run, planner } = await fixture();
    const active = await activatePlanner(service, run.runId, planner.personaId, run.revision);
    await expect(service.bindMemberCurrent(
      run.runId,
      planner.personaId,
      'failed',
      { sessionId: 'planner-session' },
      'late failure',
    )).resolves.toMatchObject({ ok: false, error: 'conflict' });
    expect(service.getSnapshot().runs.find((candidate) => candidate.runId === run.runId)?.revision)
      .toBe(active.value.revision);
  });

  it('requires an explicit acknowledgement when the main working tree is dirty', async () => {
    const { service, run } = await fixture({
      inspectBase: async () => ({ head: 'b'.repeat(40), dirty: true }),
    });
    const canceled = await service.decideRun({
      runId: run.runId,
      expectedRevision: run.revision,
      decision: 'cancel',
    });
    if (!canceled.ok) throw new Error(canceled.message);
    await expect(service.createRun({
      projectId: run.projectId,
      teamId: run.team.teamId,
      goal: 'Try without acknowledgement',
      acceptanceCriteria: ['The dirty-tree warning is acknowledged.'],
      warningAcknowledged: false,
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
  });

  it('does not turn an unknown run decision into a cancellation', async () => {
    const { service, run } = await fixture();
    await expect(service.decideRun({
      runId: run.runId,
      expectedRevision: run.revision,
      decision: 'complete',
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    await expect(service.decideRun({
      runId: run.runId,
      expectedRevision: run.revision,
      decision: 'unknown' as 'cancel',
    })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(service.getSnapshot().runs.find((candidate) => candidate.runId === run.runId)?.phase)
      .toBe('preparing-planner');
  });
});
