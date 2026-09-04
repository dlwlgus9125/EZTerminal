import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonSchedule } from '../shared/daemon-protocol';
import { DaemonStore } from './daemon-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function scheduleValue(
  schedule: DaemonSchedule,
  runCount: number,
): Omit<DaemonSchedule, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    id: schedule.id,
    name: schedule.name,
    workspaceId: schedule.workspaceId,
    providerId: schedule.providerId,
    ...(schedule.model ? { model: schedule.model } : {}),
    permissionPreset: schedule.permissionPreset,
    prompt: schedule.prompt,
    cron: schedule.cron,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
    runCount,
    ...(schedule.expiresAt ? { expiresAt: schedule.expiresAt } : {}),
    ...(schedule.nextRunAt ? { nextRunAt: schedule.nextRunAt } : {}),
  };
}

async function storeHarness(): Promise<DaemonStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-system-transition-'));
  temporaryDirectories.push(directory);
  const store = new DaemonStore(directory, {
    now: () => new Date('2026-09-04T10:00:00.000Z'),
    idFactory: (() => {
      let sequence = 0;
      return () => `event-${++sequence}`;
    })(),
  });
  await store.init();
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: {
      id: 'project-1', name: 'Demo', source: 'native', rootPath: 'C:\\Demo',
    } },
    { kind: 'workspace.upsert', value: {
      id: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local', rootPath: 'C:\\Demo',
    } },
    { kind: 'provider.upsert', value: {
      id: 'codex',
      displayName: 'Codex',
      protocol: 'codex-app-server',
      executablePath: 'C:\\Tools\\codex.exe',
      executableVersion: '1.0.0',
      argv: ['app-server'],
      environmentVariableNames: ['PATH'],
      capabilities: [],
      enabled: true,
      health: 'ready',
    } },
    { kind: 'schedule.upsert', value: {
      id: 'schedule-1',
      name: 'Review',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Review.',
      cron: '* * * * *',
      timezone: 'UTC',
      enabled: true,
      runCount: 0,
      nextRunAt: '2026-09-04T10:01:00.000Z',
    } },
  ] });
  return store;
}

describe('DaemonStore.applySystemTransition', () => {
  it('claims a due row once across concurrent planners', async () => {
    const store = await storeHarness();
    const claim = () => store.applySystemTransition((state) => {
      const schedule = state.snapshot.schedules.find((candidate) => candidate.id === 'schedule-1');
      if (!schedule || schedule.runCount !== 0) return undefined;
      return {
        commit: { mutations: [
          { kind: 'schedule.upsert', value: scheduleValue(schedule, 1) },
          { kind: 'schedule-run.upsert', value: {
            id: 'run-1',
            scheduleId: schedule.id,
            state: 'queued',
            scheduledFor: schedule.nextRunAt!,
          } },
        ] },
        value: schedule.id,
      };
    });

    const receipts = await Promise.all([claim(), claim()]);

    expect(receipts.filter((receipt) => receipt?.applied)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt === undefined)).toHaveLength(1);
    expect(store.getSnapshot().schedules[0]).toMatchObject({ runCount: 1 });
    expect(store.getScheduleRuns()).toEqual([
      expect.objectContaining({ id: 'run-1', state: 'queued', revision: 2 }),
    ]);
    await store.close();
  });

  it('rolls back the whole claim when its synchronous planner fails', async () => {
    const store = await storeHarness();
    const revision = store.getRevision();

    await expect(store.applySystemTransition(() => {
      throw new Error('claim failed');
    })).rejects.toThrow('claim failed');

    expect(store.getRevision()).toBe(revision);
    expect(store.getScheduleRuns()).toEqual([]);
    await store.close();
  });
});
