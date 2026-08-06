import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_TEXT_MAX_BYTES } from '../shared/project-workspace';
import { AgentProjectStore } from './agent-project-store';
import { ProjectWorkspaceService } from './project-workspace-service';

const temporaryDirectories: string[] = [];

function publicProjectId(root: string): string {
  const normalized = path.normalize(root);
  const key = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

async function fixture(): Promise<{
  readonly base: string;
  readonly root: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly service: ProjectWorkspaceService;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-workspace-'));
  temporaryDirectories.push(base);
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
    service,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
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

  it('detects stale line references and sensitive-looking content', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, '.env'), 'API_KEY=secret\nSECOND=value\n');
    const request = { projectId: test.projectId, rootId: test.rootId, relativePath: '.env' };
    const read = await test.service.readText(request);
    if (!read.ok) throw new Error('fixture read failed');
    expect(read.file.sensitive).toBe(true);

    await expect(test.service.validateText({
      ...request,
      version: read.file.version,
      startLine: 1,
      endLine: 2,
    })).resolves.toMatchObject({ ok: true, sensitive: true });

    await fs.writeFile(path.join(test.root, '.env'), 'API_KEY=changed\n');
    await expect(test.service.validateText({
      ...request,
      version: read.file.version,
      startLine: 1,
      endLine: 2,
    })).resolves.toEqual({ ok: false, error: 'stale' });
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
});
