import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectMapApprovalStore } from './project-map-approval-store';

const request = {
  projectId: 'project-1',
  ownerRootId: 'root-1',
  ownerWorkspaceId: 'workspace-1',
} as const;

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-approval-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('ProjectMapApprovalStore', () => {
  it('persists only the approved fingerprint in local app data', async () => {
    let store = new ProjectMapApprovalStore(directory);
    await store.init();
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const approval = await store.approve(request, 'runtime-map', fingerprint);
    await store.flush();

    expect(approval).toMatchObject({ mapId: 'runtime-map', fingerprint });
    store = new ProjectMapApprovalStore(directory);
    await store.init();
    expect(store.get(request, 'runtime-map')).toEqual(approval);
  });

  it('rejects malformed approval identities before writing', async () => {
    const store = new ProjectMapApprovalStore(directory);
    await store.init();
    await expect(store.approve(request, '../runtime', 'not-a-hash')).rejects.toThrow(
      'Invalid Project Map approval identity',
    );
  });
});
