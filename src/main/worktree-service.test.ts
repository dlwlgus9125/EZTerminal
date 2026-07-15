import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { GitRunner, parseWorktreePorcelain, WorktreeService } from './worktree-service';
import { SessionWorktreeGuard } from './session-worktree-guard';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function makeRepo(): { base: string; repo: string; userData: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'ezterm-worktree-'));
  const repo = path.join(base, 'source repo');
  const userData = path.join(base, 'user-data');
  mkdirSync(repo);
  mkdirSync(userData);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'EZTerminal Tests']);
  writeFileSync(path.join(repo, 'README.md'), 'initial\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return { base, repo, userData };
}

function fixedIds(): () => string {
  let n = 0;
  return () => `worktree-${String(++n).padStart(8, '0')}`;
}

describe('parseWorktreePorcelain', () => {
  it('parses NUL-delimited paths, branches, locks, and detached records without shell quoting', () => {
    const output = [
      'worktree C:/repo with space',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree C:/outside/wt',
      'HEAD def456',
      'detached',
      'locked maintenance',
      '',
      '',
    ].join('\0');
    expect(parseWorktreePorcelain(output)).toEqual([
      {
        path: 'C:/repo with space',
        head: 'abc123',
        branch: 'main',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: 'C:/outside/wt',
        head: 'def456',
        branch: '',
        bare: false,
        detached: true,
        locked: true,
        prunable: false,
      },
    ]);
  });
});

