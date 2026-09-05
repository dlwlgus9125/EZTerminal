import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonCommand, type DaemonCommandType } from '../shared/daemon-protocol';
import { DaemonCommandRouter } from './daemon-command-router';
import { daemonProjectRevocationCommit } from './daemon-project-sync';
import { DaemonStore } from './daemon-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function runtime(options: ConstructorParameters<typeof DaemonCommandRouter>[1] = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-router-'));
  temporaryDirectories.push(directory);
  const store = new DaemonStore(directory);
  await store.init();
  const router = new DaemonCommandRouter(store, options);
  return { store, router };
}

function command<T extends DaemonCommandType>(
  type: T,
  payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
  expectedRevision: number,
  suffix: string = type,
) {
  return createDaemonCommand({
    commandId: `command-${suffix}`,
    idempotencyKey: `desktop:${suffix}`,
    expectedRevision,
    issuedAt: '2026-09-04T10:00:00.000Z',
    principal: { kind: 'desktop', id: 'main-window' },
    type,
    payload,
  });
}

describe('DaemonCommandRouter', () => {
  it('applies core hierarchy commands and publishes committed events', async () => {
    const { store, router } = await runtime();
    const events: string[] = [];
    router.onEvent((event) => events.push(event.kind));

    expect(await router.execute(command('project.create', {
      projectId: 'project-1', name: 'Demo', rootPath: 'C:\\Working\\Demo',
    }, 0))).toMatchObject({ ok: true, revision: 1 });
    expect(await router.execute(command('workspace.create', {
      workspaceId: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local', rootPath: 'C:\\Working\\Demo',
    }, 1))).toMatchObject({ ok: true, revision: 2 });
    expect(await router.execute(command('session.create', {
      sessionId: 'terminal-1', workspaceId: 'workspace-1', kind: 'terminal', title: 'Terminal',
    }, 2))).toMatchObject({ ok: true, revision: 3 });

    expect(store.getSnapshot()).toMatchObject({
      revision: 3,
      projects: [{ id: 'project-1' }],
      workspaces: [{ id: 'workspace-1', projectId: 'project-1' }],
      sessions: [{ id: 'terminal-1', workspaceId: 'workspace-1', state: 'draft' }],
    });
    expect(events.filter((kind) => kind === 'entity.upserted')).toHaveLength(3);
    await store.close();
  });

  it('archives every child Workspace with its Project before accepting new Sessions', async () => {
    const { store, router } = await runtime();
    await router.execute(command('project.create', {
      projectId: 'project-1', name: 'Demo', rootPath: 'C:\\Working\\Demo',
    }, 0));
    await router.execute(command('workspace.create', {
      workspaceId: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local',
      rootPath: 'C:\\Working\\Demo',
    }, 1));

    await expect(router.execute(command('project.archive', {
      projectId: 'project-1',
    }, 2))).resolves.toMatchObject({ ok: true, revision: 3 });
    expect(router.getSnapshot()).toMatchObject({
      projects: [{ id: 'project-1', archivedAt: expect.any(String) }],
      workspaces: [{ id: 'workspace-1', archivedAt: expect.any(String) }],
    });
    await expect(router.execute(command('session.create', {
      sessionId: 'post-archive-session',
      workspaceId: 'workspace-1',
      kind: 'terminal',
      title: 'Must not start',
    }, 3, 'post-archive-session'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    await store.close();
  });

  it('rejects a Session beneath an archived Project even if an old active Workspace remains', async () => {
    const { store, router } = await runtime();
    await router.execute(command('project.create', {
      projectId: 'project-1', name: 'Demo', rootPath: 'C:\\Working\\Demo',
    }, 0));
    await router.execute(command('workspace.create', {
      workspaceId: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local',
      rootPath: 'C:\\Working\\Demo',
    }, 1));
    await router.applySystemCommit({ mutations: [{ kind: 'project.upsert', value: {
      id: 'project-1',
      name: 'Demo',
      rootPath: 'C:\\Working\\Demo',
      source: 'native',
      archivedAt: '2026-09-04T11:00:00.000Z',
    } }] });

    await expect(router.execute(command('session.create', {
      sessionId: 'orphan-session',
      workspaceId: 'workspace-1',
      kind: 'terminal',
      title: 'Must not start',
    }, 3, 'orphan-session'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    await store.close();
  });

  it('replays one idempotency key without incrementing revision', async () => {
    const { store, router } = await runtime();
    const input = command('project.create', { projectId: 'project-1', name: 'Demo' }, 0, 'same');
    expect(await router.execute(input)).toMatchObject({ ok: true, status: 'applied', revision: 1 });
    expect(await router.execute(input)).toMatchObject({ ok: true, status: 'replayed', revision: 1 });
    expect(store.getRevision()).toBe(1);
    await store.close();
  });

  it('rejects stale revisions and Android-only authority violations', async () => {
    const { store, router } = await runtime();
    await router.execute(command('project.create', { projectId: 'project-1', name: 'Demo' }, 0));
    expect(await router.execute(command('project.create', { projectId: 'project-2', name: 'Stale' }, 0, 'stale-project'))).toMatchObject({
      ok: false,
      error: { code: 'revision-conflict', currentRevision: 1 },
    });
    const android = createDaemonCommand({
      commandId: 'android-runtime', idempotencyKey: 'android:runtime', expectedRevision: 1,
      issuedAt: '2026-09-04T10:00:00.000Z', principal: { kind: 'android', id: 'phone' },
      type: 'runtime.set-settings', payload: { keepRunning: true },
    });
    expect(await router.execute(android)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    await store.close();
  });

  it('marks a command delivery-uncertain when a provider fails after dispatch', async () => {
    const handler = vi.fn(async (_command, context) => {
      await context.markProviderDispatchStarted();
      throw new Error('provider pipe closed');
    });
    const { store, router } = await runtime({ handlers: { 'agent.submit': handler } });
    const input = command('agent.submit', { sessionId: 'agent-1', prompt: 'Continue.' }, 0);

    expect(await router.execute(input)).toMatchObject({
      ok: false,
      status: 'delivery-uncertain',
      error: { code: 'delivery-uncertain', retryable: false },
    });
    expect(store.findCommand(input.commandId)?.state).toBe('delivery-uncertain');
    await store.close();
  });

  it('registers existing interpreter terminals into stable Local workspaces once', async () => {
    const { store, router } = await runtime();
    const legacy = [{ sessionId: 'legacy-terminal', cwd: 'C:\\Working\\Legacy', createdAt: 10 }];
    expect(await router.registerLegacyTerminals(legacy)).toMatchObject({ revision: 1 });
    expect(await router.registerLegacyTerminals(legacy)).toMatchObject({ revision: 1 });

    const snapshot = router.getSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.sessions).toEqual([expect.objectContaining({
      id: 'legacy-terminal', kind: 'terminal', source: 'legacy-pty', state: 'running',
    })]);
    await store.close();
  });

  it('exposes bounded transcript pages through the transport-facing seam', async () => {
    const { store, router } = await runtime();
    await router.execute(command('project.create', { projectId: 'project-1', name: 'Demo' }, 0));
    await router.execute(command('workspace.create', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      name: 'Local',
      kind: 'local',
      rootPath: 'C:\\Working\\Demo',
    }, 1));
    await router.execute(command('session.create', {
      sessionId: 'terminal-1',
      workspaceId: 'workspace-1',
      kind: 'terminal',
      title: 'Terminal',
    }, 2));
    await store.appendTranscriptBatch([{
      id: 'item-1',
      sessionId: 'terminal-1',
      kind: 'notice',
      text: 'Attached.',
      isDelta: false,
      isSensitive: false,
    }]);

    expect(router.readTranscript('terminal-1', 0, 20)).toEqual([
      expect.objectContaining({ id: 'item-1', sequence: 1, text: 'Attached.' }),
    ]);
    await store.close();
  });

  it('derives serialized system transitions from a fresh snapshot inside the command gate', async () => {
    const { store, router } = await runtime();
    const observedRevisions: number[] = [];

    await Promise.all([
      router.applySystemCommit((snapshot) => {
        observedRevisions.push(snapshot.revision);
        return { mutations: [{ kind: 'runtime.update', value: { keepRunning: true } }] };
      }),
      router.applySystemCommit((snapshot) => {
        observedRevisions.push(snapshot.revision);
        return { mutations: [{ kind: 'runtime.update', value: { browserEnabled: true } }] };
      }),
    ]);

    expect(observedRevisions).toEqual([0, 1]);
    expect(router.getSnapshot()).toMatchObject({
      revision: 2,
      runtime: { keepRunning: true, browserEnabled: true },
    });
    await store.close();
  });

  it('archives a Workspace command already ahead of Project revocation in the daemon FIFO', async () => {
    const { store, router } = await runtime();
    await router.execute(command('project.create', {
      projectId: 'project-1', name: 'Demo', rootPath: 'C:\\Working\\Demo',
    }, 0));

    const workspaceCreate = router.execute(command('workspace.create', {
      workspaceId: 'workspace-late',
      projectId: 'project-1',
      name: 'Already accepted',
      kind: 'local',
      rootPath: 'C:\\Working\\Demo\\late',
    }, 1, 'workspace-before-revoke'));
    const revocation = router.applySystemCommit(daemonProjectRevocationCommit(
      'project-1',
      '2026-09-04T11:00:00.000Z',
    ));

    await expect(workspaceCreate).resolves.toMatchObject({ ok: true, revision: 2 });
    await revocation;
    expect(router.getSnapshot()).toMatchObject({
      projects: [{ id: 'project-1', archivedAt: '2026-09-04T11:00:00.000Z' }],
      workspaces: [{ id: 'workspace-late', archivedAt: '2026-09-04T11:00:00.000Z' }],
    });
    await store.close();
  });

  it('closes new command ingress while preserving the already accepted FIFO prefix for shutdown', async () => {
    let releaseHandler!: () => void;
    let reportHandlerStarted!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handlerStarted = new Promise<void>((resolve) => { reportHandlerStarted = resolve; });
    const { store, router } = await runtime({
      handlers: {
        'agent.submit': async () => {
          reportHandlerStarted();
          await handlerGate;
          return {
            ok: false,
            error: { code: 'invalid-state', message: 'Synthetic handler completed.', retryable: false },
          };
        },
      },
    });
    const active = router.execute(command(
      'agent.submit',
      { sessionId: 'agent-1', prompt: 'Hold the FIFO.' },
      0,
      'active',
    ));
    await handlerStarted;
    const accepted = router.execute(command(
      'project.create',
      { projectId: 'accepted-project', name: 'Accepted' },
      0,
      'accepted',
    ));

    router.beginShutdown();
    router.beginShutdown();
    const rejected = await router.execute(command(
      'project.create',
      { projectId: 'late-project', name: 'Late' },
      0,
      'late',
    ));
    expect(rejected).toMatchObject({
      ok: false,
      status: 'rejected',
      error: { code: 'invalid-state', message: expect.stringContaining('shutting down') },
    });
    expect(store.findCommand('command-late')).toBeUndefined();

    releaseHandler();
    await expect(active).resolves.toMatchObject({ ok: false, status: 'rejected' });
    await expect(accepted).resolves.toMatchObject({ ok: true, status: 'applied', revision: 1 });
    await router.applySystemCommit({ mutations: [{
      kind: 'runtime.update',
      value: { browserEnabled: true },
    }] });
    expect(router.getSnapshot()).toMatchObject({
      revision: 2,
      projects: [{ id: 'accepted-project' }],
      runtime: { browserEnabled: true },
    });
    await store.close();
  });
});
