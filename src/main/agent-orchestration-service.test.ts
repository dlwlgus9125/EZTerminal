import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../shared/agent';
import type { AgentProfile } from '../shared/agent-orchestration';
import { AgentOrchestrationService } from './agent-orchestration-service';
import { AgentOrchestrationStore } from './agent-orchestration-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-orchestration-service-'));

const profile: AgentProfile = {
  profileId: 'builtin:codex:all',
  providerId: 'codex',
  launcherId: 'codex',
  name: 'Codex worker',
  description: 'Test worker',
  permissionMode: 'workspace-write',
  capabilities: ['worker', 'read', 'write', 'verify', 'parent-events'],
  available: true,
  revision: 1,
};

function activity(sessionId: string, id = sessionId): AgentActivity {
  return {
    id,
    sessionId,
    provider: 'codex',
    cwd: 'C:\\repo',
    state: 'done',
    status: 'done',
    stateSeq: 1,
    live: true,
    interactiveReady: true,
    stateSource: 'provider-hook',
    projectId: 'project-1',
    rootId: 'root-1',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 2,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let index = 0; index < 40; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw last;
}

async function fixture() {
  const store = new AgentOrchestrationStore(makeDir());
  await store.init();
  await store.savePolicy({
    projectId: 'project-1',
    enabled: true,
    permissionMode: 'ask',
    allowedWorkerProfileIds: [profile.profileId],
    mergePolicy: { targetBranches: ['main'] },
  });
  let id = 0;
  const launches: Array<{ readonly taskId: string; readonly prompt: string }> = [];
  const lead = activity('lead-session', 'lead-activity');
  const inspectWorkerSource = vi.fn(async () => ({ clean: true, head: 'a'.repeat(40) }));
  const stopSession = vi.fn();
  const service = new AgentOrchestrationService({
    store,
    providers: () => [{ providerId: 'codex', kind: 'builtin', displayName: 'Codex' }],
    profiles: () => [profile],
    projectExists: () => true,
    newId: () => `id-${++id}`,
    launchWorker: async (_run, task, selectedProfile, prompt) => {
      launches.push({ taskId: task.taskId, prompt });
      return {
        profileId: selectedProfile.profileId,
        providerId: selectedProfile.providerId,
        sessionId: `session-${task.taskId}`,
        activityId: `activity-${task.taskId}`,
        ...(task.mode === 'write' ? {
          worktreeId: `worktree-${task.taskId}`,
          worktreePath: `C:\\worktrees\\${task.taskId}`,
          branch: `worker/${task.taskId}`,
        } : {}),
      };
    },
    stopSession,
    promptActivity: vi.fn(async () => ({ ok: true })),
    readActivity: vi.fn(async () => 'bounded output'),
    activity: (activityId) => activityId === lead.id ? lead : null,
    inspectWorkerSource,
    evaluateMergePolicy: vi.fn(async () => ({ eligible: true })),
    grantPolicyMerge: vi.fn(() => ({ ok: true as const, value: { expiresAt: Date.now() + 1_000 } })),
    requestMerge: vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const, message: 'not used' })),
  });
  return { store, service, launches, lead, inspectWorkerSource, stopSession };
}

