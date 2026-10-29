import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSafeRef, resolveMergeBase } from './git-ref-safety';
import { GitStatusService } from './git-status-service';
import { WorkspaceWorktreeService } from './workspace-worktree-service';

// Real repositories cross the Git/Windows process boundary; give each case room.
const REAL_GIT_TEST_TIMEOUT_MS = 60_000;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

function write(root: string, file: string, text: string): void {
  const target = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** `main` with one commit: src/cart.ts and src/format.ts. */
function repository(): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ezterminal-review-diff-')));
  directories.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'src/cart.ts', 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
  write(root, 'src/format.ts', 'export function price(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function sectionPaths(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('diff --git ')).map((line) => line.replace(/^diff --git a\/(.+?) b\/.+$/u, '$1'));
}

describe('GitStatusService.getReviewDiff', () => {
  it('reads uncommitted changes as one plain diff: staged, unstaged and untracked files, each once', async () => {
    const root = repository();
    write(root, 'src/cart.ts', 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 1);\n}\n');
    git(root, 'add', 'src/cart.ts');
    write(root, 'src/cart.ts', 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 2);\n}\n');
    write(root, 'src/format.ts', 'export function price(cents: number): string {\n  return `$${(cents / 10).toFixed(2)}`;\n}\n');
    write(root, 'src/discount.ts', 'export const off = (total: number, percent: number) => total - total * percent;\n');

    const result = await new GitStatusService().getReviewDiff(root, { kind: 'uncommitted' });
    if (!result.ok) throw new Error(result.error);
    expect(sectionPaths(result.text).sort()).toEqual(['src/cart.ts', 'src/discount.ts', 'src/format.ts']);
    // Staged and unstaged changes land in one section against HEAD, as the working tree is now.
    expect(result.text).toContain('+  return items.reduce((a, b) => a + b, 2);');
    expect(result.text).not.toContain('a + b, 1);');
    // Git's own style: no headings between files, untracked paths quoted only when Git would.
    expect(result.text).not.toContain('## ');
    expect(result.text).toContain('diff --git a/src/discount.ts b/src/discount.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/discount.ts\n@@ -0,0 +1,1 @@');
    expect(result).toMatchObject({ truncated: false, omissions: [] });
    expect(result.mergeBase).toBeUndefined();
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('answers paths relative to a working folder inside the repository and leaves the rest out', async () => {
    const root = repository();
    write(root, 'src/format.ts', 'export const changed = true;\n');
    write(root, 'README.md', 'outside the folder\n');
    write(root, 'src/new/helper.ts', 'export const helper = 1;\n');
    const result = await new GitStatusService().getReviewDiff(path.join(root, 'src'), { kind: 'uncommitted' });
    if (!result.ok) throw new Error(result.error);
    expect(sectionPaths(result.text).sort()).toEqual(['format.ts', 'new/helper.ts']);
    expect(result.text).not.toContain('README.md');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('reads a branch since it left its base: its commits, uncommitted and untracked files, not the base’s own later commits', async () => {
    const root = repository();
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'src/cart.ts', 'export function total(items: number[]): number {\n  return 0;\n}\n');
    git(root, 'commit', '-qam', 'feature work');
    git(root, 'checkout', '-q', 'main');
    write(root, 'src/base-only.ts', 'export const later = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'main moved on');
    git(root, 'checkout', '-q', 'feature');
    write(root, 'src/format.ts', 'export const uncommitted = true;\n');
    write(root, 'src/discount.ts', 'export const untracked = true;\n');
    const mainAtFork = git(root, 'merge-base', 'main', 'feature').trim();
    expect(mainAtFork).not.toBe(git(root, 'rev-parse', 'main').trim());

    const result = await new GitStatusService().getReviewDiff(root, { kind: 'base-branch', baseRef: 'main' });
    if (!result.ok) throw new Error(result.error);
    expect(sectionPaths(result.text).sort()).toEqual(['src/cart.ts', 'src/discount.ts', 'src/format.ts']);
    expect(result).toMatchObject({ baseRef: 'main', mergeBase: mainAtFork, ahead: 1, truncated: false });
    expect(result.text).not.toContain('base-only');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('refuses a base that is not a plain local branch, without running it', async () => {
    const root = repository();
    git(root, 'checkout', '-q', '-b', 'feature');
    const service = new GitStatusService();
    for (const baseRef of ['--output=pwned.txt', 'main..HEAD', 'HEAD~1', 'main^{tree}', 'no-such-branch', 'refs/heads/../../x']) {
      expect(await service.getReviewDiff(root, { kind: 'base-branch', baseRef }), baseRef).toEqual({ ok: false, error: 'no-base' });
    }
    expect(existsSync(path.join(root, 'pwned.txt'))).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('keeps whole files under the budget and names the ones left out', async () => {
    const root = repository();
    write(root, 'src/huge.ts', `${Array.from({ length: 9_000 }, (_, index) => `export const value${String(index)} = ${String(index)};`).join('\n')}\n`);
    git(root, 'add', 'src/huge.ts');
    git(root, 'commit', '-qm', 'huge');
    write(root, 'src/huge.ts', `${Array.from({ length: 9_000 }, (_, index) => `export const value${String(index)} = ${String(index + 1)};`).join('\n')}\n`);
    write(root, 'src/format.ts', 'export const small = true;\n');
    const result = await new GitStatusService().getReviewDiff(root, { kind: 'uncommitted' });
    if (!result.ok) throw new Error(result.error);
    expect(result.text.length).toBeLessThanOrEqual(200_000);
    expect(sectionPaths(result.text)).toEqual(['src/format.ts']);
    expect(result.omissions).toEqual([{ path: 'src/huge.ts', reason: 'budget-exhausted' }]);
    expect(result.truncated).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('reads a repository with no commit yet, and says a base branch cannot be compared there', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ezterminal-review-unborn-')));
    directories.push(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, 'staged.ts', 'export const staged = 1;\n');
    git(root, 'add', 'staged.ts');
    write(root, 'loose.ts', 'export const loose = 1;\n');
    const service = new GitStatusService();
    const result = await service.getReviewDiff(root, { kind: 'uncommitted' });
    if (!result.ok) throw new Error(result.error);
    expect(sectionPaths(result.text).sort()).toEqual(['loose.ts', 'staged.ts']);
    expect(await service.getReviewDiff(root, { kind: 'base-branch', baseRef: 'main' })).toEqual({ ok: false, error: 'no-base' });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('tells a folder that is not a repository from an empty change', async () => {
    const folder = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ezterminal-review-plain-')));
    directories.push(folder);
    const service = new GitStatusService();
    expect(await service.getReviewDiff(folder, { kind: 'uncommitted' })).toEqual({ ok: false, error: 'not-a-repository' });
    expect(await service.getReviewDiff(path.join(folder, 'missing'), { kind: 'uncommitted' })).toEqual({ ok: false, error: 'invalid-path' });
    expect(await service.getReviewDiff(repository(), { kind: 'uncommitted' })).toEqual({ ok: true, text: '', truncated: false, omissions: [] });
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('GitStatusService.fingerprint', () => {
  it('changes with any edit, also to a file that was already modified, and stays put otherwise', async () => {
    const root = repository();
    const service = new GitStatusService();
    write(root, 'src/cart.ts', 'export const a = 1;\n');
    const first = await service.fingerprint(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(await service.fingerprint(root)).toBe(first);
    write(root, 'src/cart.ts', 'export const a = 2;\n');
    const second = await service.fingerprint(root);
    expect(second).not.toBe(first);
    write(root, 'notes.txt', 'new\n');
    expect(await service.fingerprint(root)).not.toBe(second);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('git ref safety', () => {
  it('accepts plain branch names only', () => {
    expect(['main', 'feature/login', 'release-2.0', 'a_b.c'].every(isSafeRef)).toBe(true);
    expect(['', '-x', '--output=x', 'a..b', 'a b', 'main^', 'main~1', 'main:file', 'a\0b', 'x'.repeat(201)].some(isSafeRef)).toBe(false);
  });

  it('resolves the merge base under refs/heads only', async () => {
    const root = repository();
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'src/cart.ts', 'changed\n');
    git(root, 'commit', '-qam', 'feature');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const run = async (args: readonly string[]): Promise<string> => git(root, ...args);
    const resolved = await resolveMergeBase(run, 'main', head);
    expect(resolved.base).toBe(git(root, 'rev-parse', 'main').trim());
    expect(resolved.mergeBase).toBe(resolved.base);
    await expect(resolveMergeBase(run, 'main..feature', head)).rejects.toThrow();
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('WorkspaceWorktreeService.baseBranch', () => {
  it('is the branch the main checkout has out, and nothing when it is detached', async () => {
    const root = repository();
    const tree = `${root}-tree`;
    directories.push(tree);
    git(root, 'worktree', 'add', '-q', '-b', 'feature/login', tree);
    const service = new WorkspaceWorktreeService();
    expect(await service.baseBranch({ mainRoot: root })).toBe('main');
    git(root, 'checkout', '-q', '--detach');
    expect(await service.baseBranch({ mainRoot: root })).toBeUndefined();
    // The worktree diff compares with whatever base the caller resolved.
    git(root, 'checkout', '-q', 'main');
    write(tree, 'src/cart.ts', 'in the worktree\n');
    const diff = await new GitStatusService().getReviewDiff(tree, { kind: 'base-branch', baseRef: 'main' });
    expect(diff).toMatchObject({ ok: true, baseRef: 'main', ahead: 0 });
    if (diff.ok) expect(sectionPaths(diff.text)).toEqual(['src/cart.ts']);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
