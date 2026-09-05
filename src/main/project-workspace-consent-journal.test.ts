import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentProjectStore } from './agent-project-store';
import { ProjectWorkspaceAccessStore } from './project-workspace-access-store';
import { ProjectWorkspaceService } from './project-workspace-service';
import type { WorktreeInfo, WorktreeResult } from '../shared/worktree';

const temporaryDirectories: string[] = [];

function publicProjectId(root: string): string {
  const normalized = path.normalize(root);
  const key = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('ProjectWorkspaceService consent recovery', () => {
  it('propagates shutdown abort instead of classifying a cancelled Git listing as stale approval', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-workspace-consent-abort-'));
    temporaryDirectories.push(base);
    const root = path.join(base, 'project');
    const external = path.join(base, 'external');
    const userData = path.join(base, 'user-data');
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(external, { recursive: true }),
      fs.mkdir(userData, { recursive: true }),
    ]);
    await fs.writeFile(path.join(userData, 'agent-projects.json'), JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'stored-project',
        name: 'Fixture',
        primaryRoot: root,
        additionalRoots: [],
        pinned: true,
        origin: 'manual',
        lastActiveAt: null,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const projects = new AgentProjectStore(userData);
    await projects.init();
    const projectId = publicProjectId(root);
    const described = new ProjectWorkspaceService(projects).describeProject(projectId);
    if (!described.ok) throw new Error('fixture descriptor failed');
    const identity = {
      projectId,
      rootId: described.project.roots[0]!.rootId,
      workspaceId: 'external-worktree',
      repositoryId: 'repo-one',
      canonicalPath: await fs.realpath(external),
    };
    const accessStore = new ProjectWorkspaceAccessStore(userData);
    await accessStore.init();
    const intent = await accessStore.beginApproval(identity);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let adapterDrained = false;
    const service = new ProjectWorkspaceService(projects, {
      accessStore,
      listWorktrees: async (_cwd, signal) => {
        receivedSignal = signal;
        controller.abort(new DOMException('shutdown drain', 'AbortError'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        adapterDrained = true;
        throw new Error('Git adapter converted its cancelled work into a failure');
      },
    });

    await expect(service.recoverPendingWorkspaceAccess(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'shutdown drain',
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(adapterDrained).toBe(true);
    expect(accessStore.listPendingIntents()).toEqual([intent]);
    expect(accessStore.isApproved(identity)).toBe(false);
  });

  it('revalidates an approval intent against the exact repository and canonical path', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-workspace-consent-service-'));
    temporaryDirectories.push(base);
    const root = path.join(base, 'project');
    const external = path.join(base, 'external');
    const replacement = path.join(base, 'replacement');
    const userData = path.join(base, 'user-data');
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(external, { recursive: true }),
      fs.mkdir(replacement, { recursive: true }),
      fs.mkdir(userData, { recursive: true }),
    ]);
    await fs.writeFile(path.join(userData, 'agent-projects.json'), JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'stored-project',
        name: 'Fixture',
        primaryRoot: root,
        additionalRoots: [],
        pinned: true,
        origin: 'manual',
        lastActiveAt: null,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const projects = new AgentProjectStore(userData);
    await projects.init();
    const projectId = publicProjectId(root);
    const described = new ProjectWorkspaceService(projects).describeProject(projectId);
    if (!described.ok) throw new Error('fixture descriptor failed');
    const rootId = described.project.roots[0]!.rootId;
    let externalPath = external;
    let externalRepositoryId = 'repo-one';
    let listingFails = false;
    const worktrees = (): readonly WorktreeInfo[] => [{
      worktreeId: 'main-worktree',
      repoId: 'repo-one',
      path: root,
      branch: 'main',
      head: 'a'.repeat(40),
      main: true,
      locked: false,
      managed: true,
      prunable: false,
    }, {
      worktreeId: 'external-worktree',
      repoId: externalRepositoryId,
      path: externalPath,
      branch: 'review/external',
      head: 'b'.repeat(40),
      main: false,
      locked: false,
      managed: false,
      prunable: false,
    }];
    const listWorktrees = async (): Promise<WorktreeResult> => listingFails
      ? { ok: false, action: 'list', error: 'GIT_FAILED', message: 'transient failure' }
      : { ok: true, action: 'list', worktrees: worktrees() };
    const accessStore = new ProjectWorkspaceAccessStore(userData);
    await accessStore.init();
    const service = new ProjectWorkspaceService(projects, { accessStore, listWorktrees });
    const request = { projectId, rootId, workspaceId: 'external-worktree' };

    const begun = await service.beginWorkspaceApproval(request);
    expect(begun).toMatchObject({
      ok: true,
      intent: { kind: 'approve', identity: { ...request, repositoryId: 'repo-one' } },
      workspace: { workspaceId: 'external-worktree', access: 'granted' },
      project: { projectId },
    });
    if (!begun.ok) throw new Error('expected approval intent');
    expect(accessStore.isApproved(begun.intent.identity)).toBe(false);

    const restartedStore = new ProjectWorkspaceAccessStore(userData);
    await restartedStore.init();
    const restarted = new ProjectWorkspaceService(projects, {
      accessStore: restartedStore,
      listWorktrees,
    });
    await expect(restarted.recoverPendingWorkspaceAccess()).resolves.toMatchObject([{
      ok: true,
      intent: begun.intent,
      workspace: { workspaceId: 'external-worktree', access: 'granted' },
      project: { projectId },
    }]);

    externalRepositoryId = 'repo-replacement';
    await expect(restarted.recoverPendingWorkspaceAccess()).resolves.toEqual([{
      ok: false,
      intent: begun.intent,
      error: 'workspace-not-found',
    }]);
    externalRepositoryId = 'repo-one';
    externalPath = replacement;
    await expect(restarted.recoverPendingWorkspaceAccess()).resolves.toEqual([{
      ok: false,
      intent: begun.intent,
      error: 'workspace-not-found',
    }]);
    await expect(restarted.discardWorkspaceAccessIntent({
      ...begun.intent,
      createdAt: begun.intent.createdAt + 1,
    })).resolves.toBe(false);
    expect(restarted.listPendingWorkspaceAccess()).toEqual([begun.intent]);
    await expect(restarted.discardWorkspaceAccessIntent(begun.intent)).resolves.toBe(true);
    expect(restarted.listPendingWorkspaceAccess()).toEqual([]);
    expect(restartedStore.hasApproval(request)).toBe(false);

    externalPath = external;
    const replacementApproval = await restarted.beginWorkspaceApproval(request);
    if (!replacementApproval.ok) throw new Error('expected replacement approval intent');
    await expect(restarted.commitWorkspaceApproval(replacementApproval.intent)).resolves.toBe(true);
    expect(restartedStore.isApproved(replacementApproval.intent.identity)).toBe(true);

    const retryApproval = await restarted.beginWorkspaceApproval(request);
    if (!retryApproval.ok) throw new Error('expected retry approval intent');
    listingFails = true;
    await expect(restarted.recoverPendingWorkspaceAccess()).rejects.toMatchObject({
      code: 'git-failed',
    });
    expect(restarted.listPendingWorkspaceAccess()).toEqual([retryApproval.intent]);
    expect(restartedStore.hasApproval(request)).toBe(true);
    listingFails = false;
    await expect(restarted.commitWorkspaceApproval(retryApproval.intent)).resolves.toBe(true);

    const revocation = await restarted.beginWorkspaceRevocation(request);
    expect(revocation).toMatchObject({ ok: true, intent: { kind: 'revoke' }, request });
    if (!revocation.ok) throw new Error('expected revocation intent');
    expect(restartedStore.isApproved(revocation.intent.identity)).toBe(false);
    listingFails = true;
    await expect(restarted.recoverPendingWorkspaceAccess()).resolves.toEqual([{
      ok: true,
      intent: revocation.intent,
      request,
    }]);
    await expect(restarted.commitWorkspaceRevocation(revocation.intent)).resolves.toBe(true);
    expect(restartedStore.hasApproval(request)).toBe(false);
    await expect(restarted.discardWorkspaceAccessIntent(revocation.intent)).resolves.toBe(false);
  });
});
