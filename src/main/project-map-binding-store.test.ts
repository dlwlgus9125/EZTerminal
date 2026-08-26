import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectMapBindingStore } from './project-map-binding-store';

const request = {
  projectId: 'project-1',
  ownerRootId: 'root-1',
  ownerWorkspaceId: 'workspace-1',
} as const;

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-bindings-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('ProjectMapBindingStore', () => {
  it('persists a deterministic alias-sorted binding set', async () => {
    const store = new ProjectMapBindingStore(directory);
    await store.init();
    await store.set(request, [
      { rootAlias: 'docs', rootId: 'root-2', workspaceId: 'workspace-2' },
      { rootAlias: 'app', rootId: 'root-1', workspaceId: 'workspace-1' },
    ]);

    await expect(store.get(request)).resolves.toEqual([
      { rootAlias: 'app', rootId: 'root-1', workspaceId: 'workspace-1' },
      { rootAlias: 'docs', rootId: 'root-2', workspaceId: 'workspace-2' },
    ]);
  });

  it('rejects control-bearing identities and quarantines non-exact persisted records', async () => {
    const store = new ProjectMapBindingStore(directory);
    await store.init();
    await expect(store.set(request, [{
      rootAlias: 'app',
      rootId: 'root-1\u0000other',
      workspaceId: 'workspace-1',
    }])).rejects.toThrow('Invalid Project Map root bindings.');

    const filePath = path.join(directory, 'project-map-bindings.json');
    await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, entries: [], injected: true }), 'utf8');
    const reloaded = new ProjectMapBindingStore(directory);
    await reloaded.init();

    await expect(reloaded.get(request)).resolves.toEqual([]);
    await expect(fs.access(`${filePath}.corrupt`)).resolves.toBeUndefined();
  });
});
