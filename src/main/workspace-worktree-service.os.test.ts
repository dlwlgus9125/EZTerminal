import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceWorktreeService } from './workspace-worktree-service';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

function repository(): { readonly main: string; readonly tree: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ezterminal-worktree-'));
  directories.push(root);
  const main = path.join(root, 'main');
  const tree = path.join(root, 'feature');
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  for (const key of ['user.name', 'user.email']) git(main, 'config', key, key === 'user.name' ? 'test' : 'test@example.invalid');
  writeFileSync(path.join(main, 'app.ts'), 'export const a = 1;\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/login', tree);
  return { main, tree };
}

describe('WorkspaceWorktreeService', () => {
  it('reads a fresh worktree as nothing yet, changes as review, and a merged branch as done', async () => {
    const { main, tree } = repository();
    const service = new WorkspaceWorktreeService();
    const target = { workspaceId: 'w', rootPath: tree, mainRoot: main };
    expect(await service.status(target)).toMatchObject({ branch: 'feature/login', baseBranch: 'main', dirty: false, ahead: 0, merged: false });
    expect((await service.status(target)).status).toBeUndefined();

    writeFileSync(path.join(tree, 'app.ts'), 'export const a = 2;\n');
    expect(await service.status(target)).toMatchObject({ dirty: true, status: 'review' });

    const committed = await service.commit(target, 'Change a');
    expect(committed.ok).toBe(true);
    expect(await service.status(target)).toMatchObject({ dirty: false, ahead: 1, status: 'review' });

    const merged = await service.merge(target);
    expect(merged).toMatchObject({ ok: true, value: { into: 'main' } });
    expect(await service.status(target)).toMatchObject({ ahead: 0, merged: true, status: 'done' });
    expect(git(main, 'show', 'HEAD:app.ts')).toBe('export const a = 2;\n');
  });

  it('refuses to merge uncommitted work or into a dirty main checkout', async () => {
    const { main, tree } = repository();
    const service = new WorkspaceWorktreeService();
    const target = { workspaceId: 'w', rootPath: tree, mainRoot: main };
    writeFileSync(path.join(tree, 'app.ts'), 'export const a = 2;\n');
    expect(await service.merge(target)).toMatchObject({ ok: false, reason: 'dirty-worktree' });
    await service.commit(target, 'Change a');
    writeFileSync(path.join(main, 'app.ts'), 'export const a = 3;\n');
    expect(await service.merge(target)).toMatchObject({ ok: false, reason: 'dirty-main' });
  });

  it('aborts a conflicting merge and leaves the main checkout as it was', async () => {
    const { main, tree } = repository();
    const service = new WorkspaceWorktreeService();
    const target = { workspaceId: 'w', rootPath: tree, mainRoot: main };
    writeFileSync(path.join(tree, 'app.ts'), 'export const a = 2;\n');
    await service.commit(target, 'Change a in feature');
    writeFileSync(path.join(main, 'app.ts'), 'export const a = 3;\n');
    git(main, 'commit', '-qam', 'Change a in main');
    const before = git(main, 'rev-parse', 'HEAD');
    expect(await service.merge(target)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(main, 'status', '--porcelain').trim()).toBe('');
  });
});
