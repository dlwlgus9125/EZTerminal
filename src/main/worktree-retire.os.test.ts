import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitRunner, WorktreeService } from './worktree-service';

const bases = new Set<string>();
afterEach(async () => {
  for (const base of bases) await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  bases.clear();
});
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** A repository and an EZTerminal worktree holding a captured run result (staged, kept by a ref), as an attempt leaves it. */
async function capturedAttempt(options: { sessionCwds?: () => string[]; runner?: GitRunner } = {}) {
  // The long form: Git lists worktrees by it, and a CI runner's TEMP is an 8.3 alias (RUNNER~1).
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ez-retire-')));
  bases.add(base);
  const repo = path.join(base, 'repo');
  const userData = path.join(base, 'user-data');
  mkdirSync(repo); mkdirSync(userData);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'EZTerminal Tests']);
  writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  let n = 0;
  const service = new WorktreeService({ userDataDir: userData, newId: () => `worktree-${String(++n).padStart(8, '0')}`, getSessionCwds: options.sessionCwds ?? (() => []), ...(options.runner ? { gitRunner: options.runner } : {}) });
  await service.init();
  const created = await service.execute({ action: 'create', cwd: repo, branch: 'ezterminal/attempt-1' }, 'desktop');
  if (!created.ok || !created.opened) throw new Error('create failed');
  const folder = created.opened.path;
  const baseCommit = git(folder, ['rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(folder, 'README.md'), 'updated\n');
  git(folder, ['add', '-A']);
  const tree = git(folder, ['write-tree']).trim();
  const result = git(folder, ['-c', 'user.name=EZTerminal', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', baseCommit, '-m', 'result']).trim();
  git(folder, ['update-ref', 'refs/ezterminal/results/1', result]);
  const expected = { head: baseCommit, tree: result, detachedAt: result, detachTo: result };
  return { service, repo, folder, worktreeId: created.opened.worktreeId, baseCommit, result, expected };
}

describe('WorktreeService.retire (real Git)', () => {
  it('removes a run’s own folder without force: detached to its result, the branch left where it was', async () => {
    const calls: string[][] = [];
    class Recording extends GitRunner {
      override async run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> { calls.push([...args]); return super.run(cwd, args, signal); }
    }
    const run = await capturedAttempt({ runner: new Recording() });
    expect(await run.service.retire(run.repo, run.worktreeId, run.expected)).toEqual({ ok: true });
    expect(existsSync(run.folder)).toBe(false);
    expect(calls.flat()).not.toContain('--force');
    // The result is still reachable, and the attempt branch still points at the base.
    expect(git(run.repo, ['rev-parse', 'refs/ezterminal/results/1']).trim()).toBe(run.result);
    expect(git(run.repo, ['rev-parse', 'refs/heads/ezterminal/attempt-1']).trim()).toBe(run.baseCommit);
    const listed = await run.service.execute({ action: 'list', cwd: run.repo }, 'desktop');
    expect(listed.ok && listed.worktrees.some((item) => item.worktreeId === run.worktreeId)).toBe(false);
  }, 60_000);

  it('keeps a folder holding anything Git does not keep, and says why', async () => {
    const run = await capturedAttempt();
    writeFileSync(path.join(git(run.folder, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim()), '*.env\n');
    writeFileSync(path.join(run.folder, 'secrets.env'), 'TOKEN=1\n');
    expect(await run.service.retire(run.repo, run.worktreeId, run.expected)).toMatchObject({ ok: false, kept: true, reason: expect.stringContaining('ignored') });
    expect(await fs.readFile(path.join(run.folder, 'secrets.env'), 'utf8')).toBe('TOKEN=1\n');
    // Nothing was changed: still on its branch at the base.
    expect(git(run.folder, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('ezterminal/attempt-1');
  }, 60_000);

  it('refuses while a session works there, and leaves the folder as it was', async () => {
    let cwds: string[] = [];
    const run = await capturedAttempt({ sessionCwds: () => cwds });
    cwds = [path.join(run.folder, 'src')];
    expect(await run.service.retire(run.repo, run.worktreeId, run.expected)).toMatchObject({ ok: false, kept: false, code: 'WORKTREE_IN_USE' });
    expect(existsSync(run.folder)).toBe(true);
    cwds = [];
    expect(await run.service.retire(run.repo, run.worktreeId, run.expected)).toEqual({ ok: true });
  }, 60_000);

  it('finishes a cleanup that stopped after detaching', async () => {
    const run = await capturedAttempt();
    git(run.folder, ['checkout', '--quiet', '--detach', '--no-overwrite-ignore', '--no-recurse-submodules', run.result]);
    expect(await run.service.retire(run.repo, run.worktreeId, run.expected)).toEqual({ ok: true });
    expect(existsSync(run.folder)).toBe(false);
  }, 60_000);

  it('never touches a worktree EZTerminal did not create', async () => {
    const run = await capturedAttempt();
    const outside = path.join(path.dirname(run.repo), 'mine');
    git(run.repo, ['worktree', 'add', '-q', outside, run.baseCommit]);
    const listed = await run.service.execute({ action: 'list', cwd: run.repo }, 'desktop');
    const foreign = listed.ok ? listed.worktrees.find((item) => path.resolve(item.path) === path.resolve(outside)) : undefined;
    expect(foreign?.managed).toBe(false);
    expect(await run.service.retire(run.repo, foreign!.worktreeId, { head: run.baseCommit, tree: run.baseCommit })).toMatchObject({ ok: false, kept: false, code: 'WORKTREE_UNMANAGED' });
    expect(existsSync(outside)).toBe(true);
  }, 60_000);
});
