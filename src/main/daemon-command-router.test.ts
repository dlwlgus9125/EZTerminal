import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonCommand, type DaemonCommandType } from '../shared/daemon-protocol';
import { DaemonCommandRouter } from './daemon-command-router';
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
});
