import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProjectWorkspaceAccessStore,
  type ProjectWorkspaceAccessIdentity,
} from './project-workspace-access-store';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-workspace-consent-'));
  temporaryDirectories.push(directory);
  return directory;
}

const identity = (root: string): ProjectWorkspaceAccessIdentity => ({
  projectId: 'project-one',
  rootId: 'root-one',
  workspaceId: 'workspace-one',
  repositoryId: 'repository-one',
  canonicalPath: path.join(root, 'external-worktree'),
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('ProjectWorkspaceAccessStore consent journal', () => {
  it('keeps approval and revocation intents fail-closed across restart until exact commit', async () => {
    const directory = await temporaryDirectory();
    const access = identity(directory);
    const first = new ProjectWorkspaceAccessStore(directory);
    await first.init();

    const approval = await first.beginApproval(access);
    expect(first.isApproved(access)).toBe(false);
    expect(first.listPendingIntents()).toEqual([approval]);

    const approvalRecovery = new ProjectWorkspaceAccessStore(directory);
    await approvalRecovery.init();
    expect(approvalRecovery.isApproved(access)).toBe(false);
    expect(approvalRecovery.listPendingIntents()).toEqual([approval]);

    await expect(approvalRecovery.discardApproval({
      ...approval,
      createdAt: approval.createdAt + 1,
    })).resolves.toBe(false);
    expect(approvalRecovery.listPendingIntents()).toEqual([approval]);

    await expect(approvalRecovery.commitApproval(approval)).resolves.toBe(true);
    expect(approvalRecovery.isApproved(access)).toBe(true);

    const revocation = await approvalRecovery.beginRevocation(access);
    expect(revocation).toBeDefined();
    expect(approvalRecovery.isApproved(access)).toBe(false);

    const revocationRecovery = new ProjectWorkspaceAccessStore(directory);
    await revocationRecovery.init();
    expect(revocationRecovery.isApproved(access)).toBe(false);
    expect(revocationRecovery.listPendingIntents()).toEqual([revocation]);
    await expect(revocationRecovery.commitRevocation(revocation!)).resolves.toBe(true);
    expect(revocationRecovery.isApproved(access)).toBe(false);
    expect(revocationRecovery.hasApproval(access)).toBe(false);
    expect(revocationRecovery.listPendingIntents()).toEqual([]);
  });

  it('discards only an exact stale approval intent without revealing an older grant', async () => {
    const directory = await temporaryDirectory();
    const access = identity(directory);
    const replacement = { ...access, repositoryId: 'repo-replacement' };
    const store = new ProjectWorkspaceAccessStore(directory);
    await store.init();
    await store.approve(access);

    const pending = await store.beginApproval(replacement);
    expect(store.isApproved(access)).toBe(false);
    await expect(store.discardApproval({
      ...pending,
      identity: { ...pending.identity, canonicalPath: path.join(directory, 'wrong') },
    })).resolves.toBe(false);
    expect(store.listPendingIntents()).toEqual([pending]);

    await expect(store.discardApproval(pending)).resolves.toBe(true);
    expect(store.listPendingIntents()).toEqual([]);
    expect(store.hasApproval(access)).toBe(false);
    expect(store.isApproved(access)).toBe(false);
    await expect(store.discardApproval({ ...pending, kind: 'revoke' })).resolves.toBe(false);
  });

  it('atomically migrates bounded v1 approved entries without granting malformed pending data', async () => {
    const directory = await temporaryDirectory();
    const access = identity(directory);
    const file = path.join(directory, 'project-workspace-access.json');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      entries: [{ ...access, approvedAt: 123 }],
    }));

    const migrated = new ProjectWorkspaceAccessStore(directory);
    await migrated.init();
    expect(migrated.isApproved(access)).toBe(true);
    expect(migrated.listPendingIntents()).toEqual([]);
    await expect(fs.readFile(file, 'utf8').then((value) => JSON.parse(value))).resolves.toMatchObject({
      version: 2,
      entries: [{ ...access, approvedAt: 123 }],
      pending: [],
    });

    await fs.writeFile(file, JSON.stringify({
      version: 2,
      entries: [],
      pending: [{
        kind: 'approve',
        identity: { ...access, projectId: 'x'.repeat(129) },
        createdAt: 1,
      }],
    }));
    const rejected = new ProjectWorkspaceAccessStore(directory);
    await rejected.init();
    expect(rejected.isApproved(access)).toBe(false);
    expect(rejected.listPendingIntents()).toEqual([]);
    await expect(fs.stat(`${file}.corrupt`)).resolves.toBeDefined();
  });
});
