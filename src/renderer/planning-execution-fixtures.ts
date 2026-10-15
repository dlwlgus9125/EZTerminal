import type { ExecutionRun, PlanningExecutionSnapshot } from '../shared/planning-execution';
import type { PlanningSnapshot } from '../shared/planning';

/** Story/test data; never imported by the application. */
export function planningExecutionFixture(): { planning: PlanningSnapshot; execution: PlanningExecutionSnapshot } {
  const now = '2026-10-13T00:00:00.000Z';
  const profile = { profileId: 'profile-worker', revision: 1, role: 'implementation', providerId: 'codex', model: 'model-test', prompt: 'Preserve live terminal sessions and validate the result.', permissionPreset: 'standard' as const, capabilities: ['project.read', 'project.write'] };
  const run: ExecutionRun = { runId: 'run-example', projectId: 'project-example', revision: 1, state: 'prepared',
    preparation: { baseline: { baselineId: 'baseline-example', revision: 4, fingerprint: 'a'.repeat(64) }, artifacts: [{ artifactId: 'task-terminal', revision: 3 }], teamMode: 'single', progressPolicy: 'checkpoint', tasks: [{ taskId: 'task-terminal', taskRevision: 3, stage: 'implementation', title: 'Keep terminal sessions across navigation', brief: 'Changing sections must preserve the PTY and process.', dependsOn: [], profile, retryLimit: 2, acceptance: [{ acceptanceId: 'acceptance-1', description: 'The session identity stays the same.' }], validations: [{ validationId: 'validation-1', acceptanceIds: ['acceptance-1'], method: 'command', environment: 'Windows 11', command: 'pnpm test:unit' }] }], reviewer: { ...profile, profileId: 'profile-review', role: 'review', permissionPreset: 'plan', capabilities: ['project.read', 'review.read'] } },
    preparationFingerprint: 'b'.repeat(64), createdAt: now, updatedAt: now,
    tasks: [{ taskId: 'task-terminal', state: 'ready', retriesUsed: 0 }], attempts: [], evidence: [], reviews: [], gates: [],
  };
  return {
    planning: { schemaVersion: 1, projectId: run.projectId, revision: 4, draft: { id: 'draft-example', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] }, baselines: [], history: [], profileProposals: [] },
    execution: { version: 1, projectId: run.projectId, revision: 1, runs: [run] },
  };
}
