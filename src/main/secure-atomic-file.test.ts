import { execFile, type ChildProcess } from 'node:child_process';
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
import { applyAndVerifyWindowsAcl, SecureAtomicFile } from './secure-atomic-file';

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
  it('uses a static PowerShell command with shell:false and carries the path only in the environment', async () => {
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
    expect(options.env.PSModulePath?.split(';')[0]).toBe(path.win32.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules',
    ));
    expect(args.join(' ')).toContain('icacls.exe');
    expect(args.join(' ')).toContain('AreAccessRulesProtected');
  });

  it.runIf(process.platform === 'win32')('applies a verified current-user + SYSTEM ACL on Windows', async () => {
    const file = new SecureAtomicFile(makeDir(), 'remote-token.json');
    await file.init();
    await expect(file.writeAtomic('secret')).resolves.toBeUndefined();
    await expect(file.readText()).resolves.toBe('secret');
  }, 15_000);
});
