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

async function fixture(options: {
  readonly beforeWorkerLaunch?: () => Promise<void>;
  readonly startWorker?: () => Promise<void>;
  readonly projectExists?: () => boolean;
} = {}) {
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
    projectExists: options.projectExists ?? (() => true),
    newId: () => `id-${++id}`,
    launchWorker: async (_run, task, selectedProfile, prompt) => {
      await options.beforeWorkerLaunch?.();
      launches.push({ taskId: task.taskId, prompt });
      return {
        profileId: selectedProfile.profileId,
        providerId: selectedProfile.providerId,
        sessionId: `session-${task.taskId}`,
        activityId: `activity-${task.taskId}`,
        ...(options.startWorker ? { start: options.startWorker } : {}),
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
  it('rejects legacy Lead creation after its Project authority disappears', async () => {
    const { service, launches, lead } = await fixture({ projectExists: () => false });

    expect(service.canLead(lead)).toBe(false);
    await expect(service.createWorker(lead, {
      title: 'Tombstoned Project worker',
      brief: 'Must not start from a legacy collaboration policy.',
      mode: 'read-only',
      profileId: profile.profileId,
    })).resolves.toMatchObject({ ok: false, error: 'forbidden' });
    expect(launches).toHaveLength(0);
    await service.dispose();
  });

  it('stops every active Project worker before terminalizing its runs and preserves terminal history', async () => {
    const { store, service, stopSession } = await fixture();
    const createRun = async (leadSessionId: string, title: string) => {
      const source = activity(leadSessionId, `${leadSessionId}-activity`);
      const created = await service.createWorker(source, {
        title,
        brief: `Run ${title}.`,
        mode: 'read-only',
        profileId: profile.profileId,
      });
      if (!created.ok) throw new Error(created.message);
      await eventually(() => {
        expect(store.getRun(created.value.run.runId)?.tasks[0]?.worker?.sessionId).toBe(
          `session-${created.value.task.taskId}`,
        );
      });
      return {
        source,
        runId: created.value.run.runId,
        workerSessionId: `session-${created.value.task.taskId}`,
      };
    };

    const first = await createRun('lead-one', 'First worker');
    const second = await createRun('lead-two', 'Second worker');
    const terminal = await createRun('lead-terminal', 'Terminal worker');
    await service.stopRun(terminal.source, terminal.runId);
    const terminalBefore = structuredClone(store.getRun(terminal.runId));
    stopSession.mockClear();
    const statesObservedAtStop: string[][] = [];
    stopSession.mockImplementation(() => {
      statesObservedAtStop.push([first.runId, second.runId].map((runId) => store.getRun(runId)!.state));
    });

    await service.stopProjectRuns('project-1');

    expect(stopSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      first.workerSessionId,
      second.workerSessionId,
    ]);
    expect(statesObservedAtStop).toEqual([
      ['active', 'active'],
      ['active', 'active'],
    ]);
    for (const runId of [first.runId, second.runId]) {
      expect(store.getRun(runId)).toMatchObject({
        state: 'stopped',
        finishedAt: expect.any(Number),
        tasks: [{ state: 'canceled', worker: { finishedAt: expect.any(Number) } }],
      });
    }
    expect(store.getRun(terminal.runId)).toEqual(terminalBefore);
    await service.dispose();
  });

  it('keeps the Project stop barrier open until an in-flight launch session is stopped', async () => {
    let releaseLaunch!: () => void;
    let reportLaunchStarted!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const launchStarted = new Promise<void>((resolve) => { reportLaunchStarted = resolve; });
    const { store, service, launches, lead, stopSession } = await fixture({
      beforeWorkerLaunch: async () => {
        reportLaunchStarted();
        await launchGate;
      },
    });
    let stop: Promise<void> | undefined;
    try {
      const created = await service.createWorker(lead, {
        title: 'Racing worker',
        brief: 'Hold launch across Project cleanup.',
        mode: 'read-only',
        profileId: profile.profileId,
      });
      if (!created.ok) throw new Error(created.message);
      await launchStarted;

      let stopSettled = false;
      const projectStop = service.stopProjectRuns('project-1');
      expect(service.stopProjectRuns('project-1')).toBe(projectStop);
      expect(() => service.activateProject('project-1')).toThrow('cleanup is still in progress');
      stop = projectStop.then(() => { stopSettled = true; });
      const blocked = await service.createWorker(lead, {
        title: 'Late worker',
        brief: 'Must not launch after Project cleanup begins.',
        mode: 'read-only',
        profileId: profile.profileId,
      });
      expect(blocked).toMatchObject({ ok: false, error: 'forbidden' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopSettled).toBe(false);

      releaseLaunch();
      await stop;
      expect(launches).toHaveLength(1);
      expect(stopSession).toHaveBeenCalledWith(`session-${created.value.task.taskId}`);
      expect(store.getRun(created.value.run.runId)).toMatchObject({
        state: 'stopped',
        tasks: [{ state: 'canceled' }],
      });
      const afterStop = await service.createWorker(lead, {
        title: 'Retired Project worker',
        brief: 'Must remain blocked after Project cleanup returns.',
        mode: 'read-only',
        profileId: profile.profileId,
      });
      expect(afterStop).toMatchObject({ ok: false, error: 'forbidden' });
      service.activateProject('project-1');
      const afterActivate = await service.createWorker(lead, {
        title: 'Reactivated Project worker',
        brief: 'Launch only after explicit Project activation.',
        mode: 'read-only',
        profileId: profile.profileId,
      });
      expect(afterActivate).toMatchObject({ ok: true });
      await service.stopProjectRuns('project-1');
    } finally {
      releaseLaunch();
      await stop?.catch(() => undefined);
      await service.dispose();
    }
  });

  it('does not finish disposal before an admitted worker launch is contained and durably stopped', async () => {
    let releaseLaunch!: () => void;
    let reportLaunchStarted!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const launchStarted = new Promise<void>((resolve) => { reportLaunchStarted = resolve; });
    const { store, service, lead, stopSession } = await fixture({
      beforeWorkerLaunch: async () => {
        reportLaunchStarted();
        await launchGate;
      },
    });
    const created = await service.createWorker(lead, {
      title: 'Shutdown-racing worker',
      brief: 'Hold launch across orchestration disposal.',
      mode: 'read-only',
      profileId: profile.profileId,
    });
    if (!created.ok) throw new Error(created.message);
    await launchStarted;

    let disposeSettled = false;
    const disposal = service.dispose();
    expect(service.dispose()).toBe(disposal);
    const dispose = disposal.then(() => { disposeSettled = true; });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);
    await expect(service.createWorker(lead, {
      title: 'Too-late worker',
      brief: 'Must not enter after shutdown starts.',
      mode: 'read-only',
      profileId: profile.profileId,
    })).resolves.toMatchObject({ ok: false, error: 'forbidden' });

    releaseLaunch();
    await dispose;
    expect(stopSession).toHaveBeenCalledWith(`session-${created.value.task.taskId}`);
    expect(store.getRun(created.value.run.runId)).toMatchObject({
      state: 'stopped',
      tasks: [{ state: 'canceled' }],
    });
  });

  it('stops a durably bound worker before waiting for its in-flight delivery to drain', async () => {
    let releaseDelivery!: () => void;
    let reportDeliveryStarted!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStarted = new Promise<void>((resolve) => { reportDeliveryStarted = resolve; });
    const { service, lead, stopSession } = await fixture({
      startWorker: async () => {
        reportDeliveryStarted();
        await deliveryGate;
      },
    });
    stopSession.mockImplementation(() => releaseDelivery());
    const created = await service.createWorker(lead, {
      title: 'Delivery-racing worker',
      brief: 'Hold first delivery across orchestration disposal.',
      mode: 'read-only',
      profileId: profile.profileId,
    });
    if (!created.ok) throw new Error(created.message);
    await deliveryStarted;

    const disposal = service.dispose();
    await eventually(() => {
      expect(stopSession).toHaveBeenCalledWith(`session-${created.value.task.taskId}`);
    });
    await disposal;
  });

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
      await service.dispose();
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
