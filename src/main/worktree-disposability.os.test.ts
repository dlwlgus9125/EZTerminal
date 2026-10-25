import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { judgeDisposable } from './worktree-disposability';
import { GitRunner } from './worktree-service';

const bases = new Set<string>();
afterEach(async () => {
  for (const base of bases) await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  bases.clear();
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** A repository with an attempt worktree at the base, and its captured result (staged, kept by a ref), like a run leaves it. */
function attempt(options: { capture?: boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'ez-dispose-'));
  bases.add(base);
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'EZTerminal Tests']);
  writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const folder = path.join(base, 'attempt');
  git(repo, ['worktree', 'add', '-b', 'ezterminal/attempt-1', folder, baseCommit]);
  let result: string | undefined;
  if (options.capture) {
    writeFileSync(path.join(folder, 'README.md'), 'updated\n');
    git(folder, ['add', '-A']);
    const tree = git(folder, ['write-tree']).trim();
    result = git(folder, ['-c', 'user.name=EZTerminal', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', baseCommit, '-m', 'result']).trim();
    git(folder, ['update-ref', 'refs/ezterminal/results/1', result]);
  }
  const expected = { head: baseCommit, tree: result ?? baseCommit };
  return { repo, folder, baseCommit, result, expected };
}
const runner = new GitRunner();
const judge = (folder: string, expected: Parameters<typeof judgeDisposable>[2]) => judgeDisposable(runner, folder, expected);

describe('judgeDisposable (real Git)', () => {
  it('lets a run’s own folder go: untouched, or holding exactly its captured result', async () => {
    const plain = attempt();
    expect(await judge(plain.folder, plain.expected)).toEqual({ disposable: true });
    const captured = attempt({ capture: true });
    expect(await judge(captured.folder, captured.expected)).toEqual({ disposable: true });
    // A cleanup that stopped after detaching to the result is still the same folder.
    git(captured.folder, ['checkout', '--detach', '--no-overwrite-ignore', '--no-recurse-submodules', captured.result!]);
    expect(await judge(captured.folder, { ...captured.expected, detachedAt: captured.result })).toEqual({ disposable: true });
  });

  it('keeps a folder with any file Git does not keep, ignored ones included', async () => {
    const ignored = attempt({ capture: true });
    writeFileSync(path.join(ignored.folder, '.gitignore'), '*.env\n');
    git(ignored.folder, ['add', '.gitignore']);
    // Re-stage is a change from the result: use an exclude file instead so the index still equals the result.
    git(ignored.folder, ['rm', '--cached', '-q', '.gitignore']);
    await fs.rm(path.join(ignored.folder, '.gitignore'));
    writeFileSync(path.join(git(ignored.folder, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim()), '*.env\n');
    writeFileSync(path.join(ignored.folder, 'secrets.env'), 'TOKEN=1\n');
    expect(await judge(ignored.folder, ignored.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('untracked or ignored') });
    const untracked = attempt();
    writeFileSync(path.join(untracked.folder, 'notes.txt'), 'mine\n');
    expect(await judge(untracked.folder, untracked.expected)).toMatchObject({ disposable: false });
  });

  it('keeps a folder whose files or index differ from what the run left', async () => {
    const edited = attempt({ capture: true });
    writeFileSync(path.join(edited.folder, 'README.md'), 'edited after the result\n');
    expect(await judge(edited.folder, edited.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('not added') });
    const restaged = attempt({ capture: true });
    writeFileSync(path.join(restaged.folder, 'README.md'), 'staged later\n');
    git(restaged.folder, ['add', 'README.md']);
    expect(await judge(restaged.folder, restaged.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('staged') });
    const moved = attempt();
    git(moved.folder, ['commit', '--allow-empty', '-m', 'a person’s commit']);
    expect(await judge(moved.folder, moved.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('HEAD') });
  });

  it('keeps a folder Git would not fully check, or with Git work in progress', async () => {
    const assumed = attempt();
    git(assumed.folder, ['update-index', '--assume-unchanged', 'README.md']);
    expect(await judge(assumed.folder, assumed.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('does not check') });
    const skipped = attempt();
    git(skipped.folder, ['update-index', '--skip-worktree', 'README.md']);
    expect(await judge(skipped.folder, skipped.expected)).toMatchObject({ disposable: false });
    const merging = attempt();
    writeFileSync(git(merging.folder, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']).trim(), `${merging.baseCommit}\n`);
    expect(await judge(merging.folder, merging.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('MERGE_HEAD') });
    const sparse = attempt();
    git(sparse.folder, ['config', 'core.sparseCheckout', 'true']);
    expect(await judge(sparse.folder, sparse.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('sparse') });
  });

  it('keeps a folder with a submodule or Git LFS', async () => {
    const submodule = attempt();
    git(submodule.folder, ['update-index', '--add', '--cacheinfo', `160000,${submodule.baseCommit},vendor`]);
    expect(await judge(submodule.folder, { ...submodule.expected, tree: git(submodule.folder, ['write-tree']).trim() })).toMatchObject({ disposable: false, reason: expect.stringContaining('submodule') });
    const lfs = attempt({ capture: true });
    writeFileSync(path.join(lfs.folder, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    git(lfs.folder, ['add', '.gitattributes']);
    const tree = git(lfs.folder, ['write-tree']).trim();
    const result = git(lfs.folder, ['-c', 'user.name=E', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', lfs.baseCommit, '-m', 'result']).trim();
    expect(await judge(lfs.folder, { ...lfs.expected, tree: result })).toMatchObject({ disposable: false, reason: expect.stringContaining('LFS') });
  });

  it('keeps a folder once its kept result ref no longer names the result (Codex I2-7c P1-4)', async () => {
    const captured = attempt({ capture: true });
    const keptRef = { name: 'refs/ezterminal/results/1', commit: captured.result! };
    expect(await judge(captured.folder, { ...captured.expected, keptRef })).toEqual({ disposable: true });
    git(captured.folder, ['update-ref', 'refs/ezterminal/results/1', captured.baseCommit]);
    expect(await judge(captured.folder, { ...captured.expected, keptRef })).toMatchObject({ disposable: false, code: 'result-mismatch' });
    git(captured.folder, ['update-ref', '-d', 'refs/ezterminal/results/1']);
    expect(await judge(captured.folder, { ...captured.expected, keptRef })).toMatchObject({ disposable: false, code: 'result-mismatch' });
  });

  it('keeps a folder holding a repository of its own inside a tracked folder (Codex I2-7c P1-1)', async () => {
    const nested = attempt({ capture: true });
    mkdirSync(path.join(nested.folder, 'lib'));
    writeFileSync(path.join(nested.folder, 'lib', 'a.txt'), 'tracked\n');
    git(nested.folder, ['add', '-A']);
    const tree = git(nested.folder, ['write-tree']).trim();
    const result = git(nested.folder, ['-c', 'user.name=E', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', nested.baseCommit, '-m', 'result']).trim();
    expect(await judge(nested.folder, { ...nested.expected, tree: result })).toEqual({ disposable: true });
    // A person makes the tracked folder a repository with its own history: Git does not list its .git at all.
    git(path.join(nested.folder, 'lib'), ['init', '-q']);
    expect(await judge(nested.folder, { ...nested.expected, tree: result })).toMatchObject({ disposable: false, code: 'nested-repository' });
  });

  it('keeps a folder whose files Git LFS handles by the person’s own or the system attributes (Codex I2-7c P1-3)', async () => {
    const lfs = attempt({ capture: true });
    writeFileSync(path.join(lfs.folder, 'data.bin'), 'binary-ish\n');
    git(lfs.folder, ['add', '-A']);
    const tree = git(lfs.folder, ['write-tree']).trim();
    const result = git(lfs.folder, ['-c', 'user.name=E', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', lfs.baseCommit, '-m', 'result']).trim();
    expect(await judge(lfs.folder, { ...lfs.expected, tree: result })).toEqual({ disposable: true });
    const config = mkdtempSync(path.join(tmpdir(), 'ez-dispose-xdg-'));
    bases.add(config);
    mkdirSync(path.join(config, 'git'));
    writeFileSync(path.join(config, 'git', 'attributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      expect(await judge(lfs.folder, { ...lfs.expected, tree: result })).toMatchObject({ disposable: false, code: 'lfs' });
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    }
    const storage = attempt();
    git(storage.folder, ['config', 'lfs.storage', path.join(storage.folder, '.lfs-objects')]);
    expect(await judge(storage.folder, storage.expected)).toMatchObject({ disposable: false, code: 'lfs' });
  });

  it('keeps a folder it cannot check', async () => {
    const gone = attempt();
    expect(await judge(path.join(gone.folder, 'missing'), gone.expected)).toMatchObject({ disposable: false, reason: expect.stringContaining('could not be checked') });
  });
});
