import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RemoteTokenStore } from './remote-token-store';
import {
  applyAndVerifyWindowsAcl,
  applyAndVerifyWindowsDirectoryAcl,
  protectedDirectoryAcl,
  SecureAtomicFile,
} from './secure-atomic-file';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-secure-file-'));
}

describe('SecureAtomicFile', () => {
  it('hardens both the temporary file and the landed target before resolving', async () => {
    const calls: string[] = [];
    const observedSizes: number[] = [];
    const file = new SecureAtomicFile(makeDir(), 'remote-token.json', {
      platform: 'win32',
      windowsAcl: async (filePath) => {
        calls.push(filePath);
        observedSizes.push(lstatSync(filePath).size);
      },
    });
    await file.init();
    await file.enqueue(() => file.writeAtomic('{"ok":true}'));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/remote-token\.json\.tmp-/);
    expect(calls[1]).toBe(file.path);
    expect(observedSizes).toEqual([0, Buffer.byteLength('{"ok":true}')]);
    expect(readFileSync(file.path, 'utf8')).toBe('{"ok":true}');
  });

  it('rejects a Windows temp-path swap before writing secret bytes to the held file', async () => {
    const dir = makeDir();
    let displaced = '';
    const file = new SecureAtomicFile(dir, 'remote-token.json', {
      platform: 'win32',
      windowsAcl: async (filePath) => {
        if (!filePath.includes('.tmp-')) return;
        displaced = `${filePath}.displaced`;
        renameSync(filePath, displaced);
        writeFileSync(filePath, 'replacement', 'utf8');
      },
    });
    await file.init();

    await expect(file.writeAtomic('top-secret')).rejects.toThrow(/changed during ACL verification/);
    expect(readFileSync(displaced, 'utf8')).toBe('');
    expect(existsSync(file.path)).toBe(false);
  });

  it('propagates ACL failures and does not land or cache the new token', async () => {
    const dir = makeDir();
    let fail = true;
    const store = new RemoteTokenStore(dir, {
      platform: 'win32',
      windowsAcl: async () => {
        if (fail) throw new Error('acl denied');
      },
    });
    await store.init();

    await expect(store.getToken()).rejects.toThrow('acl denied');
    expect(existsSync(store.path)).toBe(false);

    fail = false;
    await expect(store.getToken()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it.runIf(process.platform !== 'win32')('repairs and verifies POSIX mode 0600', async () => {
    const file = new SecureAtomicFile(makeDir(), 'remote-token.json');
    await file.init();
    await file.writeAtomic('secret');
    expect(lstatSync(file.path).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink token target', async () => {
    const dir = makeDir();
    const outside = path.join(dir, 'outside');
    const target = path.join(dir, 'remote-token.json');
    symlinkSync(outside, target);
    const file = new SecureAtomicFile(dir, 'remote-token.json');
    await expect(file.init()).rejects.toThrow(/regular file/);
  });

  it('bounds secret reads and writes before allocating or parsing untrusted content', async () => {
    const file = new SecureAtomicFile(makeDir(), 'remote-token.json', {
      maxBytes: 8,
      platform: 'win32',
      windowsAcl: async () => undefined,
    });
    await file.init();
    await expect(file.writeAtomic('123456789')).rejects.toThrow(/size limit/);
    writeFileSync(file.path, '123456789', 'utf8');
    await expect(file.readText()).rejects.toThrow(/size limit/);
  });
});

describe('applyAndVerifyWindowsAcl', () => {
  it('uses a static PowerShell command and commits the complete ACL in one filesystem update', async () => {
    const executeMock = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(null, '', '');
      return {} as ChildProcess;
    });
    const execute = executeMock as unknown as typeof execFile;
    const trickyPath = "C:\\tmp\\remote-token'; Remove-Item C:\\important #.json";

    await applyAndVerifyWindowsAcl(trickyPath, execute);

    const [executable, args, options] = executeMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; env: NodeJS.ProcessEnv },
    ];
    expect(executable).toBe('powershell.exe');
    expect(options.shell).toBe(false);
    expect(args.join(' ')).not.toContain(trickyPath);
    expect(options.env.EZTERMINAL_SECURE_FILE).toBe(trickyPath);
    const command = args.join(' ');
    expect(command).not.toContain('icacls.exe');
    expect(command).toContain('FileSecurity');
    expect(command).toContain('SetAccessRuleProtection');
    expect(command).toContain('AddAccessRule');
    expect(command.match(/SetAccessControl/gu)).toHaveLength(1);
    expect(command).toContain('AreAccessRulesProtected');
    expect(command).toContain('GetAccessRules');
    expect(command).not.toContain('Get-Acl');
  });

  it.runIf(process.platform === 'win32')('applies a verified current-user + SYSTEM ACL on Windows', async () => {
    const file = new SecureAtomicFile(makeDir(), 'remote-token.json');
    await file.init();
    await expect(file.writeAtomic('secret')).resolves.toBeUndefined();
    await expect(file.readText()).resolves.toBe('secret');
  // The product command still fails at 15 s. Leave the harness enough time to
  // observe that callback under a fully concurrent Windows test run.
  }, 20_000);
});

