import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const RUNTIME_PREFIX = 'runtime-';
const BASE_DIRECTORY_NAME = 'ezterminal-output-retention-v1';

export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 * MEBIBYTE;

export interface OutputRetentionLimits {
  readonly segmentBytes: number;
  readonly segmentRows: number;
  readonly perRunHotBytes: number;
  readonly globalHotBytes: number;
  readonly perRunSpillBytes: number;
  readonly globalSpillBytes: number;
}

export const DEFAULT_OUTPUT_RETENTION_LIMITS: OutputRetentionLimits = Object.freeze({
  segmentBytes: 4 * MEBIBYTE,
  segmentRows: 4_096,
  perRunHotBytes: 8 * MEBIBYTE,
  globalHotBytes: 128 * MEBIBYTE,
  perRunSpillBytes: 512 * MEBIBYTE,
  globalSpillBytes: 2 * GIBIBYTE,
});

interface HotCacheEntry {
  readonly bytes: number;
  readonly evict: () => void;
}

export interface OutputRetentionRuntimeOptions {
  /** Parent directory override used by tests. Production uses the OS temp dir. */
  readonly baseDirectory?: string;
  readonly globalHotBytes?: number;
  readonly globalSpillBytes?: number;
  /** Production cleans synchronously on process exit; tests disable the hook. */
  readonly registerExitCleanup?: boolean;
}

/**
 * Process-wide quota and lifecycle owner for structured-output spill files.
 *
 * `hotBytes` tracks persistent decoded rows and in-progress segment builders.
 * A read may briefly allocate a transient segment in order to serve a viewport,
 * but transient rows are never retained when the quota cannot be reserved.
 */
export class OutputRetentionRuntime {
  readonly directory: string;
  readonly globalHotLimit: number;
  readonly globalSpillLimit: number;

  private hotBytes = 0;
  private spillBytes = 0;
  private readonly caches = new Map<string, HotCacheEntry>();
  private cleaned = false;
  private readonly onExit: (() => void) | null;

  constructor(options: OutputRetentionRuntimeOptions = {}) {
    this.globalHotLimit = positiveInteger(
      options.globalHotBytes ?? DEFAULT_OUTPUT_RETENTION_LIMITS.globalHotBytes,
      'globalHotBytes',
    );
    this.globalSpillLimit = positiveInteger(
      options.globalSpillBytes ?? DEFAULT_OUTPUT_RETENTION_LIMITS.globalSpillBytes,
      'globalSpillBytes',
    );

    const baseDirectory = options.baseDirectory
      ?? join(tmpdir(), BASE_DIRECTORY_NAME);
    ensurePrivateDirectory(baseDirectory);
    pruneOrphanRuntimeDirectories(baseDirectory);

    this.directory = join(
      baseDirectory,
      `${RUNTIME_PREFIX}${process.pid}-${randomBytes(16).toString('hex')}`,
    );
    ensurePrivateDirectory(this.directory);

    if (options.registerExitCleanup === false) {
      this.onExit = null;
    } else {
      this.onExit = () => this.cleanupSync();
      process.once('exit', this.onExit);
    }
  }

  createRunDirectory(): string {
    this.assertActive();
    for (;;) {
      const directory = join(this.directory, `run-${randomBytes(16).toString('hex')}`);
      try {
        mkdirSync(directory, { mode: 0o700 });
        chmodBestEffort(directory, 0o700);
        return directory;
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) continue;
        throw error;
      }
    }
  }

  /**
   * Reserve persistent hot memory. Oldest decoded segment caches are evicted
   * first. Returns false only when active (non-evictable) builders consume the
   * remaining quota; callers then write without retaining a decoded copy.
   */
  reserveHot(bytes: number): boolean {
    this.assertActive();
    const safeBytes = nonNegativeInteger(bytes, 'hot bytes');
    if (safeBytes > this.globalHotLimit) return false;
    while (this.hotBytes + safeBytes > this.globalHotLimit) {
      const oldest = this.caches.keys().next();
      if (oldest.done) return false;
      this.evictCache(oldest.value);
    }
    this.hotBytes += safeBytes;
    return true;
  }

  releaseHot(bytes: number): void {
    const safeBytes = nonNegativeInteger(bytes, 'hot bytes');
    this.hotBytes = Math.max(0, this.hotBytes - safeBytes);
  }

  /**
   * Register an already-reserved decoded segment as evictable LRU state.
   * Re-registering the same key is a programming error rather than a silent
   * accounting change.
   */
  registerCache(key: string, bytes: number, evict: () => void): void {
    this.assertActive();
    if (this.caches.has(key)) throw new Error(`Output cache key already registered: ${key}`);
    this.caches.set(key, { bytes: nonNegativeInteger(bytes, 'cache bytes'), evict });
  }

  touchCache(key: string): void {
    const entry = this.caches.get(key);
    if (!entry) return;
    this.caches.delete(key);
    this.caches.set(key, entry);
  }

  evictCache(key: string): void {
    const entry = this.caches.get(key);
    if (!entry) return;
    this.caches.delete(key);
    this.hotBytes = Math.max(0, this.hotBytes - entry.bytes);
    entry.evict();
  }

  reserveSpill(bytes: number): boolean {
    this.assertActive();
    const safeBytes = nonNegativeInteger(bytes, 'spill bytes');
    if (safeBytes > this.globalSpillLimit - this.spillBytes) return false;
    this.spillBytes += safeBytes;
    return true;
  }

  releaseSpill(bytes: number): void {
    const safeBytes = nonNegativeInteger(bytes, 'spill bytes');
    this.spillBytes = Math.max(0, this.spillBytes - safeBytes);
  }

  diagnostics(): { readonly hotBytes: number; readonly spillBytes: number; readonly caches: number } {
    return {
      hotBytes: this.hotBytes,
      spillBytes: this.spillBytes,
      caches: this.caches.size,
    };
  }

  cleanupSync(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.onExit) process.removeListener('exit', this.onExit);
    this.caches.clear();
    this.hotBytes = 0;
    this.spillBytes = 0;
    rmSync(this.directory, { recursive: true, force: true });
  }

  private assertActive(): void {
    if (this.cleaned) throw new Error('Output retention runtime is already disposed');
  }
}

let defaultRuntime: OutputRetentionRuntime | null = null;

export function getDefaultOutputRetentionRuntime(): OutputRetentionRuntime {
  defaultRuntime ??= new OutputRetentionRuntime();
  return defaultRuntime;
}

/**
 * Removes only directories whose encoded owner PID is no longer alive. An
 * access-denied process probe is treated as alive, so another user's active
 * EZTerminal utility process is never removed.
 */
export function pruneOrphanRuntimeDirectories(baseDirectory: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUNTIME_PREFIX)) continue;
    const match = /^runtime-(\d+)-[a-f0-9]{32}$/.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processIsAlive(pid)) continue;
    try {
      rmSync(join(baseDirectory, entry.name), { recursive: true, force: true });
    } catch {
      // Windows can keep a just-exited worker's files locked briefly. Startup
      // cleanup is best-effort; a later runtime will retry the same dead PID.
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM') || isNodeError(error, 'EACCES');
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodBestEffort(directory, 0o700);
  const stat = statSync(directory);
  if (!stat.isDirectory()) throw new Error(`Output retention path is not a directory: ${directory}`);
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    // Windows filesystems may not implement POSIX permission bits. Production
    // therefore relies on the inherited ACL of the current user's temp
    // directory plus unguessable names; this is not claimed as an explicit DACL.
    if (process.platform !== 'win32') throw error;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
