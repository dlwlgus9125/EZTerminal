import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonAgent,
  type DaemonCommand,
  type DaemonCommandType,
  type DaemonProvider,
  type DaemonSession,
} from '../shared/daemon-protocol';
import {
  DaemonAutomationRuntime,
  type DaemonAutomationRuntimeOptions,
} from './daemon-automation-runtime';
import type {
  DaemonCommandExecutionContext,
  DaemonCommandExecutionResult,
} from './daemon-command-router';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualTimers {
  private sequence = 0;
  private readonly timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();

  readonly set = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = ++this.sequence;
    this.timers.set(id, { callback, delayMs });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clear = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  next(): { readonly callback: () => void; readonly delayMs: number } {
    const entry = [...this.timers.entries()].sort((left, right) => (
      left[1].delayMs - right[1].delayMs || left[0] - right[0]
    ))[0];
    if (!entry) throw new Error('No automation timer is armed.');
    this.timers.delete(entry[0]);
    return entry[1];
  }

  delays(): readonly number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs).sort((a, b) => a - b);
  }
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function sessionValue(
  session: DaemonSession,
  state: DaemonSession['state'],
): Omit<DaemonSession, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    id: session.id,
    projectId: session.projectId,
    workspaceId: session.workspaceId,
    kind: session.kind,
    title: session.title,
    state,
    source: session.source,
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
  };
}

function agentValue(
  agent: DaemonAgent,
  state: DaemonAgent['state'],
  currentTurnId = agent.currentTurnId,
): Omit<DaemonAgent, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    sessionId: agent.sessionId,
    providerId: agent.providerId,
    ...(agent.providerSessionId ? { providerSessionId: agent.providerSessionId } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    permissionPreset: agent.permissionPreset,
    state,
    ...(currentTurnId ? { currentTurnId } : {}),
    queuedTurnCount: agent.queuedTurnCount,
    orchestrationEnabled: agent.orchestrationEnabled,
  };
}

function providerValue(
  provider: DaemonProvider,
  patch: Pick<DaemonProvider, 'enabled' | 'health'>,
): Omit<DaemonProvider, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    id: provider.id,
    displayName: provider.displayName,
    protocol: provider.protocol,
    executablePath: provider.executablePath,
    executableVersion: provider.executableVersion,
    argv: provider.argv,
    environmentVariableNames: provider.environmentVariableNames,
    capabilities: provider.capabilities,
    ...(provider.reviewDigest ? { reviewDigest: provider.reviewDigest } : {}),
    enabled: patch.enabled,
    health: patch.health,
    ...(provider.healthDetail ? { healthDetail: provider.healthDetail } : {}),
  };
}

interface Harness {
  readonly store: DaemonStore;
  readonly router: DaemonCommandRouter;
  readonly runtime: DaemonAutomationRuntime;
  readonly timers: ManualTimers;
  readonly agentCreate: ReturnType<typeof vi.fn>;
  readonly agentSubmit: ReturnType<typeof vi.fn>;
  readonly execute: <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
  ) => Promise<ReturnType<DaemonCommandRouter['execute']> extends Promise<infer R> ? R : never>;
  readonly setNow: (value: string) => void;
  readonly seedAgent: (state?: DaemonAgent['state']) => Promise<void>;
}