describe('AgentOrchestrationService', () => {
  it('stops an otherwise silent delegation cycle at its hard duration limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const { store, service, lead } = await fixture();
      const created = await service.createWorker(lead, {
        title: 'Long worker', brief: 'Wait for the hard cycle deadline.', mode: 'read-only',
        profileId: profile.profileId,
      });
      expect(created.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      await store.flush();
      expect(store.getRun(created.ok ? created.value.run.runId : '')).toMatchObject({
        state: 'stopped',
        tasks: [{ state: 'canceled' }],
      });
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects parallel overlapping writers but permits an explicitly dependent writer', async () => {
    const { service, lead } = await fixture();
    const first = await service.createWorker(lead, {
      title: 'First writer', brief: 'Implement the first change.', mode: 'write',
      writeScopes: ['src/'], profileId: profile.profileId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await expect(service.createWorker(lead, {
      title: 'Parallel writer', brief: 'Implement another change.', mode: 'write',
      writeScopes: ['src/renderer/'], profileId: profile.profileId,
    })).resolves.toMatchObject({ ok: false, error: 'conflict' });
    const dependent = await service.createWorker(lead, {
      title: 'Dependent writer', brief: 'Continue after the first change.', mode: 'write',
      dependsOn: [first.value.task.taskId], writeScopes: ['src/renderer/'], profileId: profile.profileId,
    });
    expect(dependent).toMatchObject({ ok: true, value: { task: { state: 'queued' } } });
    if (!dependent.ok) return;
    await expect(service.cancelWorker(lead, dependent.value.task.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'canceled' },
    });
    await expect(service.archiveWorker(lead, dependent.value.task.taskId)).resolves.toMatchObject({
      ok: true,
      value: { archivedAt: expect.any(Number) },
    });
  });

  it('requires a structured exact-head verifier before a writer becomes merge-ready', async () => {
    const { store, service, launches, lead, inspectWorkerSource } = await fixture();
    const writer = await service.createWorker(lead, {
      title: 'Writer', brief: 'Implement the bounded change.', mode: 'write',
      writeScopes: ['src/'], profileId: profile.profileId,
    });
    if (!writer.ok) throw new Error(writer.message);
    await eventually(() => expect(launches).toHaveLength(1));
    const verifier = await service.createWorker(lead, {
      title: 'Verifier', brief: 'Verify the exact writer revision.', mode: 'verify',
      dependsOn: [writer.value.task.taskId], verifiesTaskId: writer.value.task.taskId,
      profileId: profile.profileId,
    });
    if (!verifier.ok) throw new Error(verifier.message);

    await expect(service.reportWorker(
      activity(`session-${writer.value.task.taskId}`, `activity-${writer.value.task.taskId}`),
      writer.value.task.taskId,
      {
        outcome: 'succeeded', summary: 'Invalid cross-task claim.',
        verifiesTaskId: writer.value.task.taskId, verifiesHead: 'a'.repeat(40),
      },
    )).resolves.toMatchObject({ ok: false, error: 'invalid' });

    const writerReport = await service.reportWorker(
      activity(`session-${writer.value.task.taskId}`, `activity-${writer.value.task.taskId}`),
      writer.value.task.taskId,
      { outcome: 'succeeded', summary: 'Committed the change.', sourceHead: 'a'.repeat(40) },
    );
    expect(writerReport).toMatchObject({ ok: true, value: { state: 'awaiting-verification' } });
    await eventually(() => {
      expect(launches).toHaveLength(2);
      expect(store.getRun(writer.value.run.runId)?.tasks.find(
        (task) => task.taskId === verifier.value.task.taskId,
      )?.worker?.sessionId).toBe(`session-${verifier.value.task.taskId}`);
    });

    await expect(service.reportWorker(
      activity(`session-${verifier.value.task.taskId}`, `activity-${verifier.value.task.taskId}`),
      verifier.value.task.taskId,
      {
        outcome: 'succeeded', summary: 'Looks good.', verifiesTaskId: writer.value.task.taskId,
        verifiesHead: 'b'.repeat(40),
      },
    )).resolves.toMatchObject({ ok: false, error: 'stale' });

    inspectWorkerSource.mockResolvedValueOnce({ clean: true, head: 'c'.repeat(40) });
    await expect(service.reportWorker(
      activity(`session-${verifier.value.task.taskId}`, `activity-${verifier.value.task.taskId}`),
      verifier.value.task.taskId,
      {
        outcome: 'succeeded', summary: 'Writer moved during review.', verifiesTaskId: writer.value.task.taskId,
        verifiesHead: 'a'.repeat(40),
      },
    )).resolves.toMatchObject({ ok: false, error: 'stale' });

    const verified = await service.reportWorker(
      activity(`session-${verifier.value.task.taskId}`, `activity-${verifier.value.task.taskId}`),
      verifier.value.task.taskId,
      {
        outcome: 'succeeded', summary: 'Exact revision passes.', verifiesTaskId: writer.value.task.taskId,
        verifiesHead: 'a'.repeat(40),
      },
    );
    expect(verified).toMatchObject({ ok: true, value: { state: 'completed' } });
    expect(store.getRun(writer.value.run.runId)?.tasks.find((task) => task.taskId === writer.value.task.taskId)?.state)
      .toBe('awaiting-merge');
  });
});
