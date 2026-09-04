import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type CollaborationRun,
} from '../shared/agent-orchestration';
import { AgentOrchestrationStore } from './agent-orchestration-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-orchestration-'));

function activeRun(now = Date.now()): CollaborationRun {
  return {
    schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION,
    runId: 'run-1',
    revision: 1,
    projectId: 'project-1',
    leadSessionId: 'lead-session',
    leadActivityId: 'lead-activity',
    policyRevision: 1,
    state: 'active',
    tasks: [{
      taskId: 'task-1', revision: 1, title: 'Read code', brief: 'Inspect the implementation.',
      mode: 'read-only', dependsOn: [], writeScopes: [], profileId: 'builtin:codex:read',
      state: 'working', createdAt: now, updatedAt: now,
      worker: {
        workerId: 'worker-1', taskId: 'task-1', profileId: 'builtin:codex:read',
        providerId: 'codex', sessionId: 'worker-session', activityId: 'worker-activity', startedAt: now,
      },
    }],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
  };
}

describe('AgentOrchestrationStore', () => {
  it('persists bounded Project policy and rejects a stale writer', async () => {
    const directory = makeDir();
    const store = new AgentOrchestrationStore(directory);
    await store.init();
    const created = await store.savePolicy({
      projectId: 'project-1',
      enabled: true,
      permissionMode: 'ask',
      allowedWorkerProfileIds: ['builtin:codex:read'],
      mergePolicy: { targetBranches: ['main'] },
    });
    expect(created).toMatchObject({ ok: true, value: { revision: 1, limits: { maxConcurrent: 4, maxCreated: 12 } } });
    await expect(store.savePolicy({
      projectId: 'project-1',
      enabled: false,
      permissionMode: 'custom',
      allowedWorkerProfileIds: [],
      expectedRevision: 0,
    })).resolves.toMatchObject({ ok: false, error: 'stale' });

    const reloaded = new AgentOrchestrationStore(directory);
    await reloaded.init();
    expect(reloaded.getPolicy('project-1')).toMatchObject({ enabled: true, permissionMode: 'ask' });
  });

  it('never replays an in-flight worker after restart', async () => {
    const directory = makeDir();
    const store = new AgentOrchestrationStore(directory);
    await store.init();
    await expect(store.createRun(activeRun())).resolves.toMatchObject({ ok: true });
    await store.flush();

    const restarted = new AgentOrchestrationStore(directory);
    await restarted.init();
    expect(restarted.getRun('run-1')).toMatchObject({
      state: 'interrupted',
      tasks: [{ state: 'failed', worker: { finishedAt: expect.any(Number) } }],
    });
    expect(restarted.activeRunForLead('lead-session')).toBeUndefined();
  });

  it('requires explicit confirmation before deleting only the two legacy Team files', async () => {
    const directory = makeDir();
    const catalog = path.join(directory, 'agent-team-catalog.json');
    const runs = path.join(directory, 'agent-team-runs.json');
    const unrelated = path.join(directory, 'keep-me.json');
    writeFileSync(catalog, JSON.stringify({ personas: [{}, {}], teams: [{}] }), 'utf8');
    writeFileSync(runs, JSON.stringify({ runs: [{}, {}] }), 'utf8');
    writeFileSync(unrelated, '{}', 'utf8');

    const store = new AgentOrchestrationStore(directory);
    await store.init();
    expect(store.migrationStatus).toEqual({ required: true, catalogItemCount: 3, runCount: 2 });
    expect(existsSync(catalog)).toBe(true);
    await store.confirmLegacyMigration();
    expect(existsSync(catalog)).toBe(false);
    expect(existsSync(runs)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(store.migrationStatus).toMatchObject({ required: false, confirmedAt: expect.any(Number) });
  });
});