async function harness(options: {
  readonly daemonEnabled?: boolean;
  readonly initialNow?: string;
  readonly executeCommand?: DaemonAutomationRuntimeOptions['executeCommand'];
} = {}): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-automation-'));
  temporaryDirectories.push(directory);
  let now = new Date(options.initialNow ?? '2026-09-04T10:00:00.000Z');
  let generatedId = 0;
  const store = new DaemonStore(directory, {
    now: () => new Date(now),
    idFactory: () => `store-id-${++generatedId}`,
  });
  await store.init();
  const timers = new ManualTimers();
  const routerRef: { current?: DaemonCommandRouter } = {};
  const agentCreate = vi.fn(async (
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> => {
    if (command.type !== 'agent.create') throw new Error('unexpected command');
    const workspace = context.snapshot.workspaces.find((candidate) => candidate.id === command.payload.workspaceId)!;
    return { ok: true, commit: { mutations: [
      { kind: 'session.upsert', value: {
        id: command.payload.sessionId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        kind: 'agent',
        title: command.payload.title,
        state: 'running',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId: command.payload.sessionId,
        providerId: command.payload.providerId,
        providerSessionId: `provider-${command.payload.sessionId}`,
        ...(command.payload.model ? { model: command.payload.model } : {}),
        permissionPreset: command.payload.permissionPreset,
        state: 'working',
        queuedTurnCount: 0,
        orchestrationEnabled: false,
      } },
      { kind: 'turn.upsert', value: {
        id: `turn-${command.commandId}`,
        sessionId: command.payload.sessionId,
        commandId: command.commandId,
        state: 'working',
        startedAt: now.toISOString(),
      } },
    ] } };
  });
  const agentSubmit = vi.fn(async (
    command: DaemonCommand,
    context: DaemonCommandExecutionContext,
  ): Promise<DaemonCommandExecutionResult> => {
    if (command.type !== 'agent.submit') throw new Error('unexpected command');
    const session = context.snapshot.sessions.find((candidate) => candidate.id === command.payload.sessionId)!;
    const agent = context.snapshot.agents.find((candidate) => candidate.sessionId === command.payload.sessionId)!;
    return { ok: true, commit: { mutations: [
      { kind: 'turn.upsert', value: {
        id: `turn-${command.commandId}`,
        sessionId: session.id,
        commandId: command.commandId,
        state: 'working',
        startedAt: now.toISOString(),
      } },
      { kind: 'session.upsert', value: sessionValue(session, 'running') },
      { kind: 'agent.upsert', value: agentValue(agent, 'working', `turn-${command.commandId}`) },
    ] } };
  });
  const runtimeOptions: DaemonAutomationRuntimeOptions = {
    getSnapshot: () => routerRef.current!.getSnapshot(),
    getScheduleRuns: (states) => routerRef.current!.getScheduleRuns(states),
    applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
    executeCommand: options.executeCommand ?? ((command) => routerRef.current!.execute(command)),
    now: () => new Date(now),
    idFactory: () => `automation-run-${++generatedId}`,
    setTimer: timers.set,
    clearTimer: timers.clear,
    pendingPollMs: 1_000,
  };
  const runtime = new DaemonAutomationRuntime(runtimeOptions);
  const router = new DaemonCommandRouter(store, {
    now: () => new Date(now),
    handlers: {
      ...runtime.handlers(),
      'agent.create': agentCreate,
      'agent.submit': agentSubmit,
    },
  });
  routerRef.current = router;
  await router.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: {
      id: 'project-1', name: 'Demo', rootPath: 'C:\\Demo', source: 'native',
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
    { kind: 'runtime.update', value: {
      keepRunning: options.daemonEnabled ?? true,
      startAtLogin: options.daemonEnabled ?? true,
    } },
  ] });
  let commandSequence = 0;
  const execute = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
  ) => router.execute(createDaemonCommand({
    commandId: `test-command-${++commandSequence}`,
    idempotencyKey: `test:${commandSequence}`,
    expectedRevision: router.getSnapshot().revision,
    issuedAt: now.toISOString(),
    principal: { kind: 'desktop', id: 'test' },
    type,
    payload,
  }));
  const seedAgent = async (state: DaemonAgent['state'] = 'idle') => {
    await router.applySystemCommit({ mutations: [
      { kind: 'session.upsert', value: {
        id: 'agent-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        kind: 'agent',
        title: 'Agent',
        state: state === 'idle' ? 'idle' : 'running',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId: 'agent-1',
        providerId: 'codex',
        providerSessionId: 'provider-agent-1',
        permissionPreset: 'standard',
        state,
        queuedTurnCount: 0,
        orchestrationEnabled: false,
      } },
    ] });
  };
  return {
    store,
    router,
    runtime,
    timers,
    agentCreate,
    agentSubmit,
    execute,
    setNow: (value) => { now = new Date(value); },
    seedAgent,
  };
}

async function close(h: Harness): Promise<void> {
  await h.runtime.dispose();
  await h.store.close();
}

async function archiveOwnerProjectOnly(h: Harness): Promise<void> {
  const project = h.router.getSnapshot().projects.find((entry) => entry.id === 'project-1')!;
  await h.router.applySystemCommit({ mutations: [{
    kind: 'project.upsert',
    value: {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      source: project.source,
      archivedAt: '2026-09-04T10:01:00.000Z',
    },
  }] });
}

