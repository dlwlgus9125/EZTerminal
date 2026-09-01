import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawControlSnapshot } from '../shared/openclaw';
import {
  OpenClawLifecycleCoordinator,
  type OpenClawSupervisorAdapter,
} from './openclaw-lifecycle-coordinator';

const temporaryDirectories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-control-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

function fakeSupervisor(): OpenClawSupervisorAdapter & {
  ensureInstalled: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
} {
  return {
    ensureInstalled: vi.fn(async () => ({ ok: true as const })),
    wake: vi.fn(async () => ({ ok: true as const })),
  };
}

describe('OpenClawLifecycleCoordinator', () => {
  it('persists a running intent and returns an immediate durable receipt', async () => {
    const userDataDirectory = await makeDirectory();
    const supervisor = fakeSupervisor();
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor,
      getPhysicalStatus: async () => ({ state: 'stopped', port: 18789 }),
      randomUUID: () => 'intent-1',
      now: () => new Date('2026-09-01T00:00:00.000Z'),
      pollMs: 60_000,
    });

    await expect(coordinator.requestLifecycle('start')).resolves.toEqual({
      accepted: true,
      intentId: 'intent-1',
      generation: 1,
      coalesced: false,
    });
    const persisted = JSON.parse(await fs.readFile(
      path.join(userDataDirectory, 'openclaw-control', 'intent.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      desiredState: 'running',
      action: 'start',
      generation: 1,
    });
    expect(supervisor.ensureInstalled).toHaveBeenCalledOnce();
    expect(supervisor.wake).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it('coalesces a duplicate active intent instead of returning busy', async () => {
    const userDataDirectory = await makeDirectory();
    const supervisor = fakeSupervisor();
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor,
      getPhysicalStatus: async () => ({ state: 'stopped', port: 18789 }),
      randomUUID: () => 'intent-1',
      pollMs: 60_000,
    });

    const first = await coordinator.requestLifecycle('start');
    const duplicate = await coordinator.requestLifecycle('start');
    expect(duplicate).toEqual({ ...first, coalesced: true });
    expect(supervisor.wake).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it('records a conflicting stop as a newer generation so latest intent wins', async () => {
    const userDataDirectory = await makeDirectory();
    const supervisor = fakeSupervisor();
    let nextId = 0;
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor,
      getPhysicalStatus: async () => ({ state: 'stopped', port: 18789 }),
      randomUUID: () => `intent-${nextId += 1}`,
      pollMs: 60_000,
    });

    await coordinator.requestLifecycle('start');
    await expect(coordinator.requestLifecycle('stop')).resolves.toMatchObject({
      accepted: true,
      intentId: 'intent-2',
      generation: 2,
      coalesced: false,
    });
    const persisted = JSON.parse(await fs.readFile(
      path.join(userDataDirectory, 'openclaw-control', 'intent.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({ desiredState: 'stopped', action: 'stop', generation: 2 });
    await coordinator.dispose();
  });

  it('a blocked generation is cleared only by a new explicit Start', async () => {
    const userDataDirectory = await makeDirectory();
    const controlDirectory = path.join(userDataDirectory, 'openclaw-control');
    await fs.mkdir(controlDirectory, { recursive: true });
    await fs.writeFile(path.join(controlDirectory, 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-1',
      generation: 1,
      desiredState: 'running',
      action: 'start',
      requestedAt: '2026-09-01T00:00:00.000Z',
    }));
    const blocked: OpenClawControlSnapshot = {
      schemaVersion: 1,
      intentId: 'intent-1',
      generation: 1,
      status: { state: 'stopped', port: 18789 },
      desiredState: 'running',
      supervisorState: 'ready',
      operation: {
        intentId: 'intent-1',
        generation: 1,
        action: 'start',
        phase: 'blocked',
        attempt: 3,
        maxAttempts: 3,
        requestedAt: '2026-09-01T00:00:00.000Z',
      },
      issue: {
        code: 'repair-exhausted',
        detail: 'Safe repair did not make the gateway ready.',
        remediation: 'Press Start to begin a new recovery request.',
        diagnosticId: 'diag-1',
      },
      updatedAt: '2026-09-01T00:03:00.000Z',
    };
    await fs.writeFile(path.join(controlDirectory, 'runtime.json'), JSON.stringify(blocked));
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor: fakeSupervisor(),
      getPhysicalStatus: async () => ({ state: 'stopped', port: 18789 }),
      randomUUID: () => 'intent-2',
      pollMs: 60_000,
    });

    await expect(coordinator.requestLifecycle('start')).resolves.toMatchObject({
      accepted: true,
      generation: 2,
      coalesced: false,
    });
    await coordinator.dispose();
  });

  it('rejects before persistence when the supervisor cannot be installed', async () => {
    const userDataDirectory = await makeDirectory();
    const supervisor = fakeSupervisor();
    supervisor.ensureInstalled.mockResolvedValue({
      ok: false,
      issue: {
        code: 'cli-missing',
        detail: 'OpenClaw CLI was not found.',
        remediation: 'Install OpenClaw and retry.',
        diagnosticId: 'diag-missing',
      },
    });
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor,
      getPhysicalStatus: async () => ({ state: 'not-installed', port: 18789 }),
      pollMs: 60_000,
    });

    await expect(coordinator.requestLifecycle('start')).resolves.toMatchObject({
      accepted: false,
      issue: { code: 'cli-missing' },
    });
    await expect(fs.stat(path.join(userDataDirectory, 'openclaw-control', 'intent.json'))).rejects.toThrow();
    await coordinator.dispose();
  });

  it('records every explicit restart after a completed restart as a new generation', async () => {
    const userDataDirectory = await makeDirectory();
    const controlDirectory = path.join(userDataDirectory, 'openclaw-control');
    await fs.mkdir(controlDirectory, { recursive: true });
    await fs.writeFile(path.join(controlDirectory, 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-1',
      generation: 1,
      desiredState: 'running',
      action: 'restart',
      requestedAt: '2026-09-01T00:00:00.000Z',
    }));
    await fs.writeFile(path.join(controlDirectory, 'runtime.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-1',
      generation: 1,
      status: { state: 'running', port: 18789 },
      desiredState: 'running',
      supervisorState: 'ready',
      operation: null,
      issue: null,
      updatedAt: '2026-09-01T00:01:00.000Z',
    }));
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor: fakeSupervisor(),
      getPhysicalStatus: async () => ({ state: 'running', port: 18789 }),
      randomUUID: () => 'intent-2',
      pollMs: 60_000,
    });

    await expect(coordinator.requestLifecycle('restart')).resolves.toMatchObject({
      accepted: true,
      generation: 2,
      coalesced: false,
    });
    await coordinator.dispose();
  });

  it('keeps a persisted intent accepted and surfaces a wake failure in control state', async () => {
    const userDataDirectory = await makeDirectory();
    const supervisor = fakeSupervisor();
    supervisor.wake.mockResolvedValue({
      ok: false,
      issue: {
        code: 'permission-denied',
        detail: 'Task could not be started.',
        remediation: 'Repair Task Scheduler permissions.',
        diagnosticId: 'diag-wake',
      },
    });
    const coordinator = new OpenClawLifecycleCoordinator({
      userDataDirectory,
      supervisorAssetPath: 'unused-in-test',
      supervisor,
      getPhysicalStatus: async () => ({ state: 'stopped', port: 18789 }),
      randomUUID: () => 'intent-1',
      pollMs: 60_000,
    });

    await expect(coordinator.requestLifecycle('start')).resolves.toMatchObject({
      accepted: true,
      generation: 1,
      issue: { code: 'permission-denied' },
    });
    await expect(coordinator.getSnapshot()).resolves.toMatchObject({
      desiredState: 'running',
      supervisorState: 'error',
      issue: { diagnosticId: 'diag-wake' },
    });
    await coordinator.dispose();
  });
});
