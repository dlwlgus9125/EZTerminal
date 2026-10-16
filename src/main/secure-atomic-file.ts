/**
 * Bounded atomic storage with strict path and permission checks.
 *
 * Windows path ACL changes cannot revoke a handle opened during file creation,
 * so confidential callers must also encrypt content before calling writeAtomic.
 * RemoteTokenStore does so with Electron safeStorage in production.
 *
 * Two Windows ACL modes:
 * - per file (default): every read and write applies and re-verifies the file's
 *   own DACL, one PowerShell run each. RemoteTokenStore keeps this.
 * - protected directory (`protectedDirectoryAcl`): the directory gets one
 *   protected, inheritable current-user + SYSTEM DACL; files created in it
 *   inherit that DACL, so reads and writes run no PowerShell. It gives up
 *   per-file re-verification on read. Draft stores use it: the directory DACL
 *   stops other principals creating or replacing files, and their content is
 *   DPAPI user-scope ciphertext. A cold PowerShell costs seconds, and drafts
 *   are saved while the user types.
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
$replacement = New-Object System.Security.AccessControl.FileSecurity
$replacement.SetAccessRuleProtection($true, $false)
$replacement.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, $full, $allow)))
$replacement.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $allow)))
[System.IO.File]::SetAccessControl($target, $replacement)
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access
$verified = [System.IO.File]::GetAccessControl($target, $accessSections)
if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance is still enabled' }
$allowedSids = @($current.Value, $system.Value)
$seenCurrent = $false
$seenSystem = $false
foreach ($rule in $verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $sid = $rule.IdentityReference.Value
  if ($allowedSids -notcontains $sid) { throw "Unexpected ACL principal: $sid" }
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains' }
  if ($rule.AccessControlType -ne $allow) { throw 'Deny ACL rule remains' }
  if (($rule.FileSystemRights -band $full) -ne $full) { throw "Insufficient ACL rights for $sid" }
  if ($sid -eq $current.Value) { $seenCurrent = $true }
  if ($sid -eq $system.Value) { $seenSystem = $true }
}
if (-not $seenCurrent -or -not $seenSystem) { throw 'Required ACL principal is missing' }
`.trim();

const WINDOWS_DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:EZTERMINAL_SECURE_DIRECTORY
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing secure directory path' }
$item = Get-Item -LiteralPath $target -Force
if (-not $item.PSIsContainer) { throw 'Secure target must be a directory' }
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Secure directory must not be a link' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$replacement = New-Object System.Security.AccessControl.DirectorySecurity
$replacement.SetAccessRuleProtection($true, $false)
$replacement.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, $full, $inherit, $propagation, $allow)))
$replacement.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $inherit, $propagation, $allow)))
[System.IO.Directory]::SetAccessControl($target, $replacement)
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access
$verified = [System.IO.Directory]::GetAccessControl($target, $accessSections)
if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance is still enabled' }
$allowedSids = @($current.Value, $system.Value)
$seenCurrent = $false
$seenSystem = $false
foreach ($rule in $verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $sid = $rule.IdentityReference.Value
  if ($allowedSids -notcontains $sid) { throw "Unexpected ACL principal: $sid" }
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains' }
  if ($rule.AccessControlType -ne $allow) { throw 'Deny ACL rule remains' }
  if (($rule.FileSystemRights -band $full) -ne $full) { throw "Insufficient ACL rights for $sid" }
  if (($rule.InheritanceFlags -band $inherit) -ne $inherit) { throw "ACL rule for $sid is not inherited by files" }
  if ($sid -eq $current.Value) { $seenCurrent = $true }
  if ($sid -eq $system.Value) { $seenSystem = $true }
}
if (-not $seenCurrent -or -not $seenSystem) { throw 'Required ACL principal is missing' }
`.trim();

/**
 * `read`: the file already exists and is about to be read or removed. `write`: the file
 * was just created or replaced. The per-file runner treats both the same.
 */
export type WindowsAclIntent = 'read' | 'write';
export type WindowsAclRunner = (filePath: string, intent?: WindowsAclIntent) => Promise<void>;

/** Apply and verify a current-user + SYSTEM DACL without invoking a shell. */
export function applyAndVerifyWindowsAcl(
  filePath: string,
  execute: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: ExecFileOptions = {
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
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

/**
 * Give a directory a protected, inheritable current-user + SYSTEM DACL and verify it.
 * Setting it also re-derives the inherited ACEs of files already inside.
 */
export function applyAndVerifyWindowsDirectoryAcl(
  directoryPath: string,
  execute: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: ExecFileOptions = {
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        EZTERMINAL_SECURE_DIRECTORY: directoryPath,
      },
    };
    execute(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_DIRECTORY_ACL_SCRIPT],
      options,
      (error) => {
        if (error) reject(new Error('Unable to apply and verify the secure directory ACL.', { cause: error }));
        else resolve();
      },
    );
  });
}

export interface ProtectedDirectoryAcl {
  /** Protects the directory with one PowerShell run; a failure is not kept, so the next call tries again. */
  prepare(): Promise<void>;
  /**
   * SecureAtomicFile runner for files in the directory: they inherit its DACL, so no per-file
   * run. Writes wait for the protection; reads of existing ciphertext do not.
   */
  readonly windowsAcl: WindowsAclRunner;
}

/** The protected-directory ACL mode described at the top of this file. */
export function protectedDirectoryAcl(
  directory: string,
  options: { readonly platform?: NodeJS.Platform; readonly harden?: (directory: string) => Promise<void> } = {},
): ProtectedDirectoryAcl {
  const platform = options.platform ?? process.platform;
  const harden = options.harden ?? applyAndVerifyWindowsDirectoryAcl;
  const key = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  let ready: Promise<void> | null = null;
  const prepare = (): Promise<void> => {
    if (platform !== 'win32') return Promise.resolve();
    ready ??= fs.mkdir(directory, { recursive: true })
      .then(() => harden(directory))
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
    return ready;
  };
  return {
    prepare,
    windowsAcl: async (filePath, intent = 'write') => {
      if (key(path.dirname(filePath)) !== key(directory)) {
        throw new Error('Secure file is outside its protected directory.');
      }
      const protection = prepare();
      // A file that already exists keeps its DACL and its DPAPI ciphertext; only files this
      // process creates need the inheritable directory DACL in place first.
      if (intent === 'read') {
        void protection.catch(() => undefined);
        return;
      }
      await protection;
    },
  };
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
    // Wrapped: the default's second parameter is its process runner, not an intent.
    this.windowsAcl = options.windowsAcl ?? ((filePath) => applyAndVerifyWindowsAcl(filePath));
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
      await this.windowsAcl(this.target, 'read');
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
        await this.windowsAcl(tmp, 'write');
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
    await this.protectRequired(filePath, 'read');
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
    await this.protectRequired(filePath, 'read');
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

  private async protectRequired(filePath: string, intent: WindowsAclIntent = 'write'): Promise<void> {
    if (this.platform === 'win32') {
      await this.windowsAcl(filePath, intent);
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