describe('DaemonAutomationRuntime', () => {
  it('rejects Schedule work for an active Workspace whose owner Project is archived', async () => {
    const h = await harness();
    try {
      await h.execute('schedule.create', {
        scheduleId: 'schedule-before-project-archive',
        name: 'Existing Schedule',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'This must not run after the Project is archived.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: false,
      });
      await archiveOwnerProjectOnly(h);

      const create = await h.execute('schedule.create', {
        scheduleId: 'schedule-after-project-archive',
        name: 'New Schedule',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'This must not target the archived Project.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: false,
      });
      const runNow = await h.execute('schedule.run-now', {
        scheduleId: 'schedule-before-project-archive',
      });

      expect({ create, runNow }).toMatchObject({
        create: {
          ok: false,
          status: 'rejected',
          error: { code: 'not-found' },
        },
        runNow: {
          ok: false,
          status: 'rejected',
          error: { code: 'not-found' },
        },
      });
      expect(h.router.getScheduleRuns()).toEqual([]);
    } finally {
      await close(h);
    }
  });

  it('rejects enabling a Schedule after its owner Project is archived', async () => {
    const h = await harness();
    try {
      await h.execute('schedule.create', {
        scheduleId: 'revoked-schedule',
        name: 'Revoked Schedule',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'This must stay disabled.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: false,
      });
      await archiveOwnerProjectOnly(h);

      await expect(h.execute('schedule.update', {
        scheduleId: 'revoked-schedule',
        enabled: true,
      })).resolves.toMatchObject({
        ok: false,
        status: 'rejected',
        error: { code: 'not-found' },
      });
      expect(h.router.getSnapshot().schedules[0]).toMatchObject({
        id: 'revoked-schedule',
        enabled: false,
        runCount: 0,
      });
      expect(h.router.getSnapshot().schedules[0]).not.toHaveProperty('nextRunAt');
    } finally {
      await close(h);
    }
  });

  it('disables a due Schedule and terminalizes its queued cursor when its owner is archived', async () => {
    const executeCommand = vi.fn(async (command: DaemonCommand) => ({
      ok: false as const,
      status: 'rejected' as const,
      commandId: command.commandId,
      revision: command.expectedRevision,
      error: {
        code: 'not-found' as const,
        message: 'Active Workspace was not found.',
        retryable: false,
      },
    }));
    const h = await harness({ executeCommand });
    try {
      await h.execute('schedule.create', {
        scheduleId: 'revoked-schedule',
        name: 'Revoked Schedule',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'This must not dispatch.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: true,
      });
      await h.execute('schedule.run-now', { scheduleId: 'revoked-schedule' });
      expect(h.router.getScheduleRuns(['queued'])).toHaveLength(1);
      await archiveOwnerProjectOnly(h);
      h.setNow('2026-09-04T10:10:00.000Z');

      await h.runtime.start();

      expect({
        schedule: h.router.getSnapshot().schedules[0],
        runs: h.router.getScheduleRuns(),
        dispatchCount: executeCommand.mock.calls.length,
        timerDelays: h.timers.delays(),
      }).toMatchObject({
        schedule: {
          id: 'revoked-schedule',
          enabled: false,
          runCount: 1,
        },
        runs: [expect.objectContaining({
          scheduleId: 'revoked-schedule',
          state: 'failed',
          finishedAt: '2026-09-04T10:10:00.000Z',
          errorCode: 'not-found',
        })],
        dispatchCount: 0,
        timerDelays: [],
      });
      expect(h.router.getSnapshot().schedules[0]).not.toHaveProperty('nextRunAt');
    } finally {
      await close(h);
    }
  });

  it('atomically retires disabled and unhealthy provider Schedules without stale dispatch', async () => {
    const executeCommand = vi.fn(async (command: DaemonCommand) => ({
      ok: false as const,
      status: 'rejected' as const,
      commandId: command.commandId,
      revision: command.expectedRevision,
      error: {
        code: 'provider-unavailable' as const,
        message: 'The Schedule provider is not ready.',
        retryable: true,
      },
    }));
    const h = await harness({ executeCommand });
    try {
      const codex = h.router.getSnapshot().providers[0]!;
      await h.router.applySystemCommit({ mutations: [{
        kind: 'provider.upsert',
        value: { ...providerValue(codex, { enabled: true, health: 'ready' }), id: 'claude' },
      }] });
      await h.runtime.start();
      for (const [scheduleId, providerId] of [
        ['disabled-provider-schedule', 'codex'],
        ['unhealthy-provider-schedule', 'claude'],
      ] as const) {
        await h.execute('schedule.create', {
          scheduleId,
          name: scheduleId,
          workspaceId: 'workspace-1',
          providerId,
          permissionPreset: 'standard',
          prompt: 'Do not dispatch stale provider work.',
          cron: '* * * * *',
          timezone: 'UTC',
          enabled: true,
        });
      }
      const runningSessionId = stableId('scheduled-agent', 'provider-running-run');
      await h.execute('agent.create', {
        sessionId: runningSessionId,
        workspaceId: 'workspace-1',
        title: 'Existing running audit',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Keep this running record intact.',
      });
      await h.router.applySystemCommit({ mutations: [
        { kind: 'schedule-run.upsert', value: {
          id: 'disabled-provider-queued-run',
          scheduleId: 'disabled-provider-schedule',
          state: 'queued',
          scheduledFor: '2026-09-04T10:00:00.000Z',
        } },
        { kind: 'schedule-run.upsert', value: {
          id: 'unhealthy-provider-queued-run',
          scheduleId: 'unhealthy-provider-schedule',
          state: 'queued',
          scheduledFor: '2026-09-04T10:00:00.000Z',
        } },
        { kind: 'schedule-run.upsert', value: {
          id: 'provider-running-run',
          scheduleId: 'disabled-provider-schedule',
          sessionId: runningSessionId,
          state: 'running',
          scheduledFor: '2026-09-04T09:58:00.000Z',
          startedAt: '2026-09-04T09:58:01.000Z',
        } },
        { kind: 'schedule-run.upsert', value: {
          id: 'provider-completed-audit',
          scheduleId: 'disabled-provider-schedule',
          state: 'completed',
          scheduledFor: '2026-09-04T09:55:00.000Z',
          startedAt: '2026-09-04T09:55:01.000Z',
          finishedAt: '2026-09-04T09:55:30.000Z',
          summary: 'Preserved audit record.',
        } },
      ] });
      const providers = h.router.getSnapshot().providers;
      await h.router.applySystemCommit({ mutations: [
        { kind: 'provider.upsert', value: providerValue(
          providers.find((provider) => provider.id === 'codex')!,
          { enabled: false, health: 'ready' },
        ) },
        { kind: 'provider.upsert', value: providerValue(
          providers.find((provider) => provider.id === 'claude')!,
          { enabled: true, health: 'unavailable' },
        ) },
      ] });
      h.setNow('2026-09-04T10:10:00.000Z');

      h.runtime.notifyAuthorityChanged();
      h.timers.next().callback();
      await flush();

      expect(h.router.getSnapshot().schedules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'disabled-provider-schedule', enabled: false, runCount: 0 }),
        expect.objectContaining({ id: 'unhealthy-provider-schedule', enabled: false, runCount: 0 }),
      ]));
      for (const schedule of h.router.getSnapshot().schedules) expect(schedule).not.toHaveProperty('nextRunAt');
      expect(h.router.getScheduleRuns()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'disabled-provider-queued-run',
          state: 'failed',
          finishedAt: '2026-09-04T10:10:00.000Z',
          errorCode: 'provider-unavailable',
        }),
        expect.objectContaining({
          id: 'unhealthy-provider-queued-run',
          state: 'failed',
          errorCode: 'provider-unavailable',
        }),
        expect.objectContaining({
          id: 'provider-running-run',
          state: 'running',
          startedAt: '2026-09-04T09:58:01.000Z',
        }),
        expect.objectContaining({
          id: 'provider-completed-audit',
          state: 'completed',
          summary: 'Preserved audit record.',
        }),
      ]));
      expect(h.router.getScheduleRuns()).toHaveLength(4);
      expect(executeCommand).not.toHaveBeenCalled();

      for (let tick = 0; tick < 2; tick += 1) {
        h.runtime.notifyAuthorityChanged();
        h.timers.next().callback();
        await flush();
      }
      const unavailableProviders = h.router.getSnapshot().providers;
      await h.router.applySystemCommit({ mutations: unavailableProviders.map((provider) => ({
        kind: 'provider.upsert' as const,
        value: providerValue(provider, { enabled: true, health: 'ready' }),
      })) });
      for (const scheduleId of ['disabled-provider-schedule', 'unhealthy-provider-schedule']) {
        await expect(h.execute('schedule.update', { scheduleId, enabled: true }))
          .resolves.toMatchObject({ ok: true });
      }
      h.runtime.notifyAuthorityChanged();
      h.timers.next().callback();
      await flush();

      expect(h.router.getScheduleRuns()).toHaveLength(4);
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await close(h);
    }
  });

  it('fails closed when enabled automation lacks keep-running plus start-at-login', async () => {
    const h = await harness({ daemonEnabled: false });
    await h.seedAgent();

    await expect(h.execute('schedule.create', {
      scheduleId: 'schedule-1',
      name: 'Review',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Review.',
      cron: '0 9 * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'automation-requires-daemon' } });
    await expect(h.execute('heartbeat.configure', {
      sessionId: 'agent-1',
      prompt: 'Check status.',
      cron: '*/15 * * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'automation-requires-daemon' } });
    expect(h.router.getSnapshot().schedules).toEqual([]);
    expect(h.router.getSnapshot().heartbeats).toEqual([]);
    await close(h);
  });

  it('canonicalizes IANA zones and follows spring-forward and fall-back DST', async () => {
    const h = await harness({ initialNow: '2026-03-08T06:00:00.000Z' });
    await h.execute('schedule.create', {
      scheduleId: 'spring',
      name: 'Spring',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Spring check.',
      cron: '0   2 * * *',
      timezone: 'US/Eastern',
      enabled: true,
    });
    h.setNow('2026-11-01T04:00:00.000Z');
    await h.execute('schedule.create', {
      scheduleId: 'fall',
      name: 'Fall',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Fall check.',
      cron: '30 1 * * *',
      timezone: 'America/New_York',
      enabled: true,
    });

    expect(h.router.getSnapshot().schedules).toEqual([
      expect.objectContaining({
        id: 'spring',
        cron: '0 2 * * *',
        timezone: 'America/New_York',
        nextRunAt: '2026-03-08T07:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'fall',
        nextRunAt: '2026-11-01T05:30:00.000Z',
      }),
    ]);
    await expect(h.execute('schedule.create', {
      scheduleId: 'invalid',
      name: 'Invalid',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'No.',
      cron: '0 0 0 * * *',
      timezone: 'Mars/Olympus',
      enabled: false,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    await expect(h.execute('schedule.create', {
      scheduleId: 'offset-zone',
      name: 'Offset',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'No fixed offsets.',
      cron: '0 0 * * *',
      timezone: '+09:00',
      enabled: false,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    await close(h);
  });

  it('claims one overdue occurrence without backfill under duplicate concurrent ticks', async () => {
    const h = await harness();
    await h.runtime.start();
    await h.execute('schedule.create', {
      scheduleId: 'schedule-1',
      name: 'Minute review',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'standard',
      prompt: 'Review once.',
      cron: '* * * * *',
      timezone: 'UTC',
      maxRuns: 2,
      enabled: true,
    });
    const wake = h.timers.next();
    wake.callback();
    await flush();
    h.setNow('2026-09-04T10:10:00.000Z');
    const due = h.timers.next();

    due.callback();
    due.callback();
    await flush();

    expect(h.router.getSnapshot().schedules[0]).toMatchObject({
      runCount: 1,
      enabled: true,
      nextRunAt: '2026-09-04T10:11:00.000Z',
    });
    expect(h.router.getScheduleRuns()).toEqual([
      expect.objectContaining({ scheduledFor: '2026-09-04T10:01:00.000Z', state: 'running' }),
    ]);
    expect(h.agentCreate).toHaveBeenCalledOnce();
    await close(h);
  });

  it('rearms persisted nextRunAt and recovers a queued claim after restart', async () => {
    const first = await harness({
      executeCommand: async () => { throw new Error('simulated crash before authority dispatch'); },
    });
    await first.runtime.start();
    await first.execute('schedule.create', {
      scheduleId: 'schedule-1',
      name: 'Restart review',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'standard',
      prompt: 'Recover me.',
      cron: '* * * * *',
      timezone: 'UTC',
      enabled: true,
    });
    first.timers.next().callback();
    await flush();
    expect(first.timers.delays()).toContain(60_000);
    first.setNow('2026-09-04T10:02:00.000Z');
    first.timers.next().callback();
    await flush();
    expect(first.router.getScheduleRuns(['queued'])).toHaveLength(1);
    await first.runtime.dispose();

    const restartTimers = new ManualTimers();
    const restart = new DaemonAutomationRuntime({
      getSnapshot: () => first.router.getSnapshot(),
      getScheduleRuns: (states) => first.router.getScheduleRuns(states),
      applySystemTransition: (transition) => first.router.applySystemTransition(transition),
      executeCommand: (command) => first.router.execute(command),
      now: () => new Date('2026-09-04T10:02:00.000Z'),
      idFactory: () => 'restart-run',
      setTimer: restartTimers.set,
      clearTimer: restartTimers.clear,
    });
    await restart.start();

    expect(first.agentCreate).toHaveBeenCalledOnce();
    expect(first.router.getScheduleRuns()).toEqual([
      expect.objectContaining({ state: 'running', sessionId: expect.stringMatching(/^scheduled-agent-/u) }),
    ]);
    await restart.dispose();
    await first.store.close();
  });

  it('does not commit a late Schedule dispatch after disposal and shares repeated disposal', async () => {
    let releaseDispatch!: () => void;
    let reportDispatchStarted!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const dispatchStarted = new Promise<void>((resolve) => { reportDispatchStarted = resolve; });
    const executeCommand = vi.fn(async (command: DaemonCommand) => {
      reportDispatchStarted();
      await dispatchGate;
      return {
        ok: true as const,
        status: 'applied' as const,
        commandId: command.commandId,
        revision: command.expectedRevision + 1,
        eventSequence: 1,
      };
    });
    const h = await harness({ executeCommand });
    try {
      await h.execute('schedule.create', {
        scheduleId: 'schedule-1',
        name: 'Late dispatch',
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'Do not mark this running after shutdown.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: false,
      });
      await h.execute('schedule.run-now', { scheduleId: 'schedule-1' });

      const start = h.runtime.start();
      await dispatchStarted;
      const dispose = h.runtime.dispose();
      expect(h.runtime.dispose()).toBe(dispose);
      releaseDispatch();
      await Promise.all([start, dispose]);

      expect(executeCommand).toHaveBeenCalledOnce();
      expect(h.router.getScheduleRuns()).toEqual([
        expect.objectContaining({ state: 'queued' }),
      ]);
      expect(h.router.getScheduleRuns()[0]).not.toHaveProperty('sessionId');
    } finally {
      releaseDispatch();
      await h.runtime.dispose();
      await h.store.close();
    }
  });

  it('does not redispatch a queued run whose deterministic Agent already exists', async () => {
    const h = await harness();
    await h.execute('schedule.create', {
      scheduleId: 'schedule-1',
      name: 'Crash boundary',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Once.',
      cron: '* * * * *',
      timezone: 'UTC',
      enabled: false,
    });
    const runId = 'claimed-before-crash';
    const sessionId = stableId('scheduled-agent', runId);
    await h.router.applySystemCommit({ mutations: [
      { kind: 'schedule-run.upsert', value: {
        id: runId,
        scheduleId: 'schedule-1',
        state: 'queued',
        scheduledFor: '2026-09-04T09:59:00.000Z',
      } },
      { kind: 'session.upsert', value: {
        id: sessionId,
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        kind: 'agent',
        title: 'Crash boundary',
        state: 'running',
        source: 'structured',
      } },
      { kind: 'agent.upsert', value: {
        sessionId,
        providerId: 'codex',
        providerSessionId: 'already-created',
        permissionPreset: 'plan',
        state: 'working',
        queuedTurnCount: 0,
        orchestrationEnabled: false,
      } },
    ] });

    await h.runtime.start();

    expect(h.agentCreate).not.toHaveBeenCalled();
    expect(h.router.getScheduleRuns()).toEqual([
      expect.objectContaining({ id: runId, sessionId, state: 'running' }),
    ]);
    await close(h);
  });

  it('recovers deterministic Schedule Sessions from their initial turn without manufacturing running work', async () => {
    const h = await harness();
    for (const scheduleId of ['completed-schedule', 'interrupted-schedule', 'uncertain-schedule']) {
      await h.execute('schedule.create', {
        scheduleId,
        name: scheduleId,
        workspaceId: 'workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        prompt: 'Recover the durable result.',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: false,
      });
    }
    const cases = [
      { runId: 'completed-run', scheduleId: 'completed-schedule', turnState: 'completed', agentState: 'idle', sessionState: 'idle' },
      { runId: 'interrupted-run', scheduleId: 'interrupted-schedule', turnState: 'interrupted', agentState: 'idle', sessionState: 'idle' },
      {
        runId: 'uncertain-run',
        scheduleId: 'uncertain-schedule',
        turnState: 'delivery-uncertain',
        agentState: 'delivery-uncertain',
        sessionState: 'delivery-uncertain',
      },
    ] as const;
    for (const entry of cases) {
      const sessionId = stableId('scheduled-agent', entry.runId);
      await h.execute('agent.create', {
        sessionId,
        workspaceId: 'workspace-1',
        title: entry.scheduleId,
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Recover the durable result.',
      });
      const snapshot = h.router.getSnapshot();
      const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!;
      const agent = snapshot.agents.find((candidate) => candidate.sessionId === sessionId)!;
      const turn = snapshot.turns.find((candidate) => candidate.sessionId === sessionId)!;
      await h.router.applySystemCommit({ mutations: [
        { kind: 'schedule-run.upsert' as const, value: {
          id: entry.runId,
          scheduleId: entry.scheduleId,
          state: 'queued' as const,
          scheduledFor: '2026-09-04T09:59:00.000Z',
        } },
        { kind: 'session.upsert' as const, value: {
          id: session.id,
          projectId: session.projectId,
          workspaceId: session.workspaceId,
          kind: session.kind,
          title: session.title,
          state: entry.sessionState,
          source: session.source,
        } },
        { kind: 'agent.upsert' as const, value: {
          sessionId: agent.sessionId,
          providerId: agent.providerId,
          ...(agent.providerSessionId ? { providerSessionId: agent.providerSessionId } : {}),
          permissionPreset: agent.permissionPreset,
          state: entry.agentState,
          queuedTurnCount: 0,
          orchestrationEnabled: agent.orchestrationEnabled,
        } },
        { kind: 'turn.upsert' as const, value: {
          id: turn.id,
          sessionId: turn.sessionId,
          commandId: turn.commandId,
          state: entry.turnState,
          startedAt: '2026-09-04T09:59:01.000Z',
          ...(entry.turnState === 'delivery-uncertain'
            ? { errorCode: 'explicit-quit-delivery-uncertain' }
            : {
                finishedAt: '2026-09-04T09:59:30.000Z',
                ...(entry.turnState === 'interrupted' ? { errorCode: 'explicit-quit' } : {}),
              }),
        } },
      ] });
    }
    h.agentCreate.mockClear();

    await h.runtime.start();

    expect(h.agentCreate).not.toHaveBeenCalled();
    expect(h.router.getScheduleRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'completed-run',
        state: 'completed',
        finishedAt: '2026-09-04T09:59:30.000Z',
      }),
      expect.objectContaining({
        id: 'interrupted-run',
        state: 'interrupted',
        errorCode: 'explicit-quit',
      }),
      expect.objectContaining({
        id: 'uncertain-run',
        state: 'failed',
        errorCode: 'explicit-quit-delivery-uncertain',
      }),
    ]));
    expect(h.timers.delays()).toEqual([]);
    await close(h);
  });

  it('settles a running Schedule when its initial Agent turn finishes in an idle reusable Session', async () => {
    const h = await harness();
    await h.execute('schedule.create', {
      scheduleId: 'schedule-1',
      name: 'Idle completion',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'standard',
      prompt: 'Finish once.',
      cron: '* * * * *',
      timezone: 'UTC',
      enabled: false,
    });
    await h.execute('schedule.run-now', { scheduleId: 'schedule-1' });
    await h.runtime.start();
    const run = h.router.getScheduleRuns()[0]!;
    const session = h.router.getSnapshot().sessions.find((candidate) => candidate.id === run.sessionId)!;
    const agent = h.router.getSnapshot().agents.find((candidate) => candidate.sessionId === run.sessionId)!;
    const turn = h.router.getSnapshot().turns.find((candidate) => candidate.sessionId === run.sessionId)!;
    await h.router.applySystemCommit({ mutations: [
      { kind: 'turn.upsert', value: {
        id: turn.id,
        sessionId: turn.sessionId,
        commandId: turn.commandId,
        state: 'completed',
        startedAt: turn.startedAt,
        finishedAt: '2026-09-04T10:00:30.000Z',
      } },
      { kind: 'agent.upsert', value: agentValue(agent, 'idle', undefined) },
      { kind: 'session.upsert', value: sessionValue(session, 'idle') },
    ] });

    h.runtime.notifyAuthorityChanged();
    h.timers.next().callback();
    await flush();

    expect(h.router.getScheduleRuns()).toEqual([
      expect.objectContaining({
        id: run.id,
        state: 'completed',
        finishedAt: '2026-09-04T10:00:30.000Z',
      }),
    ]);
    await close(h);
  });

  it('coalesces a busy heartbeat and submits exactly once after the Agent becomes idle', async () => {
    const h = await harness();
    await h.seedAgent('working');
    await h.runtime.start();
    await h.execute('heartbeat.configure', {
      sessionId: 'agent-1',
      prompt: 'Check status.',
      cron: '* * * * *',
      timezone: 'UTC',
      enabled: true,
    });
    h.timers.next().callback();
    await flush();
    h.setNow('2026-09-04T10:05:00.000Z');
    const due = h.timers.next();
    due.callback();
    due.callback();
    await flush();

    expect(h.router.getSnapshot().heartbeats[0]).toMatchObject({
      pending: true,
      nextRunAt: '2026-09-04T10:01:00.000Z',
    });
    expect(h.agentSubmit).not.toHaveBeenCalled();
    await h.execute('heartbeat.trigger', { sessionId: 'agent-1' });
    await h.execute('heartbeat.trigger', { sessionId: 'agent-1' });
    expect(h.agentSubmit).not.toHaveBeenCalled();

    const snapshot = h.router.getSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === 'agent-1')!;
    const agent = snapshot.agents.find((candidate) => candidate.sessionId === 'agent-1')!;
    await h.router.applySystemCommit({ mutations: [
      { kind: 'session.upsert', value: sessionValue(session, 'idle') },
      { kind: 'agent.upsert', value: agentValue(agent, 'idle', undefined) },
    ] });
    h.runtime.notifyAuthorityChanged();
    h.timers.next().callback();
    await flush();
    due.callback();
    await flush();

    expect(h.agentSubmit).toHaveBeenCalledOnce();
    expect(h.agentSubmit.mock.calls[0]?.[0]).toMatchObject({
      type: 'agent.submit',
      payload: { sessionId: 'agent-1', prompt: 'Check status.' },
      principal: { kind: 'cli', id: 'automation-runtime' },
    });
    expect(h.router.getSnapshot().heartbeats[0]).toMatchObject({
      pending: false,
      nextRunAt: '2026-09-04T10:06:00.000Z',
    });
    await close(h);
  });

  it('updates canonical timing, disables cleanly, and deletes a Schedule', async () => {
    const h = await harness();
    await h.execute('schedule.create', {
      scheduleId: 'editable',
      name: 'Editable',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'standard',
      prompt: 'Original.',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Seoul',
      enabled: true,
    });

    await expect(h.execute('schedule.update', {
      scheduleId: 'editable',
      name: 'Edited',
      prompt: 'Updated.',
      cron: '30 8 * * 1-5',
      timezone: 'US/Eastern',
      maxRuns: 3,
      expiresAt: '2026-12-01T00:00:00+09:00',
    })).resolves.toMatchObject({ ok: true });
    expect(h.router.getSnapshot().schedules[0]).toMatchObject({
      name: 'Edited',
      prompt: 'Updated.',
      cron: '30 8 * * 1-5',
      timezone: 'America/New_York',
      maxRuns: 3,
      expiresAt: '2026-11-30T15:00:00.000Z',
      enabled: true,
    });

    await h.execute('schedule.update', { scheduleId: 'editable', enabled: false });
    expect(h.router.getSnapshot().schedules[0]).toMatchObject({ enabled: false });
    expect(h.router.getSnapshot().schedules[0]?.nextRunAt).toBeUndefined();
    await h.execute('schedule.delete', { scheduleId: 'editable' });
    expect(h.router.getSnapshot().schedules).toEqual([]);
    await close(h);
  });

  it('applies run-now limits and refuses expired schedules', async () => {
    const h = await harness();
    await h.execute('schedule.create', {
      scheduleId: 'once',
      name: 'Once',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'full-access',
      prompt: 'Run once.',
      cron: '0 0 * * *',
      timezone: 'UTC',
      maxRuns: 1,
      enabled: false,
    });
    await expect(h.execute('schedule.run-now', { scheduleId: 'once' })).resolves.toMatchObject({ ok: true });
    expect(h.router.getSnapshot().schedules[0]).toMatchObject({ runCount: 1, enabled: false });
    expect(h.router.getScheduleRuns(['queued'])).toHaveLength(1);
    await expect(h.execute('schedule.run-now', { scheduleId: 'once' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-state' },
    });
    await h.execute('schedule.create', {
      scheduleId: 'expired',
      name: 'Expired',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      permissionPreset: 'plan',
      prompt: 'Never.',
      cron: '0 0 * * *',
      timezone: 'UTC',
      expiresAt: '2026-09-04T09:00:00.000Z',
      enabled: false,
    });
    await expect(h.execute('schedule.run-now', { scheduleId: 'expired' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-state' },
    });
    await close(h);
  });
});
