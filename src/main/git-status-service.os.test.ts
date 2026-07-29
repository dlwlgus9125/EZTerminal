import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  promises as fs,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { GitStatusService } from './git-status-service';
import { GitCommandError, GitRunner, type ExecFileLike } from './worktree-service';

type Responder = (args: readonly string[]) => string | Error;

const GIT_COMMANDS = new Set(['config', 'rev-parse', 'status', 'diff', 'ls-files']);
const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function logicalArgs(args: readonly string[]): string[] {
  const index = args.findIndex((arg) => GIT_COMMANDS.has(arg));
  return index >= 0 ? [...args.slice(index)] : [...args];
}

function makeService(respond: Responder, now: () => number = () => 0): {
  service: GitStatusService;
  directory: string;
  calls: string[][];
} {
  const calls: string[][] = [];
  const execute = ((
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const logical = logicalArgs(args);
    calls.push(logical);
    const result = respond(logical);
    if (result instanceof Error) callback(result, '', result.message);
    else callback(null, result, '');
  }) as unknown as ExecFileLike;
  return {
    calls,
    directory: makeTemporaryDirectory('ez-git-status-'),
    service: new GitStatusService(new GitRunner(execute), now),
  };
}

const NOT_A_REPO = new Error('fatal: not a git repository (or any parent)');
// The real-repository cases intentionally cross the Git/Windows process boundary.
// A successful getDiff can traverse four 10s command-timeout stages (two
// sequential probes and two gated waves), so the harness must outlive that
// complete pipeline. Vitest must never abandon a still-running child and race
// afterEach cleanup.
const REAL_GIT_TEST_TIMEOUT_MS = 60_000;

function makeRealRepository(): string {
  const directory = makeTemporaryDirectory('ez-git-status-real-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  return directory;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`;
}

function configureMarkerFilter(
  directory: string,
  kind: 'clean' | 'process',
): { marker: string; tracked: string } {
  const tracked = path.join(directory, 'tracked.txt');
  const attributes = path.join(directory, '.gitattributes');
  writeFileSync(tracked, 'base\n', 'utf8');
  writeFileSync(attributes, '*.txt filter=ezterminal-marker\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt', '.gitattributes'], { cwd: directory });
  execFileSync(
    'git',
    ['-c', 'user.name=EZTerminal Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'],
    { cwd: directory, stdio: 'ignore' },
  );

  const marker = path.join(directory, `filter-${kind}.marker`);
  const helper = path.join(directory, `filter-${kind}.cjs`);
  const helperBody = kind === 'clean'
    ? [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'invoked');`,
        'process.stdin.pipe(process.stdout);',
      ].join('\n')
    : [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'invoked');`,
        'process.exit(1);',
      ].join('\n');
  writeFileSync(helper, helperBody, 'utf8');
  const command = `${shellQuote(process.execPath)} ${shellQuote(helper)}`;
  execFileSync('git', ['config', `filter.ezterminal-marker.${kind}`, command], { cwd: directory });
  execFileSync('git', ['config', 'filter.ezterminal-marker.required', 'true'], { cwd: directory });
  writeFileSync(tracked, 'changed\n', 'utf8');
  return { marker, tracked };
}

async function mutateAfterOpenedStat(
  target: string,
  mutate: () => void,
  run: () => Promise<void>,
): Promise<void> {
  const originalOpen = fs.open.bind(fs);
  let mutated = false;
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (path.resolve(String(filePath)) !== path.resolve(target)) return handle;
    const originalStat = handle.stat.bind(handle);
    handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
      const value = await originalStat(...args);
      if (!mutated) {
        mutated = true;
        mutate();
      }
      return value;
    }) as typeof handle.stat;
    return handle;
  });
  try {
    await run();
    expect(mutated).toBe(true);
  } finally {
    openSpy.mockRestore();
  }
}

