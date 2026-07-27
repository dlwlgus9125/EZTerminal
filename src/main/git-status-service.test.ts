import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GitStatusService } from './git-status-service';
import { GitRunner, type ExecFileLike } from './worktree-service';

type Responder = (args: readonly string[]) => string | Error;

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
    calls.push([...args]);
    const result = respond(args);
    if (result instanceof Error) callback(result, '', 'fatal');
    else callback(null, result, '');
  }) as unknown as ExecFileLike;
  return {
    calls,
    directory: mkdtempSync(path.join(os.tmpdir(), 'ez-git-status-')),
    service: new GitStatusService(new GitRunner(execute), now),
  };
}

const NOT_A_REPO = new Error('not a git repository');

describe('GitStatusService.getStatus', () => {
  it('reports nothing at all outside a work tree', async () => {
    const { service, directory } = makeService(() => NOT_A_REPO);
    await expect(service.getStatus(directory)).resolves.toEqual({
      tracked: false,
      changes: [],
      truncated: false,
    });
  });

  it('refuses a path that is not a directory', async () => {
    const { service, calls } = makeService(() => '');
    await expect(service.getStatus('C:\\definitely\\not\\here')).resolves.toMatchObject({ tracked: false });
    await expect(service.getStatus('')).resolves.toMatchObject({ tracked: false });
    // Nothing was worth spawning git for.
    expect(calls).toHaveLength(0);
  });

  it('merges status letters with line counts and strips the repository prefix', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return 'src/renderer/\n';
      if (args[0] === 'rev-parse') return 'feat/handoff-completion\n';
      if (args[0] === 'status') {
        return [
          ' M src/renderer/App.tsx',
          '?? src/renderer/New.tsx',
          'R  src/renderer/ui/Next.tsx',
          'src/renderer/ui/Prev.tsx',
          'A  src/renderer/Added.tsx',
          ' D src/renderer/Gone.tsx',
          '',
        ].join('\0');
      }
      return ['18\t6\tsrc/renderer/App.tsx', '3\t0\tsrc/renderer/Added.tsx', '0\t9\tsrc/renderer/Gone.tsx', ''].join('\0');
    });

    const status = await service.getStatus(directory);
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
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return 'docs/\n';
      if (args[0] === 'rev-parse') return 'main\n';
      if (args[0] === 'status') return ['M  docs/ROADMAP.md', 'M  src/main/main.ts', ''].join('\0');
      return '';
    });
    const status = await service.getStatus(directory);
    expect(status.changes).toEqual([{ path: 'ROADMAP.md', kind: 'modified' }]);
  });

  it('does not present a detached head as a branch', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'rev-parse') return 'HEAD\n';
      return '';
    });
    const status = await service.getStatus(directory);
    expect(status.tracked).toBe(true);
    expect(status).not.toHaveProperty('branch');
  });

  it('reads the renamed destination out of a numstat rename record', async () => {
    const { service, directory } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'rev-parse') return 'main\n';
      if (args[0] === 'status') return ['R  new.ts', 'old.ts', ''].join('\0');
      return ['4\t2\t', 'old.ts', 'new.ts', ''].join('\0');
    });
    const status = await service.getStatus(directory);
    expect(status.changes).toEqual([{ path: 'new.ts', kind: 'renamed', added: 4, removed: 2 }]);
  });

  it('serves a repeat look from cache, then goes back to git once it is stale', async () => {
    let clock = 0;
    const { service, directory, calls } = makeService((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return '\n';
      if (args[0] === 'rev-parse') return 'main\n';
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
});

describe('GitStatusService.getDiff', () => {
  it('returns the working-tree diff', async () => {
    const { service, directory } = makeService((args) => (args[0] === 'diff' ? 'diff --git a/x b/x\n' : ''));
    await expect(service.getDiff(directory)).resolves.toEqual({
      ok: true,
      text: 'diff --git a/x b/x\n',
      truncated: false,
    });
  });

  it('says so rather than silently shortening a huge diff', async () => {
    const { service, directory } = makeService((args) => (args[0] === 'diff' ? 'x'.repeat(300_000) : ''));
    const result = await service.getDiff(directory);
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.text).toHaveLength(200_000);
  });

  it('distinguishes "not a repository" from "git failed"', async () => {
    const notRepo = makeService((args) => (args[0] === 'rev-parse' ? NOT_A_REPO : ''));
    await expect(notRepo.service.getDiff(notRepo.directory)).resolves.toEqual({
      ok: false,
      error: 'not-a-repository',
    });

    const broken = makeService((args) => (args[0] === 'diff' ? new Error('boom') : ''));
    await expect(broken.service.getDiff(broken.directory)).resolves.toEqual({ ok: false, error: 'git-failed' });
  });
});
