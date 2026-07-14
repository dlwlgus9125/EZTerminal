import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SSH_CONFIG_MAX_BYTES,
  SSH_G_STDOUT_MAX_BYTES,
  hostPatternsMatch,
  resolveSshConfigAlias,
  tokenizeSshConfigLine,
  type SshGRunner,
} from './ssh-config-resolver';

let root: string;
let home: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ezterminal-ssh-config-test-'));
  home = join(root, 'home');
  configPath = join(home, '.ssh', 'config');
  await mkdir(join(home, '.ssh'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function config(contents: string): Promise<void> {
  await writeFile(configPath, contents, 'utf8');
}

function output(overrides: Partial<{ hostname: string; user: string; port: string; identities: string[] }> = {}): string {
  const values = {
    hostname: 'prod.internal',
    user: 'deploy',
    port: '2201',
    identities: [] as string[],
    ...overrides,
  };
  return [
    `hostname ${values.hostname}`,
    `user ${values.user}`,
    `port ${values.port}`,
    ...values.identities.map((path) => `identityfile ${path}`),
    '',
  ].join('\n');
}

describe('ssh_config tokenizer and host patterns', () => {
  it('supports quotes, comments, key=value, and negated host patterns', () => {
    expect(tokenizeSshConfigLine('IdentityFile="~/.ssh/key with space" # ignored')).toEqual([
      'IdentityFile',
      '~/.ssh/key with space',
    ]);
    expect(hostPatternsMatch(['*', '!prod-bad'], 'prod-good')).toBe(true);
    expect(hostPatternsMatch(['*', '!prod-bad'], 'prod-bad')).toBe(false);
    expect(tokenizeSshConfigLine('IdentityFile "C:\\Users\\alice\\id_ed25519"')).toEqual([
      'IdentityFile',
      'C:\\Users\\alice\\id_ed25519',
    ]);
  });
});

describe('resolveSshConfigAlias', () => {
  it('expands Include files, passes only a private sanitized config to ssh -G, and selects a readable key', async () => {
    const keyPath = join(home, '.ssh', 'id_prod');
    await writeFile(keyPath, 'key', { mode: 0o600 });
    await mkdir(join(home, '.ssh', 'conf.d'));
    await writeFile(
      join(home, '.ssh', 'conf.d', 'prod.conf'),
      ['Host prod', '  HostName prod.internal', '  Port 2201', '  IdentityFile ~/.ssh/id_prod', ''].join('\n'),
    );
    await config(['Host *', '  User deploy', 'Include conf.d/*.conf', ''].join('\n'));

    let sanitizedPath = '';
    const runSshG: SshGRunner = async (executable, args) => {
      expect(executable).toBe('ssh-test');
      expect(args[0]).toBe('-G');
      expect(args[1]).toBe('-F');
      expect(args.slice(-2)).toEqual(['--', 'prod']);
      sanitizedPath = args[2];
      expect(sanitizedPath).not.toBe(configPath);
      const sanitized = await readFile(sanitizedPath, 'utf8');
      expect(sanitized).toContain('Host prod');
      expect(sanitized).toContain('HostName "prod.internal"');
      expect(sanitized).toContain('User "deploy"');
      expect(sanitized).not.toContain('Include');
      return { stdout: output({ identities: ['~/.ssh/missing', '~/.ssh/id_prod'] }), stderr: '' };
    };

    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, sshExecutable: 'ssh-test', runSshG },
    )).resolves.toEqual({ alias: 'prod', host: 'prod.internal', port: 2201, user: 'deploy', keyPath });
    await expect(access(sanitizedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies explicit --port and --key after sanitized resolution', async () => {
    await config(['Host prod', '  HostName prod.internal', '  User deploy', '  Port 2201', ''].join('\n'));
    const explicitKey = join(root, 'explicit-key');
    const runSshG: SshGRunner = async () => ({ stdout: output(), stderr: '' });

    const resolved = await resolveSshConfigAlias(
      { alias: 'prod', portOverride: 2022, keyPathOverride: explicitKey },
      { homeDir: home, configPath, tempDir: root, runSshG },
    );
    expect(resolved).toMatchObject({ host: 'prod.internal', port: 2022, user: 'deploy', keyPath: explicitKey });
  });

  it('rejects an unsafe directive only when it applies to the selected alias', async () => {
    await config([
      'Host unrelated',
      '  ProxyCommand definitely-not-run',
      'Host prod',
      '  HostName prod.internal',
      '  User deploy',
      '',
    ].join('\n'));
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).resolves.toMatchObject({ host: 'prod.internal' });
    expect(runSshG).toHaveBeenCalledOnce();

    await config(['Host prod', '  HostName prod.internal', '  ProxyJump bastion', ''].join('\n'));
    runSshG.mockClear();
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/unsafe SSH directive 'ProxyJump'/);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it('rejects an applicable Match exec before OpenSSH can evaluate the canary', async () => {
    const canary = join(root, 'match-exec-canary');
    await config([
      'Host prod',
      '  HostName prod.internal',
      `Match exec "node -e \\"require('fs').writeFileSync('${canary}', 'owned')\\""`,
      '  User deploy',
      '',
    ].join('\n'));
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));

    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/applicable Match directives are not supported/);
    expect(runSshG).not.toHaveBeenCalled();
    await expect(access(canary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Match host against the effective HostName, while originalhost uses the CLI alias', async () => {
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));

    await config([
      'Host prod',
      '  HostName prod.internal',
      'Match host prod.internal originalhost prod',
      '  ProxyCommand must-never-run',
      '',
    ].join('\n'));

    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/applicable Match directives are not supported/);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it('detects Include cycles and never invokes ssh -G', async () => {
    const included = join(home, '.ssh', 'included.conf');
    await config('Include included.conf\n');
    await writeFile(included, 'Include config\n');
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/Include cycle/);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it('rejects oversized root and Include files before invoking ssh -G', async () => {
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));
    const oversized = Buffer.alloc(SSH_CONFIG_MAX_BYTES + 1, 0x0a);

    await writeFile(configPath, oversized);
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/expands beyond 1048576 bytes/);

    const included = join(home, '.ssh', 'oversized.conf');
    await config('Include oversized.conf\nHost prod\n');
    await writeFile(included, oversized);
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/expands beyond 1048576 bytes/);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it('fails closed for root and Include file symlinks', async () => {
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));
    const linkedRoot = join(root, 'linked-root.conf');
    await writeFile(linkedRoot, 'Host prod\n  HostName prod.internal\n');
    await symlink(linkedRoot, configPath, 'file');
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/symbolic link|reparse point/i);

    await rm(configPath);
    const linkedInclude = join(root, 'linked-include.conf');
    const includePath = join(home, '.ssh', 'include.conf');
    await writeFile(linkedInclude, 'Host prod\n  HostName prod.internal\n');
    await symlink(linkedInclude, includePath, 'file');
    await config('Include include.conf\n');
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/symbolic link|reparse point/i);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it('enforces Include depth, file-count, and line-size bounds before ssh -G', async () => {
    const runSshG = vi.fn<SshGRunner>(async () => ({ stdout: output(), stderr: '' }));

    await config('Include depth-1.conf\n');
    for (let depth = 1; depth <= 5; depth += 1) {
      await writeFile(
        join(home, '.ssh', `depth-${depth}.conf`),
        depth === 5 ? 'Host prod\n' : `Include depth-${depth + 1}.conf\n`,
      );
    }
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/Include depth exceeds 4/);

    const manyDir = join(home, '.ssh', 'many');
    await mkdir(manyDir);
    for (let index = 0; index < 16; index += 1) {
      await writeFile(join(manyDir, `${String(index).padStart(2, '0')}.conf`), 'Host unrelated\n');
    }
    await config('Include many/*.conf\n');
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/expands beyond 16 files/);

    await config(`Host prod\n#${'x'.repeat(8 * 1024)}\n`);
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(/line exceeds 8192 bytes/);
    expect(runSshG).not.toHaveBeenCalled();
  });

  it.each([
    ['missing executable', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }), /executable was not found/],
    ['timeout', Object.assign(new Error('killed'), { killed: true }), /timed out after 3000ms/],
  ])('reports %s without falling back to an unsafe path', async (_label, failure, expected) => {
    await config(['Host prod', '  HostName prod.internal', ''].join('\n'));
    const runSshG: SshGRunner = async () => { throw failure; };
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      { homeDir: home, configPath, tempDir: root, runSshG },
    )).rejects.toThrow(expected);
  });

  it('rejects stdout and stderr above their independent caps', async () => {
    await config(['Host prod', '  HostName prod.internal', ''].join('\n'));
    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      {
        homeDir: home,
        configPath,
        tempDir: root,
        runSshG: async () => ({ stdout: 'x'.repeat(SSH_G_STDOUT_MAX_BYTES + 1), stderr: '' }),
      },
    )).rejects.toThrow(/output exceeded its size limit/);

    await expect(resolveSshConfigAlias(
      { alias: 'prod' },
      {
        homeDir: home,
        configPath,
        tempDir: root,
        runSshG: async () => ({ stdout: output(), stderr: 'x'.repeat(64 * 1024 + 1) }),
      },
    )).rejects.toThrow(/diagnostic output exceeded its size limit/);
  });
});
