import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_TEXT_MAX_BYTES } from '../shared/project-workspace';
import { AgentProjectStore } from './agent-project-store';
import { ProjectWorkspaceAccessStore } from './project-workspace-access-store';
import { ProjectWorkspaceService } from './project-workspace-service';
import type { WorktreeInfo, WorktreeResult } from '../shared/worktree';

interface TemporaryPath {
  readonly path: string;
  readonly kind: 'directory' | 'link';
}

const temporaryPaths: TemporaryPath[] = [];

function publicProjectId(root: string): string {
  const normalized = path.normalize(root);
  const key = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

async function fixture(parentDirectory = os.tmpdir()): Promise<{
  readonly base: string;
  readonly root: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly store: AgentProjectStore;
  readonly userData: string;
  readonly service: ProjectWorkspaceService;
}> {
  const base = await fs.mkdtemp(path.join(parentDirectory, 'ez-project-workspace-'));
  temporaryPaths.push({ path: base, kind: 'directory' });
  const root = path.join(base, 'project');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, 'agent-projects.json'), JSON.stringify({
    version: 3,
    projects: [{
      projectId: 'legacy-persistence-id',
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
  const store = new AgentProjectStore(userData);
  await store.init();
  const service = new ProjectWorkspaceService(store);
  const projectId = publicProjectId(root);
  const described = service.describeProject(projectId);
  if (!described.ok) throw new Error('fixture descriptor failed');
  return {
    base,
    root,
    projectId,
    rootId: described.project.roots[0]!.rootId,
    store,
    userData,
    service,
  };
}

afterEach(async () => {
  for (const temporary of temporaryPaths.splice(0).reverse()) {
    if (temporary.kind === 'link') {
      await fs.unlink(temporary.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } else {
      await fs.rm(temporary.path, { recursive: true, force: true });
    }
  }
});

describe('ProjectWorkspaceService', () => {
  it('lists and reads only project-relative text while returning a content version', async () => {
    const test = await fixture();
    await fs.mkdir(path.join(test.root, 'src'));
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'export const answer = 42;\n');

    await expect(test.service.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: '',
    })).resolves.toMatchObject({
      ok: true,
      entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
    });

    const read = await test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/app.ts',
    });
    expect(read).toMatchObject({
      ok: true,
      file: { content: 'export const answer = 42;\n', language: 'typescript' },
    });
    expect(read.ok && read.file.version).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects traversal, absolute paths, binary data, and oversized files', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, 'binary.bin'), Buffer.from([1, 0, 2]));
    await fs.writeFile(path.join(test.root, 'large.txt'), Buffer.alloc(PROJECT_TEXT_MAX_BYTES + 1, 0x61));

    const rejectedPaths = ['../outside.txt', '/outside.txt', 'C:\\outside.txt'];
    if (process.platform === 'win32') rejectedPaths.push('binary.bin:hidden-stream');
    for (const relativePath of rejectedPaths) {
      await expect(test.service.readText({
        projectId: test.projectId,
        rootId: test.rootId,
        relativePath,
      })).resolves.toMatchObject({ ok: false, error: 'path-outside-root' });
    }
    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'binary.bin',
    })).resolves.toEqual({ ok: false, error: 'binary' });
    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'large.txt',
    })).resolves.toEqual({ ok: false, error: 'too-large' });
  });

  it('detects sensitive-looking content', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, '.env'), 'API_KEY=secret\nSECOND=value\n');
    const request = { projectId: test.projectId, rootId: test.rootId, relativePath: '.env' };
    const read = await test.service.readText(request);
    if (!read.ok) throw new Error('fixture read failed');
    expect(read.file.sensitive).toBe(true);

  });

  it('detects sensitive content beyond the beginning of a bounded text file', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, 'notes.txt'), `${'a'.repeat(70_000)}\npassword=secret\n`);

    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'notes.txt',
    })).resolves.toMatchObject({
      ok: true,
      file: { sensitive: true },
    });
  });

  it('performs bounded filename/content search and masks sensitive previews', async () => {
    const test = await fixture();
    await fs.mkdir(path.join(test.root, 'src'));
    await fs.writeFile(path.join(test.root, 'src', 'alpha.ts'), 'const needle = 1;\n');
    await fs.writeFile(path.join(test.root, '.env'), 'TOKEN=needle\n');

    await expect(test.service.search({
      requestId: 'files',
      projectId: test.projectId,
      query: 'alpha',
      mode: 'files',
    })).resolves.toMatchObject({
      ok: true,
      matches: [{ relativePath: 'src/alpha.ts' }],
    });

    const content = await test.service.search({
      requestId: 'content',
      projectId: test.projectId,
      query: 'needle',
      mode: 'content',
    });
    expect(content.ok && content.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'src/alpha.ts', line: 1, preview: 'const needle = 1;' }),
      expect.objectContaining({ relativePath: '.env', line: 1, preview: '[sensitive content hidden]' }),
    ]));
  });

  it('never follows a symlink or junction inside the registered root', async () => {
    const test = await fixture();
    const outside = path.join(test.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(test.root, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'linked/secret.txt',
    })).resolves.toEqual({ ok: false, error: 'symlink-not-supported' });
    const listing = await test.service.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: '',
    });
    expect(listing.ok && listing.entries.some((entry) => entry.name === 'linked')).toBe(false);
  });

  it('accepts a regular root below a linked ancestor without following links inside it', async () => {
    const actualParent = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-workspace-parent-'));
    temporaryPaths.push({ path: actualParent, kind: 'directory' });
    const linkedParent = `${actualParent}-link`;
    await fs.symlink(actualParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryPaths.push({ path: linkedParent, kind: 'link' });

    const test = await fixture(linkedParent);
    expect((await fs.lstat(test.root)).isSymbolicLink()).toBe(false);
    expect(await fs.realpath(test.root)).not.toBe(path.resolve(test.root));
    await fs.writeFile(path.join(test.root, 'visible.txt'), 'visible content\n');

    await expect(test.service.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: '',
    })).resolves.toMatchObject({
      ok: true,
      entries: [expect.objectContaining({ name: 'visible.txt', kind: 'file' })],
    });
    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'visible.txt',
    })).resolves.toMatchObject({
      ok: true,
      file: { content: 'visible content\n' },
    });

    const canonicalStore = new AgentProjectStore(path.join(actualParent, 'canonical-user-data'));
    await canonicalStore.init();
    const saved = await canonicalStore.upsert({
      name: 'Canonical fixture',
      primaryRoot: test.root,
      additionalRoots: [],
      pinned: false,
    });
    if (!saved.ok) throw new Error('canonical fixture project failed');
    const canonicalService = new ProjectWorkspaceService(canonicalStore);
    const canonicalDescription = canonicalService.describeProject(saved.project.projectId);
    if (!canonicalDescription.ok) throw new Error('canonical fixture descriptor failed');
    await expect(canonicalService.resolveAbsoluteProjectPath({
      projectId: saved.project.projectId,
      absolutePath: path.join(test.root, 'visible.txt'),
    })).resolves.toMatchObject({
      ok: true,
      request: {
        rootId: canonicalDescription.project.roots[0]!.rootId,
        relativePath: 'visible.txt',
      },
    });

    const directRootLink = path.join(actualParent, 'direct-root-link');
    await fs.symlink(test.root, directRootLink, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryPaths.push({ path: directRootLink, kind: 'link' });
    await expect(canonicalService.resolveAbsoluteProjectPath({
      projectId: saved.project.projectId,
      absolutePath: path.join(directRootLink, 'visible.txt'),
    })).resolves.toEqual({ ok: false, error: 'path-outside-root' });

    const outside = path.join(actualParent, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await fs.symlink(outside, path.join(test.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(test.service.readText({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'linked/secret.txt',
    })).resolves.toEqual({ ok: false, error: 'symlink-not-supported' });
  });

  it('resolves a physical root alias to project terminal metadata only at the exact root', async () => {
    const actualParent = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-terminal-parent-'));
    temporaryPaths.push({ path: actualParent, kind: 'directory' });
    const linkedParent = `${actualParent}-link`;
    await fs.symlink(actualParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryPaths.push({ path: linkedParent, kind: 'link' });
    const test = await fixture(linkedParent);
    const canonicalRoot = await fs.realpath(test.root);
    expect(canonicalRoot).not.toBe(path.resolve(test.root));
    await fs.mkdir(path.join(test.root, 'src'));

    const listWorktrees = async (): Promise<WorktreeResult> => ({
      ok: true,
      action: 'list',
      worktrees: [{
        worktreeId: 'main-worktree',
        repoId: 'repo-fixture',
        path: canonicalRoot,
        branch: 'main',
        head: 'a'.repeat(40),
        main: true,
        locked: false,
        managed: true,
        prunable: false,
      }],
    });
    const service = new ProjectWorkspaceService(test.store, { listWorktrees });
    const described = await service.describeProjectWorkspaces(test.projectId);
    expect(described.ok && described.project.workspaces?.[0]?.displayPath).toBe(canonicalRoot);

    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: test.root,
    })).resolves.toEqual({
      ok: true,
      projectSession: {
        projectId: test.projectId,
        rootId: test.rootId,
        workspaceId: 'main-worktree',
        projectName: 'Fixture',
        titleMode: 'generated',
      },
    });
    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: path.join(test.root, 'src'),
    })).resolves.toEqual({ ok: false, error: 'not-workspace-root' });
    await expect(service.resolveTerminalDirectory({
      absolutePath: test.root,
    })).resolves.toEqual({ ok: false, error: 'invalid-request' });
    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: actualParent,
    })).resolves.toEqual({ ok: false, error: 'path-outside-root' });
  });

  it('requires durable consent for an external worktree and returns its canonical launch path', async () => {
    const actualParent = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-workspace-external-parent-'));
    temporaryPaths.push({ path: actualParent, kind: 'directory' });
    const linkedParent = `${actualParent}-link`;
    await fs.symlink(actualParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryPaths.push({ path: linkedParent, kind: 'link' });
    const test = await fixture(linkedParent);
    const external = path.join(test.base, 'external-worktree');
    await fs.mkdir(external);
    const canonicalExternal = await fs.realpath(external);
    expect(canonicalExternal).not.toBe(path.resolve(external));
    await fs.writeFile(path.join(external, 'external.txt'), 'approved content\n');
    let externalRepoId = 'repo-fixture';
    const worktrees = (): readonly WorktreeInfo[] => [{
      worktreeId: 'main-worktree',
      repoId: 'repo-fixture',
      path: test.root,
      branch: 'main',
      head: 'a'.repeat(40),
      main: true,
      locked: false,
      managed: true,
      prunable: false,
    }, {
      worktreeId: 'external-worktree',
      repoId: externalRepoId,
      path: external,
      branch: 'review/external',
      head: 'b'.repeat(40),
      main: false,
      locked: false,
      managed: false,
      prunable: false,
    }];
    const listWorktrees = async (): Promise<WorktreeResult> => ({
      ok: true,
      action: 'list',
      worktrees: worktrees(),
    });
    const accessStore = new ProjectWorkspaceAccessStore(test.userData);
    await accessStore.init();
    const service = new ProjectWorkspaceService(test.store, { listWorktrees, accessStore });
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      workspaceId: 'external-worktree',
      relativePath: 'external.txt',
    };

    const before = await service.describeProjectWorkspaces(test.projectId);
    expect(before.ok && before.project.workspaces?.find((item) => item.workspaceId === 'external-worktree')).toMatchObject({
      kind: 'external',
      access: 'authorization-required',
    });
    await expect(service.readText(request)).resolves.toEqual({ ok: false, error: 'authorization-required' });
    await expect(service.resolveSessionTarget({
      projectId: test.projectId,
      rootId: test.rootId,
      workspaceId: 'external-worktree',
    })).resolves.toEqual({ ok: false, error: 'authorization-required' });
    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: canonicalExternal,
    })).resolves.toEqual({ ok: false, error: 'authorization-required' });
    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: external,
    })).resolves.toEqual({ ok: false, error: 'path-outside-root' });

    await expect(service.approveWorkspace(request)).resolves.toMatchObject({
      ok: true,
      workspace: { workspaceId: 'external-worktree', access: 'granted' },
    });
    await expect(service.readText(request)).resolves.toMatchObject({
      ok: true,
      file: { content: 'approved content\n' },
    });
    await expect(service.resolveSessionTarget({
      projectId: test.projectId,
      rootId: test.rootId,
      workspaceId: 'external-worktree',
    })).resolves.toMatchObject({
      ok: true,
      target: {
        projectId: test.projectId,
        rootId: test.rootId,
        workspaceId: 'external-worktree',
      },
      cwd: canonicalExternal,
      roots: [canonicalExternal],
    });
    await expect(service.resolveTerminalDirectory({
      projectId: test.projectId,
      absolutePath: external,
    })).resolves.toMatchObject({
      ok: true,
      projectSession: {
        projectId: test.projectId,
        rootId: test.rootId,
        workspaceId: 'external-worktree',
      },
    });

    const reloadedStore = new ProjectWorkspaceAccessStore(test.userData);
    await reloadedStore.init();
    const reloadedService = new ProjectWorkspaceService(test.store, { listWorktrees, accessStore: reloadedStore });
    await expect(reloadedService.readText(request)).resolves.toMatchObject({ ok: true });

    externalRepoId = 'repo-replaced';
    await expect(reloadedService.readText(request)).resolves.toEqual({
      ok: false,
      error: 'authorization-required',
    });
    await expect(reloadedService.resolveSessionTarget({
      projectId: test.projectId,
      rootId: test.rootId,
      workspaceId: 'external-worktree',
    })).resolves.toEqual({ ok: false, error: 'authorization-required' });
  });
});