describe('protectedDirectoryAcl', () => {
  it('protects its directory once for every file, operation and concurrent caller', async () => {
    const directory = makeDir();
    const harden = vi.fn(async () => undefined);
    const acl = protectedDirectoryAcl(directory, { platform: 'win32', harden });
    const files = ['a.bin', 'b.bin'].map((name) => new SecureAtomicFile(directory, name, { platform: 'win32', windowsAcl: acl.windowsAcl }));
    void acl.prepare();
    await Promise.all(files.map((file) => file.init()));
    await Promise.all(files.map((file, index) => file.enqueue(() => file.writeAtomic(`value ${index}`))));
    await expect(Promise.all(files.map((file) => file.readText()))).resolves.toEqual(['value 0', 'value 1']);

    expect(harden).toHaveBeenCalledTimes(1);
    expect(harden).toHaveBeenCalledWith(directory);
  });

  it('tries again after a failed protection instead of caching the failure', async () => {
    const directory = makeDir();
    const harden = vi.fn()
      .mockRejectedValueOnce(new Error('powershell unavailable'))
      .mockResolvedValue(undefined);
    const acl = protectedDirectoryAcl(directory, { platform: 'win32', harden });
    const file = new SecureAtomicFile(directory, 'draft.bin', { platform: 'win32', windowsAcl: acl.windowsAcl });

    await expect(file.writeAtomic('first')).rejects.toThrow(/powershell unavailable/);
    await expect(file.writeAtomic('second')).resolves.toBeUndefined();
    expect(readFileSync(file.path, 'utf8')).toBe('second');
    expect(harden).toHaveBeenCalledTimes(2);
  });

  it('reads existing files without waiting for the protection, and holds writes until it is done', async () => {
    const directory = makeDir();
    writeFileSync(path.join(directory, 'draft.bin'), 'stored');
    let finish: (() => void) | undefined;
    const harden = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const acl = protectedDirectoryAcl(directory, { platform: 'win32', harden });
    const file = new SecureAtomicFile(directory, 'draft.bin', { platform: 'win32', windowsAcl: acl.windowsAcl });

    await file.init();
    await expect(file.readText()).resolves.toBe('stored');
    let written = false;
    const write = file.writeAtomic('next').then(() => { written = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toBe(false);
    finish?.();
    await write;
    expect(readFileSync(file.path, 'utf8')).toBe('next');
    expect(harden).toHaveBeenCalledTimes(1);
  });

  it('refuses a file outside the protected directory', async () => {
    const acl = protectedDirectoryAcl(makeDir(), { platform: 'win32', harden: async () => undefined });
    await expect(acl.windowsAcl(path.join(makeDir(), 'elsewhere.bin'))).rejects.toThrow(/outside/);
  });

  it('does nothing off Windows, where files are already created 0600', async () => {
    const harden = vi.fn(async () => undefined);
    await protectedDirectoryAcl(makeDir(), { platform: 'linux', harden }).prepare();
    expect(harden).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('leaves only current-user and SYSTEM access, inherited, on files created before and after', async () => {
    const directory = makeDir();
    // The first temporary file of a write exists before its ACL step runs.
    writeFileSync(path.join(directory, 'early.bin'), '');
    const acl = protectedDirectoryAcl(directory);
    await acl.prepare();
    const file = new SecureAtomicFile(directory, 'draft.bin', { windowsAcl: acl.windowsAcl });
    await file.init();
    await file.enqueue(() => file.writeAtomic('ciphertext'));

    const report = (target: string): { protected: boolean; rules: { sid: string; inherited: boolean }[] } => JSON.parse(execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      // .NET only: under pwsh 7, Windows PowerShell inherits a module path where Get-Acl cannot load.
      '$target = $env:EZTERMINAL_ACL_TARGET; '
        + '$acl = if ([IO.Directory]::Exists($target)) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }; '
        + '@{ protected = $acl.AreAccessRulesProtected; rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) '
        + '| ForEach-Object { @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited } }) } | ConvertTo-Json -Depth 4 -Compress',
    ], { encoding: 'utf8', env: { ...process.env, EZTERMINAL_ACL_TARGET: target } }));
    const allowed = new Set([
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim(),
      'S-1-5-18',
    ]);

    expect(report(directory).protected).toBe(true);
    for (const target of [path.join(directory, 'early.bin'), file.path]) {
      const { rules } = report(target);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(allowed.has(rule.sid), `${target}: ${rule.sid}`).toBe(true);
        expect(rule.inherited).toBe(true);
      }
    }
  }, 30_000);
});

describe('applyAndVerifyWindowsDirectoryAcl', () => {
  it('uses a static PowerShell command and gives the directory one inheritable, protected DACL', async () => {
    const executeMock = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(null, '', '');
      return {} as ChildProcess;
    });
    const trickyPath = "C:\\tmp\\chat-state'; Remove-Item C:\\important #";

    await applyAndVerifyWindowsDirectoryAcl(trickyPath, executeMock as unknown as typeof execFile);

    const [executable, args, options] = executeMock.mock.calls[0] as unknown as [string, string[], { shell: boolean; env: NodeJS.ProcessEnv }];
    expect(executable).toBe('powershell.exe');
    expect(options.shell).toBe(false);
    expect(args.join(' ')).not.toContain(trickyPath);
    expect(options.env.EZTERMINAL_SECURE_DIRECTORY).toBe(trickyPath);
    const command = args.join(' ');
    expect(command).toContain('DirectorySecurity');
    expect(command).toContain('SetAccessRuleProtection');
    expect(command).toContain('ContainerInherit');
    expect(command).toContain('ObjectInherit');
    expect(command).toContain('ReparsePoint');
    expect(command.match(/SetAccessControl/gu)).toHaveLength(1);
    expect(command).toContain('AreAccessRulesProtected');
    expect(command).not.toContain('Get-Acl');
  });
});
