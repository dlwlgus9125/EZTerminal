import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectMapJobStore } from './project-map-job-store';

const request = {
  projectId: 'project-1',
  ownerRootId: 'root-1',
  ownerWorkspaceId: 'workspace-1',
  mapId: 'runtime-map',
  type: 'architecture',
  intent: 'update',
  activityId: 'activity-1',
} as const;

let directory: string;
let store: ProjectMapJobStore;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-job-'));
  store = new ProjectMapJobStore(directory);
  await store.init();
});

afterEach(async () => {
  await store.flush();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('ProjectMapJobStore', () => {
  it('tracks Agent-reported phases and cooperative cancellation without killing a session', async () => {
    const job = await store.start(request);
    expect(job.phase).toBe('queued');
    await expect(store.report(job.id, 'another-activity', 'analyzing')).resolves.toBeUndefined();
    await expect(store.report(job.id, request.activityId, 'analyzing')).resolves.toMatchObject({ phase: 'analyzing' });
    await expect(store.cancel(job.id)).resolves.toMatchObject({ phase: 'cancel-requested' });
    await expect(store.report(job.id, request.activityId, 'authoring')).resolves.toBeUndefined();
    await expect(store.report(job.id, request.activityId, 'canceled')).resolves.toMatchObject({ phase: 'canceled' });
    expect(store.activeFor(request, request.mapId)).toBeUndefined();
  });

  it('cancels a queued brief before Agent delivery', async () => {
    const job = await store.start({ ...request, mapId: 'other-map' });
    await expect(store.cancel(job.id)).resolves.toMatchObject({ phase: 'canceled' });
  });

  it('persists the dedicated Agent session identity for restored progress UI', async () => {
    const job = await store.start({
      ...request,
      dispatch: 'dedicated-session',
      agentLabel: 'Codex',
    });
    await store.flush();

    const restored = new ProjectMapJobStore(directory);
    await restored.init();
    expect(restored.get(job.id)).toMatchObject({
      activityId: 'activity-1',
      dispatch: 'dedicated-session',
      agentLabel: 'Codex',
      phase: 'queued',
    });
  });
});
