/**
 * Bounded atomic storage with strict path and permission checks.
 *
 * Windows path ACL changes cannot revoke a handle opened during file creation,
 * so confidential callers must also encrypt content before calling writeAtomic.
 * RemoteTokenStore does so with Electron safeStorage in production.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs, type BigIntStats, type Stats } from 'node:fs';
import path from 'node:path';

export const SECURE_ATOMIC_FILE_MAX_BYTES = 4 * 1024;

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:EZTERMINAL_SECURE_FILE
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing secure file path' }
$item = Get-Item -LiteralPath $target -Force
if ($item.PSIsContainer) { throw 'Secure target must be a file' }
if ($null -ne $item.LinkType) { throw 'Secure target must not be a link' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
& icacls.exe $target '/inheritance:r' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls inheritance update failed: $LASTEXITCODE" }
$existingSids = @((Get-Acl -LiteralPath $target).Access | ForEach-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
} | Sort-Object -Unique)
foreach ($sid in $existingSids) {
  & icacls.exe $target '/remove:g' ('*' + $sid) '/remove:d' ('*' + $sid) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls principal removal failed: $LASTEXITCODE" }
}
& icacls.exe $target '/grant:r' ('*' + $current.Value + ':(F)') ('*' + $system.Value + ':(F)') | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls grant failed: $LASTEXITCODE" }
$verified = Get-Acl -LiteralPath $target
if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance is still enabled' }
$allowedSids = @($current.Value, $system.Value)
$seenCurrent = $false
$seenSystem = $false
foreach ($rule in $verified.Access) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowedSids -notcontains $sid) { throw "Unexpected ACL principal: $sid" }
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains' }
  if ($rule.AccessControlType -ne $allow) { throw 'Deny ACL rule remains' }
  if (($rule.FileSystemRights -band $full) -ne $full) { throw "Insufficient ACL rights for $sid" }
  if ($sid -eq $current.Value) { $seenCurrent = $true }
  if ($sid -eq $system.Value) { $seenSystem = $true }
}
if (-not $seenCurrent -or -not $seenSystem) { throw 'Required ACL principal is missing' }
`.trim();

export type WindowsAclRunner = (filePath: string) => Promise<void>;

/** Apply and verify a current-user + SYSTEM DACL without invoking a shell. */
export function applyAndVerifyWindowsAcl(
  filePath: string,
  execute: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // GitHub-hosted Windows runners launch pnpm from PowerShell 7, whose
    // PSModulePath can omit the Windows PowerShell 5.1 inbox modules. The ACL
    // helper intentionally uses powershell.exe, so put its trusted system
    // module directory first instead of depending on the parent shell's path.
    const windowsPowerShellModules = path.win32.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules',
    );
    const options: ExecFileOptions = {
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        PSModulePath: [windowsPowerShellModules, process.env.PSModulePath]
          .filter((entry): entry is string => Boolean(entry))
          .join(';'),
        EZTERMINAL_SECURE_FILE: filePath,
      },
    };
    execute(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT],
      options,
      (error) => {
        if (error) reject(new Error('Unable to apply and verify the remote-token file ACL.', { cause: error }));
        else resolve();
      },
    );
  });
}

export interface SecureAtomicFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsAclRunner;
  readonly maxBytes?: number;
}

