import { describe, expect, it } from 'vitest';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { PlanningDraft, PlanningSnapshot } from '../shared/planning';
import type { PlanningRunPreparationInput } from '../shared/planning-run';
import { planningProfilePresets } from '../shared/planning-profile-presets';
import { preparePlanningExecution } from './planning-preparation';

function fixture() {
  const draft: PlanningDraft = { id: 'draft', items: [], links: [], scenes: [], components: [], assets: [],
    profiles: planningProfilePresets('en').map((profile) => ({ ...profile, revision: 1 })), tasks: [{
      id: 'task', revision: 1, title: 'Implement', objective: 'Implement the approved feature', featureIds: [], screenIds: [], inputRefs: [],
      dependencyIds: [], allowedPaths: ['src'], interfaceRefs: [], profileId: 'profile-implementation', status: 'ready',
      acceptance: [{ id: 'acceptance', description: 'Required behavior works' }],
      validationPlan: [{ id: 'test', acceptanceIds: ['acceptance'], method: 'command', command: 'pnpm test', description: 'Tests', environment: 'Windows' }],
    }] };
  const snapshot: PlanningSnapshot = { schemaVersion: 1, projectId: 'project', revision: 2, draft,
    history: [], profileProposals: [], baselines: [{ id: 'baseline', title: 'Ready', sourceRevision: 1, hash: 'a'.repeat(64),
      createdBy: { kind: 'user', id: 'user' }, createdAt: new Date().toISOString(), draft: structuredClone(draft) }] };
  const daemon: Pick<DaemonSnapshot, 'providers'> = { providers: [{
    id: 'codex', protocol: 'codex-app-server', enabled: true, health: 'ready', displayName: 'Codex',
    executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [],
    revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] };
  const assignment = { taskId: 'task', profileId: 'profile-implementation', providerId: 'codex', model: 'model', permissionPreset: 'standard' as const };
  const input: PlanningRunPreparationInput = { runId: 'run', baselineId: 'baseline', teamMode: 'single', progressPolicy: 'checkpoint',
    assignments: [assignment], reviewer: { profileId: 'profile-review', providerId: 'codex', model: 'model', permissionPreset: 'plan' } };
  const deps = { snapshot, daemon, baseCommit: 'b'.repeat(40), listModels: async () => [{ id: 'model', displayName: 'Model', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }] };
  return { input, deps, assignment };
}

describe('authority-owned execution preparation', () => {
  it('freezes baseline task text and exact model settings instead of the current draft', async () => {
    const { input, deps } = fixture();
    deps.snapshot.draft.tasks[0].objective = 'Unapproved draft change';
    const result = await preparePlanningExecution(input, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.preparation.tasks[0].brief).toContain('Implement the approved feature');
    expect(result.preparation.tasks[0].brief).not.toContain('Unapproved draft change');
    expect(result.preparation).toMatchObject({ baseCommit: 'b'.repeat(40), reviewer: { role: 'review', permissionPreset: 'plan' },
      tasks: [{ profile: { providerId: 'codex', model: 'model', revision: 1 }, retryLimit: 2 }] });
  });

  it('rejects missing baselines, unsupported models and unadvertised reasoning options', async () => {
    const { input, deps } = fixture();
    for (const changed of [
      { ...input, baselineId: 'missing' },
      { ...input, assignments: [{ ...input.assignments[0], model: 'invented' }] },
      { ...input, assignments: [{ ...input.assignments[0], reasoningEffort: 'invented' }] },
    ]) expect(await preparePlanningExecution(changed, deps)).toMatchObject({ ok: false, error: 'preparation-invalid' });
  });

  it('does not let a planning role or a child profile exceed its parent permission policy', async () => {
    const { input, deps } = fixture();
    expect(await preparePlanningExecution({ ...input, assignments: [{ ...input.assignments[0], profileId: 'profile-planning' }] }, deps))
      .toMatchObject({ ok: false, message: expect.stringContaining('read-only') });
    const profile = deps.snapshot.baselines[0].draft.profiles.find((entry) => entry.id === 'profile-implementation')!;
    profile.parentProfileId = 'profile-planning';
    expect(await preparePlanningExecution(input, deps)).toMatchObject({ ok: false, message: expect.stringContaining('read-only') });
  });

  it('keeps candidate workers on identical frozen input with different identities', async () => {
    const { input, deps, assignment } = fixture();
    const result = await preparePlanningExecution({ ...input, teamMode: 'candidates', assignments: [assignment, assignment] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const [first, second] = result.preparation.tasks;
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.brief).toBe(second.brief);
    expect(first.candidateGroupId).toBe(second.candidateGroupId);
  });

  it('blocks overlapping parallel scope and requires explicit independent review', async () => {
    const { input, deps, assignment } = fixture();
    deps.snapshot.baselines[0].draft.tasks.push({ ...deps.snapshot.baselines[0].draft.tasks[0], id: 'second' });
    expect(await preparePlanningExecution({ ...input, teamMode: 'division', assignments: [assignment, { ...assignment, taskId: 'second' }] }, deps))
      .toMatchObject({ ok: false, message: expect.stringContaining('overlapping') });
    expect(await preparePlanningExecution({ ...input, reviewer: undefined }, deps)).toMatchObject({ ok: false, message: expect.stringContaining('reviewer') });
  });
});