async function removeTemporaryDirectories(): Promise<void> {
  const directories = temporaryDirectories.splice(0);
  const failures: Array<{ directory: string; error: unknown }> = [];
  for (const directory of directories) {
    try {
      // maxBuffer termination can report before Windows or its virus scanner
      // releases the child process cwd. Async retries keep the worker RPC
      // responsive while that transient lock drains.
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch (error) {
      failures.push({ directory, error });
    }
  }
  if (failures.length === 0) return;
  temporaryDirectories.push(...failures.map(({ directory }) => directory));
  throw new AggregateError(
    failures.map(({ error }) => error),
    `Failed to clean ${failures.length} Git status test director${failures.length === 1 ? 'y' : 'ies'}`,
  );
}

afterEach(removeTemporaryDirectories);
afterAll(removeTemporaryDirectories);

describe('GitStatusService.getStatus', () => {
  it('reports nothing at all outside a work tree', async () => {
    const { service, directory } = makeService(() => NOT_A_REPO);
    await expect(service.getStatus(directory)).resolves.toEqual({
      availability: 'not-a-repository',
      tracked: false,
      changes: [],
      truncated: false,
    });
  });

  it('reports a Git failure as unavailable instead of a clean non-repository', async () => {
    const { service, directory } = makeService(() => new Error('spawn git failed'));
    await expect(service.getStatus(directory)).resolves.toEqual({
      availability: 'unavailable',
      tracked: false,
      changes: [],
      truncated: false,
    });
  });

  it('treats git-config exit 1 with no diagnostic as an empty filter lookup', async () => {
    const noMatch = Object.assign(new Error(''), { code: 1 });
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'config') return noMatch;
      if (args[0] === 'status') return ['## main', ''].join('\0');
      return '';
    });
    await expect(service.getStatus(directory)).resolves.toMatchObject({
      availability: 'ready',
      tracked: true,
      branch: 'main',
    });
  });

  it('refuses a path that is not a directory', async () => {
    const { service, calls } = makeService(() => '');
    await expect(service.getStatus('C:\\definitely\\not\\here')).resolves.toMatchObject({
      availability: 'unavailable',
      tracked: false,
    });
    await expect(service.getStatus('')).resolves.toMatchObject({
      availability: 'unavailable',
      tracked: false,
    });
    await expect(service.getStatus('x'.repeat(8_193))).resolves.toMatchObject({
      availability: 'unavailable',
      tracked: false,
    });
    // Nothing was worth spawning git for.
    expect(calls).toHaveLength(0);
  });

  it('merges status letters with line counts and strips the repository prefix', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return 'src/renderer/\n';
      if (args[0] === 'status') {
        return [
          '## feat/handoff-completion...origin/feat/handoff-completion',
          ' M src/renderer/App.tsx',
          '?? src/renderer/New.tsx',
          'R  src/renderer/ui/Next.tsx',
          'src/renderer/ui/Prev.tsx',
          'A  src/renderer/Added.tsx',
          ' D src/renderer/Gone.tsx',
          '',
        ].join('\0');
      }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return ['3\t0\tsrc/renderer/Added.tsx', ''].join('\0');
      }
      return ['18\t6\tsrc/renderer/App.tsx', '0\t9\tsrc/renderer/Gone.tsx', ''].join('\0');
    });

    const status = await service.getStatus(directory);
    expect(status.availability).toBe('ready');
    expect(status.branch).toBe('feat/handoff-completion');
    expect(status.truncated).toBe(false);
    expect(status.changes).toEqual([
      { path: 'App.tsx', kind: 'modified', added: 18, removed: 6 },
      { path: 'New.tsx', kind: 'untracked' },
      { path: 'ui/Next.tsx', kind: 'renamed' },
      { path: 'Added.tsx', kind: 'added', added: 3, removed: 0 },
      { path: 'Gone.tsx', kind: 'deleted', added: 0, removed: 9 },
    ]);
  });

  it('drops changes that live outside the directory that was asked about', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return 'docs/\n';
      if (args[0] === 'status') return ['## main', 'M  docs/ROADMAP.md', 'M  src/main/main.ts', ''].join('\0');
      return '';
    });
    const status = await service.getStatus(directory);
    expect(status.changes).toEqual([{ path: 'ROADMAP.md', kind: 'modified' }]);
  });

  it('does not present a detached head as a branch', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'status') return ['## HEAD (no branch)', ''].join('\0');
      return '';
    });
    const status = await service.getStatus(directory);
    expect(status.tracked).toBe(true);
    expect(status).not.toHaveProperty('branch');
  });

  it('reads the renamed destination out of a numstat rename record', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'status') return ['## main', 'R  new.ts', 'old.ts', ''].join('\0');
      if (args[0] === 'diff' && args.includes('--cached')) {
        return ['4\t2\t', 'old.ts', 'new.ts', ''].join('\0');
      }
      return '';
    });
    const status = await service.getStatus(directory);
    expect(status.changes).toEqual([{ path: 'new.ts', kind: 'renamed', added: 4, removed: 2 }]);
  });

  it('serves a repeat look from cache, then goes back to git once it is stale', async () => {
    let clock = 0;
    const { service, directory, calls } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'status') return ['## main', ''].join('\0');
      return '';
    }, () => clock);

    await service.getStatus(directory);
    const first = calls.length;
    await service.getStatus(directory);
    expect(calls.length).toBe(first);

    clock = 5_000;
    await service.getStatus(directory);
    expect(calls.length).toBeGreaterThan(first);
  });

  it(
    'queries the requested repository even when the parent process has poisoned Git location variables',
    async () => {
      const requested = makeRealRepository();
      const attacker = makeRealRepository();
      writeFileSync(path.join(requested, 'requested.txt'), 'requested\n', 'utf8');
      writeFileSync(path.join(attacker, 'attacker.txt'), 'attacker\n', 'utf8');
      const previousGitDir = process.env.GIT_DIR;
      const previousWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = path.join(attacker, '.git');
      process.env.GIT_WORK_TREE = attacker;
      try {
        const status = await new GitStatusService().getStatus(requested);
        expect(status).toMatchObject({ availability: 'ready', tracked: true, branch: 'main' });
        expect(status.changes.map((change) => change.path)).toEqual(['requested.txt']);
      } finally {
        if (previousGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previousGitDir;
        if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = previousWorkTree;
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('GitStatusService.getDiff', () => {
  it('returns the working-tree diff', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return process.cwd();
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '';
      if (args[0] === 'diff' && !args.includes('--cached')) return 'diff --git a/x b/x\n';
      return '';
    });
    await expect(service.getDiff(directory)).resolves.toEqual({
      ok: true,
      text: '## Unstaged changes\ndiff --git a/x b/x\n',
      truncated: false,
      omissions: [],
    });
  });

  it('says so rather than silently shortening a huge diff', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return process.cwd();
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '';
      if (args[0] === 'diff' && !args.includes('--cached')) return 'x'.repeat(300_000);
      return '';
    });
    const result = await service.getDiff(directory);
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.text).toHaveLength(200_000);
  });

  it('distinguishes "not a repository" from "git failed"', async () => {
    const notRepo = makeService((args) =>
      args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? NOT_A_REPO : '');
    await expect(notRepo.service.getDiff(notRepo.directory)).resolves.toEqual({
      ok: false,
      error: 'not-a-repository',
    });

    const broken = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return process.cwd();
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '';
      return args[0] === 'diff' ? new Error('boom') : '';
    });
    await expect(broken.service.getDiff(broken.directory)).resolves.toEqual({ ok: false, error: 'git-failed' });
  });

  it('aborts and drains sibling Git reads before returning a batch failure', async () => {
    const directory = makeTemporaryDirectory('ez-git-status-drain-');
    let activeSibling = 0;
    let siblingAborted = false;
    let notifySiblingStarted: (() => void) | undefined;
    const siblingStarted = new Promise<void>((resolve) => {
      notifySiblingStarted = resolve;
    });

    class FailingBatchRunner extends GitRunner {
      override async run(
        _cwd: string,
        args: readonly string[],
        signal?: AbortSignal,
      ): Promise<string> {
        const logical = logicalArgs(args);
        if (logical[0] === 'rev-parse' && logical[1] === '--is-inside-work-tree') return 'true\n';
        if (logical[0] === 'config') return '';
        if (logical[0] === 'rev-parse' && logical[1] === '--show-prefix') return '';
        if (logical[0] === 'diff' && logical.includes('--cached')) {
          throw new GitCommandError(logical, 'forced batch failure', 2, '');
        }
        if (logical[0] !== 'rev-parse' || logical[1] !== '--show-toplevel') return '';

        activeSibling += 1;
        notifySiblingStarted?.();
        return await new Promise<string>((_resolve, reject) => {
          if (!signal) return;
          const onAbort = () => {
            siblingAborted = true;
            activeSibling -= 1;
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }

    const resultPromise = new GitStatusService(new FailingBatchRunner()).getDiff(directory);
    await siblingStarted;
    await expect(resultPromise).resolves.toEqual({ ok: false, error: 'git-failed' });
    expect(siblingAborted).toBe(true);
    expect(activeSibling).toBe(0);
  });

  it(
    'reviews readable untracked files in an unborn repository and reports unsafe omissions',
    async () => {
      const directory = makeRealRepository();
      writeFileSync(path.join(directory, 'plain.txt'), 'first line\nsecond line\n', 'utf8');
      writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
      writeFileSync(path.join(directory, 'huge.txt'), 'x'.repeat(200_001), 'utf8');
      const service = new GitStatusService();

      const status = await service.getStatus(directory);
      expect(status).toMatchObject({
        availability: 'ready',
        tracked: true,
        branch: 'main',
      });
      expect(status.changes.map((change) => change.path).sort()).toEqual([
        'binary.bin',
        'huge.txt',
        'plain.txt',
      ]);

      const result = await service.getDiff(directory);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain('## Untracked file');
      expect(result.text).toContain('first line');
      expect(result.text).toContain('second line');
      expect(result.omissions).toEqual([
        { path: 'binary.bin', reason: 'binary' },
        { path: 'huge.txt', reason: 'too-large' },
      ]);
      expect(result.truncated).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'combines staged, unstaged, and untracked review material after the first commit',
    async () => {
      const directory = makeRealRepository();
      writeFileSync(path.join(directory, 'tracked.txt'), 'base\n', 'utf8');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: directory });
      execFileSync(
        'git',
        ['-c', 'user.name=EZTerminal Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'],
        { cwd: directory, stdio: 'ignore' },
      );
      writeFileSync(path.join(directory, 'tracked.txt'), 'base\nunstaged\n', 'utf8');
      writeFileSync(path.join(directory, 'staged.txt'), 'staged\n', 'utf8');
      execFileSync('git', ['add', 'staged.txt'], { cwd: directory });
      writeFileSync(path.join(directory, 'untracked.txt'), 'untracked\n', 'utf8');

      const result = await new GitStatusService().getDiff(directory);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain('## Staged changes');
      expect(result.text).toContain('staged.txt');
      expect(result.text).toContain('## Unstaged changes');
      expect(result.text).toContain('+unstaged');
      expect(result.text).toContain('## Untracked file');
      expect(result.text).toContain('+untracked');
      expect(result.omissions).toEqual([]);
      expect(result.truncated).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['clean', 'process'] as const)(
    'does not execute repository-configured filter.%s helpers while reading status or diff',
    async (kind) => {
      const directory = makeRealRepository();
      const { marker } = configureMarkerFilter(directory, kind);
      const service = new GitStatusService();

      const status = await service.getStatus(directory);
      expect(status).toMatchObject({ availability: 'ready', tracked: true });
      expect(status.changes).toContainEqual(
        expect.objectContaining({ path: 'tracked.txt', kind: 'modified' }),
      );
      const result = await service.getDiff(directory);
      expect(result).toMatchObject({ ok: true });
      expect(existsSync(marker)).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'omits an untracked file that grows after its opened-file metadata check',
    async () => {
      const directory = makeRealRepository();
      const changing = path.join(directory, 'changing.txt');
      writeFileSync(changing, 'before\n', 'utf8');
      let result: Awaited<ReturnType<GitStatusService['getDiff']>> | undefined;

      await mutateAfterOpenedStat(
        changing,
        () => appendFileSync(changing, 'after\n', 'utf8'),
        async () => {
          result = await new GitStatusService().getDiff(directory);
        },
      );

      expect(result).toMatchObject({
        ok: true,
        truncated: true,
        omissions: [{ path: 'changing.txt', reason: 'read-failed' }],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'omits an untracked path that is replaced after its opened-file metadata check',
    async () => {
      const directory = makeRealRepository();
      const changing = path.join(directory, 'changing.txt');
      const displaced = path.join(directory, 'displaced.txt');
      writeFileSync(changing, 'original\n', 'utf8');
      let result: Awaited<ReturnType<GitStatusService['getDiff']>> | undefined;

      await mutateAfterOpenedStat(
        changing,
        () => {
          renameSync(changing, displaced);
          writeFileSync(changing, 'replacement\n', 'utf8');
        },
        async () => {
          result = await new GitStatusService().getDiff(directory);
        },
      );

      expect(result).toMatchObject({
        ok: true,
        truncated: true,
        omissions: [{ path: 'changing.txt', reason: 'read-failed' }],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns a bounded partial review when tracked output exceeds the process buffer',
    async () => {
      const directory = makeRealRepository();
      writeFileSync(path.join(directory, 'large.txt'), 'base\n', 'utf8');
      execFileSync('git', ['add', 'large.txt'], { cwd: directory });
      execFileSync(
        'git',
        ['-c', 'user.name=EZTerminal Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'],
        { cwd: directory, stdio: 'ignore' },
      );
      writeFileSync(path.join(directory, 'large.txt'), `${'changed\n'.repeat(100_000)}`, 'utf8');

      const result = await new GitStatusService().getDiff(directory);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBe(true);
      expect(result.text).toHaveLength(200_000);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('caps concurrent Git readers at four processes', async () => {
    const directory = makeTemporaryDirectory('ez-git-status-gate-');
    let active = 0;
    let peak = 0;
    const execute = ((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ): void => {
      active += 1;
      peak = Math.max(peak, active);
      const logical = logicalArgs(args);
      let output = '';
      if (logical[0] === 'rev-parse' && logical[1] === '--is-inside-work-tree') output = 'true\n';
      else if (logical[0] === 'rev-parse' && logical[1] === '--show-toplevel') output = directory;
      setTimeout(() => {
        active -= 1;
        callback(null, output, '');
      }, 10);
    }) as unknown as ExecFileLike;

    const result = await new GitStatusService(new GitRunner(execute)).getDiff(directory);
    expect(result).toMatchObject({ ok: true });
    expect(peak).toBe(4);
  });
});
