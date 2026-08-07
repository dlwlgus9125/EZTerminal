import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHistoryService } from './agent-history-service';
import { AgentProjectStore } from './agent-project-store';
import { ProjectDocumentService } from './project-document-service';
import { ProjectReviewService } from './project-review-service';
import { ProjectWorkspaceService } from './project-workspace-service';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

async function fixture(): Promise<{
  readonly root: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly documents: ProjectDocumentService;
  readonly readFileChanges: ReturnType<typeof vi.fn>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-project-document-'));
  temporaryDirectories.push(base);
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'const value = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'deleted.ts'), 'delete me\n');
  await fs.writeFile(path.join(root, 'src', 'old.ts'), 'rename me\n');
  await fs.mkdir(path.join(root, 'legacy'));
  await fs.writeFile(path.join(root, 'legacy', 'gone.txt'), 'gone\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');

  const store = new AgentProjectStore(path.join(base, 'user-data'));
  await store.init();
  const saved = await store.upsert({
    name: 'Document fixture',
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
  const review = new ProjectReviewService(workspace, history);
  return {
    root,
    projectId: saved.project.projectId,
    rootId: described.project.roots[0]!.rootId,
    documents: new ProjectDocumentService(workspace, review),
    readFileChanges,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('ProjectDocumentService', () => {
  it('canonicalizes project and absolute targets to the same workspace-qualified identity', async () => {
    const test = await fixture();
    const byProjectPath = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/app.ts',
      line: 7,
    });
    const byAbsolutePath = await test.documents.resolveTarget({
      kind: 'absolute-path',
      absolutePath: path.join(test.root, 'src', 'app.ts'),
    });
    expect(byProjectPath).toMatchObject({
      ok: true,
      target: {
        document: { id: { workspaceId: test.rootId, relativePath: 'src/app.ts' } },
        lens: { kind: 'current' },
        line: 7,
      },
    });
    expect(byAbsolutePath).toMatchObject({ ok: true });
    if (!byProjectPath.ok || !byAbsolutePath.ok) throw new Error('target resolution failed');
    expect(byAbsolutePath.target.document.key).toBe(byProjectPath.target.document.key);
  });

  it('merges M/A/D/R status and exact counts into one lazy tree, including virtual deletions', async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), 'const value = 2;\nconst next = 3;\n');
    await fs.rm(path.join(test.root, 'src', 'deleted.ts'));
    git(test.root, 'mv', 'src/old.ts', 'src/renamed.ts');
    await fs.writeFile(path.join(test.root, 'src', 'new.ts'), 'first\nsecond\n');
    await fs.rm(path.join(test.root, 'legacy'), { recursive: true });

    const src = await test.documents.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src',
    });
    expect(src).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 }),
        expect.objectContaining({ relativePath: 'src/new.ts', status: 'added', additions: 2, deletions: 0 }),
        expect.objectContaining({ relativePath: 'src/deleted.ts', status: 'deleted', virtual: true }),
        expect.objectContaining({
          relativePath: 'src/renamed.ts',
          previousRelativePath: 'src/old.ts',
          status: 'renamed',
        }),
        expect.objectContaining({
          relativePath: 'src/old.ts',
          renamedToRelativePath: 'src/renamed.ts',
          status: 'renamed',
          virtual: true,
        }),
      ]),
    });

    const root = await test.documents.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: '',
    });
    expect(root).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'legacy', kind: 'directory', virtual: true }),
      ]),
    });
    const legacy = await test.documents.listDirectory({
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'legacy',
    });
    expect(legacy).toMatchObject({
      ok: true,
      entries: [expect.objectContaining({ relativePath: 'legacy/gone.txt', status: 'deleted', virtual: true })],
    });
  });

  it('returns the whole current file and inline working-tree comparison in one revision', async () => {
    const test = await fixture();
    const content = 'header\nconst value = 2;\nfooter\n';
    await fs.writeFile(path.join(test.root, 'src', 'app.ts'), content);
    const target = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/app.ts',
    });
    if (!target.ok) throw new Error('target resolution failed');
    await expect(test.documents.readDocument({
      document: target.target.document.id,
    })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        current: { content },
        state: 'text',
        comparison: {
          lens: { kind: 'current' },
          change: { kind: 'modified' },
          view: {
            kind: 'full-diff',
            coverage: 'full-file',
            original: 'const value = 1;\n',
            modified: content,
          },
        },
      },
    });
  });

  it('opens a deleted path as a same-document full-file deletion', async () => {
    const test = await fixture();
    await fs.rm(path.join(test.root, 'src', 'deleted.ts'));
    const target = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/deleted.ts',
    });
    if (!target.ok) throw new Error('target resolution failed');
    await expect(test.documents.readDocument({ document: target.target.document.id })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        document: { key: target.target.document.key },
        current: null,
        state: 'deleted',
        comparison: {
          change: { kind: 'deleted' },
          view: { kind: 'full-diff', original: 'delete me\n', modified: '' },
        },
      },
    });
  });

  it('opens the previous rename path as a virtual full-file deletion', async () => {
    const test = await fixture();
    git(test.root, 'mv', 'src/old.ts', 'src/renamed.ts');
    const target = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/old.ts',
    });
    if (!target.ok) throw new Error('target resolution failed');

    await expect(test.documents.readDocument({ document: target.target.document.id })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        document: { key: target.target.document.key },
        state: 'deleted',
        comparison: {
          change: { kind: 'deleted', relativePath: 'src/old.ts' },
          view: { kind: 'full-diff', original: 'rename me\n', modified: '' },
        },
      },
    });
  });

  it('uses an exact Agent turn lens without Git and without changing document identity', async () => {
    const test = await fixture();
    test.readFileChanges.mockResolvedValue({
      provider: 'codex',
      turnId: 'turn-7',
      changes: [{
        path: 'src/app.ts',
        kind: 'modified',
        original: 'const value = 0;',
        modified: 'const value = 1;',
      }],
    });
    await fs.rm(path.join(test.root, '.git'), { recursive: true });
    const target = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/app.ts',
      lens: { kind: 'agent-turn', historyId: 'history-7', turnId: 'turn-7' },
    });
    if (!target.ok) throw new Error('target resolution failed');
    const result = await test.documents.readDocument({
      document: target.target.document.id,
      lens: target.target.lens,
    });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        document: { key: target.target.document.key },
        lens: { kind: 'agent-turn', historyId: 'history-7', turnId: 'turn-7' },
        comparison: { source: 'codex', change: { relativePath: 'src/app.ts' } },
      },
    });
    expect(test.readFileChanges).toHaveBeenCalledWith('history-7', 'turn-7');
  });

  it('keeps a currently recreated file readable when an Agent turn recorded its deletion', async () => {
    const test = await fixture();
    test.readFileChanges.mockResolvedValue({
      provider: 'codex',
      turnId: 'turn-delete',
      changes: [{
        path: 'src/app.ts',
        kind: 'deleted',
        original: 'const value = 0;\n',
        modified: '',
      }],
    });
    const target = await test.documents.resolveTarget({
      kind: 'project-path',
      projectId: test.projectId,
      rootId: test.rootId,
      relativePath: 'src/app.ts',
      lens: { kind: 'agent-turn', historyId: 'history-delete', turnId: 'turn-delete' },
    });
    if (!target.ok) throw new Error('target resolution failed');

    await expect(test.documents.readDocument({
      document: target.target.document.id,
      lens: target.target.lens,
    })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        state: 'text',
        current: { content: 'const value = 1;\n' },
        comparison: { change: { kind: 'deleted' } },
      },
    });
  });
});
