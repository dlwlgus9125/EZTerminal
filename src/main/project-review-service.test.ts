import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';
import { ProjectReviewService } from './project-review-service';
import { ProjectWorkspaceService } from './project-workspace-service';

const temporaryDirectories: string[] = [];
const temporaryLinks: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`;
}

async function configureMarkerFilter(root: string): Promise<string> {
  const marker = path.join(root, 'filter-clean.marker');
  const helper = path.join(root, 'filter-clean.cjs');
  await fs.writeFile(path.join(root, '.gitattributes'), '*.ts filter=project-review-marker\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-m', 'attributes');
  await fs.writeFile(helper, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(marker)}, 'invoked');`,
    'process.stdin.pipe(process.stdout);',
  ].join('\n'));
  git(root, 'config', 'filter.project-review-marker.clean', `${shellQuote(process.execPath)} ${shellQuote(helper)}`);
  git(root, 'config', 'filter.project-review-marker.required', 'true');
  return marker;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly review: ProjectReviewService;
  readonly readFileChanges: ReturnType<typeof vi.fn>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-review-'));
  temporaryDirectories.push(base);
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  git(root, 'init', '-b', 'main');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');

  const store = new AgentProjectStore(path.join(base, 'user-data'));
  await store.init();
  const saved = await store.upsert({
    name: 'Review fixture',
    primaryRoot: root,
    additionalRoots: [],
    pinned: false,
  });
  if (!saved.ok) throw new Error('fixture project failed');
  const workspace = new ProjectWorkspaceService(store);
  const described = workspace.describeProject(saved.project.projectId);
  if (!described.ok) throw new Error('fixture descriptor failed');
  const readFileChanges = vi.fn(async () => null);
  const history = { readFileChanges } as unknown as AgentHistoryService;
  return {
    root,
    projectId: saved.project.projectId,
    rootId: described.project.roots[0]!.rootId,
    review: new ProjectReviewService(workspace, history),
    readFileChanges,
  };
}