async function lstatIfPresent(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type FileIdentityStat = Stats | BigIntStats;

function hasSameIdentity(first: FileIdentityStat, second: FileIdentityStat): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export class SecureAtomicFile {
  private readonly target: string;
  private readonly platform: NodeJS.Platform;
  private readonly windowsAcl: WindowsAclRunner;
  private readonly maxBytes: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string, name: string, options: SecureAtomicFileOptions = {}) {
    this.target = path.join(dir, name);
    this.platform = options.platform ?? process.platform;
    this.windowsAcl = options.windowsAcl ?? applyAndVerifyWindowsAcl;
    this.maxBytes = options.maxBytes !== undefined
      && Number.isFinite(options.maxBytes)
      && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : SECURE_ATOMIC_FILE_MAX_BYTES;
  }

  get path(): string {
    return this.target;
  }

  async init(): Promise<void> {
    const directory = path.dirname(this.target);
    await fs.mkdir(directory, { recursive: true });
    await this.removeStaleTemp(`${this.target}.tmp`);
    const randomTempPrefix = `${path.basename(this.target)}.tmp-`;
    for (const entry of await fs.readdir(directory)) {
      if (entry.startsWith(randomTempPrefix)) await this.removeStaleTemp(path.join(directory, entry));
    }
    await this.protectIfPresent(this.target);
    await this.protectIfPresent(`${this.target}.corrupt`);
  }

  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async readText(): Promise<string | undefined> {
    const stat = await lstatIfPresent(this.target);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Remote token path must be a regular file.');

    if (this.platform === 'win32') {
      await this.windowsAcl(this.target);
      const verified = await fs.lstat(this.target);
      if (!verified.isFile() || verified.isSymbolicLink()) throw new Error('Remote token path changed during ACL verification.');
    }

    const noFollow = this.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(this.target, constants.O_RDONLY | noFollow);
    try {
      if (this.platform !== 'win32') await handle.chmod(0o600);
      const verified = await handle.stat();
      if (!verified.isFile()
        || (this.platform !== 'win32' && (verified.mode & 0o777) !== 0o600)) {
        throw new Error('Remote token file permissions are not 0600.');
      }
      if (verified.size > this.maxBytes) throw new Error('Remote token file exceeds the secure storage size limit.');
      const bytes = Buffer.alloc(this.maxBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > this.maxBytes) throw new Error('Remote token file exceeds the secure storage size limit.');
      return bytes.subarray(0, offset).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async writeAtomic(data: string): Promise<void> {
    if (Buffer.byteLength(data, 'utf8') > this.maxBytes) {
      throw new Error('Remote token file exceeds the secure storage size limit.');
    }
    await this.assertReplaceable(this.target);
    const tmp = `${this.target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    const noFollow = this.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error('Remote token temporary path must be a regular file.');
      if (this.platform === 'win32') {
        // Harden the empty staging path before content is written. Callers that
        // require confidentiality on Windows must still pass ciphertext: a
        // DACL update cannot revoke a handle another principal already opened.
        await this.windowsAcl(tmp);
        await this.assertHandlePathIdentity(handle, tmp, opened);
      }
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      if (this.platform !== 'win32') {
        await handle.chmod(0o600);
      } else {
        await this.assertHandlePathIdentity(handle, tmp, opened);
      }
      await handle.close();
      handle = null;
      if (this.platform === 'win32') await this.assertPathIdentity(tmp, opened);
      else await this.protectRequired(tmp);
      await this.assertReplaceable(this.target);
      try {
        await fs.rename(tmp, this.target);
      } catch {
        await fs.rename(tmp, this.target);
      }
      await this.protectRequired(this.target);
      if (this.platform === 'win32') await this.assertPathIdentity(this.target, opened);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async quarantine(): Promise<void> {
    const source = await lstatIfPresent(this.target);
    if (!source) return;
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('Remote token path must be a regular file.');
    const destination = `${this.target}.corrupt`;
    const oldQuarantine = await lstatIfPresent(destination);
    if (oldQuarantine) {
      if (!oldQuarantine.isFile() || oldQuarantine.isSymbolicLink()) {
        throw new Error('Remote token quarantine path must be a regular file.');
      }
      await this.protectRequired(destination);
      await fs.unlink(destination);
    }
    await fs.rename(this.target, destination);
    await this.protectRequired(destination);
  }

  private async removeStaleTemp(filePath: string): Promise<void> {
    const stat = await lstatIfPresent(filePath);
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Remote token temporary path must be a regular file.');
    await this.protectRequired(filePath);
    await fs.unlink(filePath);
  }

  private async assertReplaceable(filePath: string): Promise<void> {
    const stat = await lstatIfPresent(filePath);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Remote token path must be a regular file.');
  }

  private async protectIfPresent(filePath: string): Promise<void> {
    const stat = await lstatIfPresent(filePath);
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Secure path must be a regular file.');
    await this.protectRequired(filePath);
  }

  private async assertHandlePathIdentity(
    handle: Awaited<ReturnType<typeof fs.open>>,
    filePath: string,
    expected: FileIdentityStat,
  ): Promise<void> {
    const [held, pathStat] = await Promise.all([handle.stat(), lstatIfPresent(filePath)]);
    if (
      !held.isFile()
      || !pathStat
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || !hasSameIdentity(expected, held)
      || !hasSameIdentity(held, pathStat)
    ) {
      throw new Error('Secure temporary path changed during ACL verification.');
    }
  }

  private async assertPathIdentity(filePath: string, expected: FileIdentityStat): Promise<void> {
    const stat = await lstatIfPresent(filePath);
    if (
      !stat
      || !stat.isFile()
      || stat.isSymbolicLink()
      || !hasSameIdentity(expected, stat)
    ) {
      throw new Error('Secure file identity changed during atomic replacement.');
    }
  }

  private async protectRequired(filePath: string): Promise<void> {
    if (this.platform === 'win32') {
      await this.windowsAcl(filePath);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Secure path changed during ACL verification.');
      return;
    }
    const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.chmod(0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Secure file permissions are not 0600.');
    } finally {
      await handle.close();
    }
  }
}