describe('GitRunner', () => {
  it('uses execFile argv with shell:false, a timeout, bounded output, and disabled prompts', async () => {
    const executeMock = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(null, 'ok', '');
      return {} as ChildProcess;
    });
    const runner = new GitRunner(executeMock as unknown as typeof execFile);
    await expect(runner.run('C:\\repo', ['status', '--porcelain=v1', '-z'])).resolves.toBe('ok');

    const [file, args, options] = executeMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
    ];
    expect(file).toBe('git');
    expect(args).toEqual(['status', '--porcelain=v1', '-z']);
    expect(options.shell).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('WorktreeService — real Git boundaries', () => {
  it('creates under the external safe root, lists, opens, and removes without force', async () => {
    const { repo, userData } = makeRepo();
    const calls: string[][] = [];
    class RecordingRunner extends GitRunner {
      override async run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
        calls.push([...args]);
        return super.run(cwd, args, signal);
      }
    }
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds(), gitRunner: new RecordingRunner() });
    await service.init();

    const created = await service.execute({ action: 'create', cwd: repo, branch: 'feature/one' }, 'desktop');
    expect(created.ok).toBe(true);
    if (!created.ok || !created.opened) throw new Error('create failed');
    expect(created.opened.managed).toBe(true);
    expect(created.opened.main).toBe(false);
    expect(path.relative(repo, created.opened.path).startsWith('..')).toBe(true);
    expect(created.opened.path).toContain(`${path.sep}.ezterminal-worktrees${path.sep}`);
    expect(existsSync(created.opened.path)).toBe(true);

    const listed = await service.execute({ action: 'list', cwd: created.opened.path }, 'desktop');
    expect(listed.ok && listed.worktrees.some((item) => item.worktreeId === created.opened!.worktreeId)).toBe(true);

    const opened = await service.execute({ action: 'open', cwd: repo, worktreeId: created.opened.worktreeId }, 'desktop');
    expect(opened.ok && opened.opened?.path).toBe(created.opened.path);

    const removed = await service.execute({ action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId }, 'desktop');
    expect(removed.ok).toBe(true);
    expect(existsSync(created.opened.path)).toBe(false);
    const removeCall = calls.find((args) => args[0] === 'worktree' && args[1] === 'remove');
    expect(removeCall).toEqual(['worktree', 'remove', created.opened.path]);
    expect(calls.flat()).not.toContain('--force');
  }, 30_000);

  it('rejects dirty and in-use managed worktrees with stable errors', async () => {
    const { repo, userData } = makeRepo();
    let sessionCwds: string[] = [];
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds(), getSessionCwds: () => sessionCwds });
    const created = await service.execute({ action: 'create', cwd: repo, branch: 'feature-dirty' }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('create failed');

    writeFileSync(path.join(created.opened.path, 'untracked.txt'), 'dirty', 'utf8');
    const dirty = await service.execute({ action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId }, 'desktop');
    expect(dirty).toMatchObject({ ok: false, error: 'WORKTREE_DIRTY' });
    expect(existsSync(created.opened.path)).toBe(true);

    rmSync(path.join(created.opened.path, 'untracked.txt'));
    sessionCwds = [path.join(created.opened.path, 'nested', 'cwd')];
    const inUse = await service.execute({ action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId }, 'desktop');
    expect(inUse).toMatchObject({ ok: false, error: 'WORKTREE_IN_USE' });
    expect(existsSync(created.opened.path)).toBe(true);
  }, 30_000);

  it('exempts only the exact initiating remove run from the active-run gate', async () => {
    const { repo, userData } = makeRepo();
    const runGuard = new SessionWorktreeGuard();
    const service = new WorktreeService({
      userDataDir: userData,
      newId: fixedIds(),
      runGuard,
    });
    const created = await service.execute(
      { action: 'create', cwd: repo, branch: 'feature-active-gate' },
      'desktop',
    );
    if (!created.ok || !created.opened) throw new Error('create failed');
    const initiatingRun = { sessionId: 'session-remove', runId: 'run-remove' };
    expect(runGuard.tryBeginRun(initiatingRun)).toBe(true);
    expect(runGuard.tryBeginRun({ sessionId: 'session-other', runId: 'run-other' })).toBe(true);

    const blocked = await service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
      undefined,
      initiatingRun,
    );
    expect(blocked).toMatchObject({ ok: false, error: 'WORKTREE_IN_USE' });
    expect(existsSync(created.opened.path)).toBe(true);

    runGuard.finishRun({ sessionId: 'session-other', runId: 'run-other' });
    const removed = await service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
      undefined,
      initiatingRun,
    );
    expect(removed).toMatchObject({ ok: true, action: 'remove' });
    expect(existsSync(created.opened.path)).toBe(false);
  }, 30_000);

  it('rechecks session usage at the final destructive boundary', async () => {
    const { repo, userData } = makeRepo();
    let targetPath = '';
    let checks = 0;
    const service = new WorktreeService({
      userDataDir: userData,
      newId: fixedIds(),
      getSessionCwds: () => {
        checks += 1;
        return checks >= 2 && targetPath ? [path.join(targetPath, 'new-session')] : [];
      },
    });
    const created = await service.execute({ action: 'create', cwd: repo, branch: 'feature-race' }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('create failed');
    targetPath = created.opened.path;
    checks = 0;

    const result = await service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId },
      'desktop',
    );
    expect(result).toMatchObject({ ok: false, error: 'WORKTREE_IN_USE' });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(existsSync(targetPath)).toBe(true);
  }, 30_000);

  it('does not retain in-memory ownership when registry persistence fails', async () => {
    const { repo, userData } = makeRepo();
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds() });
    await service.init();
    const registry = (service as unknown as {
      registry: { save(entries: readonly unknown[]): Promise<void> };
    }).registry;
    registry.save = async () => { throw new Error('disk full'); };

    const created = await service.execute(
      { action: 'create', cwd: repo, branch: 'registry-failure' },
      'desktop',
    );
    expect(created).toMatchObject({ ok: false, error: 'REGISTRY_WRITE_FAILED' });
    if (created.ok || !created.worktree) throw new Error('expected unmanaged created worktree');

    const listed = await service.execute({ action: 'list', cwd: repo }, 'desktop');
    if (!listed.ok) throw new Error('list failed');
    const unmanaged = listed.worktrees.find(
      (item) => path.normalize(item.path) === path.normalize(created.worktree!.path),
    );
    expect(unmanaged?.managed).toBe(false);
    const remove = await service.execute(
      { action: 'remove', cwd: repo, worktreeId: created.worktree.worktreeId },
      'desktop',
    );
    expect(remove).toMatchObject({ ok: false, error: 'WORKTREE_UNMANAGED' });
  }, 30_000);

  it('rejects locked and Git-registered but unmanaged worktrees', async () => {
    const { base, repo, userData } = makeRepo();
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds() });
    const created = await service.execute({ action: 'create', cwd: repo, branch: 'feature-locked' }, 'desktop');
    if (!created.ok || !created.opened) throw new Error('create failed');
    git(repo, ['worktree', 'lock', created.opened.path]);
    const locked = await service.execute({ action: 'remove', cwd: repo, worktreeId: created.opened.worktreeId }, 'desktop');
    expect(locked).toMatchObject({ ok: false, error: 'WORKTREE_LOCKED' });

    const externalPath = path.join(base, 'manual worktree');
    git(repo, ['worktree', 'add', '-b', 'manual-branch', externalPath]);
    const listed = await service.execute({ action: 'list', cwd: repo }, 'desktop');
    if (!listed.ok) throw new Error('list failed');
    const canonicalExternalPath = realpathSync(externalPath);
    const unmanaged = listed.worktrees.find(
      (item) => path.normalize(item.path) === path.normalize(canonicalExternalPath),
    );
    expect(unmanaged).toMatchObject({ managed: false, main: false });
    const rejected = await service.execute({ action: 'remove', cwd: repo, worktreeId: unmanaged!.worktreeId }, 'desktop');
    expect(rejected).toMatchObject({ ok: false, error: 'WORKTREE_UNMANAGED' });
    expect(existsSync(externalPath)).toBe(true);
  }, 30_000);

  it('rejects roots inside a registered worktree and dirty bases unless explicitly acknowledged', async () => {
    const { repo, userData } = makeRepo();
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds() });
    const unsafe = await service.execute(
      { action: 'create', cwd: repo, branch: 'unsafe-root', root: path.join(repo, 'nested') },
      'desktop',
    );
    expect(unsafe).toMatchObject({ ok: false, error: 'UNSAFE_ROOT' });

    writeFileSync(path.join(repo, 'README.md'), 'changed\n', 'utf8');
    const dirty = await service.execute({ action: 'create', cwd: repo, branch: 'dirty-base' }, 'desktop');
    expect(dirty).toMatchObject({ ok: false, error: 'BASE_DIRTY' });
    const allowed = await service.execute(
      { action: 'create', cwd: repo, branch: 'dirty-base', allowDirtyBase: true },
      'desktop',
    );
    expect(allowed.ok).toBe(true);
  }, 30_000);

  it('enforces mobile list/open read-only at the service boundary', async () => {
    const { repo, userData } = makeRepo();
    const service = new WorktreeService({ userDataDir: userData, newId: fixedIds() });
    await expect(service.execute({ action: 'list', cwd: repo }, 'mobile')).resolves.toMatchObject({ ok: true });
    await expect(service.execute({ action: 'create', cwd: repo, branch: 'mobile-no' }, 'mobile')).resolves.toMatchObject({
      ok: false,
      error: 'MOBILE_READ_ONLY',
    });
    await expect(service.execute({ action: 'remove', cwd: repo, worktreeId: 'anything' }, 'mobile')).resolves.toMatchObject({
      ok: false,
      error: 'MOBILE_READ_ONLY',
    });
  }, 30_000);
});