afterEach(async () => {
  await Promise.all(temporaryLinks.splice(0).map((link) =>
    fs.unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('ProjectReviewService', () => {
  it('returns working-tree tracked and untracked files with lazy before/after models', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 2;\n');
    await fs.writeFile(path.join(test.root, 'new.txt'), 'new file\n');
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'working-tree' as const,
    };

    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({
      ok: true,
      source: 'git',
      changes: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'src/app.ts', kind: 'modified' }),
        expect.objectContaining({ relativePath: 'new.txt', kind: 'added' }),
      ]),
    });
    if (!index.ok) throw new Error('index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      binary: false,
      view: {
        kind: 'full-diff',
        coverage: 'full-file',
        original: 'const value = 1;\n',
        modified: 'const value = 2;\n',
      },
    });

    const replacement = path.join(test.root, 'src', 'replacement.ts');
    await fs.writeFile(replacement, 'const value = 3;\n');
    await fs.rm(path.join(test.root, 'src', 'app.ts'));
    await fs.rename(replacement, path.join(test.root, 'src', 'app.ts'));
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toEqual({ ok: false, error: 'stale' });
  });

  it('locates the nearest nested repository and reviews its exact changed file', async () => {
    const test = await fixture();
    const nestedRoot = path.join(test.root, 'out', 'manual-test-project');
    await fs.mkdir(path.join(nestedRoot, 'src'), { recursive: true });
    git(nestedRoot, 'init', '-b', 'main');
    await fs.writeFile(path.join(nestedRoot, 'src', 'app.ts'), 'const nested = 1;\n');
    git(nestedRoot, 'add', '.');
    git(nestedRoot, 'commit', '-m', 'nested base');
    await fs.writeFile(path.join(nestedRoot, 'src', 'app.ts'), 'const nested = 2;\n');

    const located = await test.review.locateRepository({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'out/manual-test-project/src/app.ts',
    });
    expect(located).toMatchObject({
      ok: true,
      target: {
        projectId: test.projectId,
        rootId: test.rootId,
        workspaceId: test.rootId,
        repositoryRelativePath: 'out/manual-test-project',
        repositoryName: 'manual-test-project',
        relativePath: 'src/app.ts',
      },
    });
    if (!located.ok) throw new Error('nested repository location failed');

    const request = {
      projectId: located.target.projectId,
      rootId: located.target.rootId,
      repositoryRelativePath: located.target.repositoryRelativePath,
      scope: 'working-tree' as const,
    };
    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({
      ok: true,
      repositoryName: 'manual-test-project',
      changes: [expect.objectContaining({ relativePath: 'src/app.ts', kind: 'modified' })],
    });
    if (!index.ok) throw new Error('nested index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: located.target.relativePath,
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'full-diff',
        original: 'const nested = 1;\n',
        modified: 'const nested = 2;\n',
      },
    });
  });

  it('rehydrates a Last turn patch against the complete file inside a nested repository', async () => {
    const test = await fixture();
    const repositoryRelativePath = 'out/manual-test-project';
    const nestedFile = path.join(test.root, repositoryRelativePath, 'src', 'app.ts');
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(
      nestedFile,
      'context before\nconst nested = 2;\ncontext after\n',
    );
    const linkedBase = `${path.dirname(test.root)}-provider-link`;
    await fs.symlink(path.dirname(test.root), linkedBase, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryLinks.push(linkedBase);
    const providerNestedFile = path.join(
      linkedBase,
      path.basename(test.root),
      repositoryRelativePath,
      'src',
      'app.ts',
    );
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      repositoryRelativePath,
      scope: 'last-turn' as const,
      historyId: 'history-nested-context',
      reviewTurnId: 'turn-selected-context',
    };
    test.readFileChanges.mockResolvedValueOnce({
      provider: 'codex',
      turnId: 'turn-nested-context',
      changes: [{
        path: providerNestedFile,
        kind: 'modified',
        diff: '@@ -1,3 +1,3 @@\n context before\n-const nested = 1;\n+const nested = 2;\n context after',
      }],
    });

    const index = await test.review.getIndex(request);
    expect(test.readFileChanges).toHaveBeenCalledWith(
      'history-nested-context',
      'turn-selected-context',
    );
    if (!index.ok) throw new Error('nested Last turn index failed');
    const indexedPath = index.changes[0]?.relativePath;
    if (!indexedPath) throw new Error('nested Last turn change missing');
    await expect(test.review.getFile({
      ...request,
      relativePath: indexedPath,
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'full-diff',
        coverage: 'current-context',
        original: 'context before\nconst nested = 1;\ncontext after\n',
        modified: 'context before\nconst nested = 2;\ncontext after\n',
      },
    });
    expect(index.changes).toEqual([
      expect.objectContaining({ relativePath: 'src/app.ts', additions: 1, deletions: 1 }),
    ]);
  });

  it('reviews all files in a repository that does not have its first commit yet', async () => {
    const test = await fixture();
    await fs.rm(path.join(test.root, '.git'), { recursive: true, force: true });
    git(test.root, 'init', '-b', 'main');
    await fs.writeFile(path.join(test.root, 'draft.txt'), 'first draft\n');
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'working-tree' as const,
    };
    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({
      ok: true,
      changes: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'draft.txt', kind: 'added' }),
      ]),
    });
    if (!index.ok) throw new Error('index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: 'draft.txt',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: { kind: 'full-diff', original: '', modified: 'first draft\n' },
    });
  });

  it('separates staged changes from unstaged work', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 2;\n');
    git(test.root, 'add', 'src/app.ts');
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 3;\n');
    const request = { projectId: test.projectId, rootId: test.rootId, scope: 'staged' as const };
    const index = await test.review.getIndex(request);
    if (!index.ok) throw new Error('index failed');

    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'full-diff',
        original: 'const value = 1;\n',
        modified: 'const value = 2;\n',
      },
    });
  });

  it('compares HEAD to the local merge-base without fetching', async () => {
    const test = await fixture();
    git(test.root, 'checkout', '-b', 'feature');
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 4;\n');
    git(test.root, 'add', '.');
    git(test.root, 'commit', '-m', 'feature');
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'branch' as const,
      baseRef: 'main',
    };
    const index = await test.review.getIndex(request);
    if (!index.ok) throw new Error('index failed');
    expect(index.changes).toEqual([
      expect.objectContaining({ relativePath: 'src/app.ts', kind: 'modified' }),
    ]);
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'full-diff',
        original: 'const value = 1;\n',
        modified: 'const value = 4;\n',
      },
    });
  });

  it('uses only a completed provider record for Last turn and otherwise requests a truthful fallback', async () => {
    const test = await fixture();
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'last-turn' as const,
      historyId: 'history-1',
    };
    await expect(test.review.getIndex(request)).resolves.toMatchObject({
      ok: false,
      fallbackScope: 'working-tree',
    });

    test.readFileChanges.mockResolvedValueOnce({
      provider: 'codex',
      turnId: 'turn-1',
      changes: [{
        path: 'src/app.ts',
        previousPath: path.join(test.root, '..', 'outside.ts'),
        kind: 'modified',
        diff: '@@ -1 +1 @@\n-const value = 1;\n+password=secret',
      }],
    });
    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({
      ok: true,
      source: 'codex',
      changes: [{ relativePath: 'src/app.ts', additions: 1, deletions: 1 }],
    });
    if (!index.ok) throw new Error('index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'current-with-record',
        current: 'const value = 1;\n',
        sections: [expect.objectContaining({
          lines: expect.arrayContaining([
            expect.objectContaining({ kind: 'added', text: 'password=secret' }),
          ]),
        })],
      },
      originalPath: 'src/app.ts',
      sensitive: true,
    });
  });

  it('rehydrates all ordered provider edits into the current full-file context', async () => {
    const test = await fixture();
    await fs.writeFile(
      path.join(test.root, 'src', 'app.ts'),
      'header\nconst value = 3;\npost-turn context\n',
    );
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'last-turn' as const,
      historyId: 'history-current-context',
    };
    test.readFileChanges.mockResolvedValueOnce({
      provider: 'claude',
      turnId: 'turn-current-context',
      changes: [
        {
          path: 'src/app.ts',
          kind: 'modified',
          original: 'const value = 1;',
          modified: 'const value = 2;',
        },
        {
          path: 'src/app.ts',
          kind: 'modified',
          original: 'const value = 2;',
          modified: 'const value = 3;',
        },
      ],
    });

    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({
      ok: true,
      changes: [{ relativePath: 'src/app.ts', additions: 2, deletions: 2 }],
    });
    if (!index.ok) throw new Error('index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({
      ok: true,
      view: {
        kind: 'full-diff',
        coverage: 'current-context',
        original: 'header\nconst value = 1;\npost-turn context\n',
        modified: 'header\nconst value = 3;\npost-turn context\n',
      },
    });
  });

  it('does not execute a repository-configured clean filter while reviewing', async () => {
    const test = await fixture();
    const marker = await configureMarkerFilter(test.root);
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 9;\n');
    const request = {
      projectId: test.projectId,
      rootId: test.rootId,
      scope: 'working-tree' as const,
    };
    const index = await test.review.getIndex(request);
    expect(index).toMatchObject({ ok: true });
    if (!index.ok) throw new Error('index failed');
    await expect(test.review.getFile({
      ...request,
      relativePath: 'src/app.ts',
      revision: index.revision,
    })).resolves.toMatchObject({ ok: true });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
