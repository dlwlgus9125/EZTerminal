/**
 * Local-only crash/diagnostics plumbing (B-M5).
 *
 * Privacy default: NOTHING leaves the machine. Minidumps stay in Electron's
 * local crashDumps dir (crashReporter runs with uploadToServer:false and no
 * submitURL — wired in main.ts); errors append to userData/logs/main.log.
 * An external crash service (e.g. Sentry) is a documented opt-in DECISION,
 * deliberately not implemented.
 *
 * Electron-free (fs/path only): dirs are injected so unit tests use temp dirs.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  promises as fsp,
  renameSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

/** Rotate when main.log exceeds this. One rotated generation is kept (.1). */
export const LOG_MAX_BYTES = 512 * 1024;

/** Crash dumps kept by the prune (proposed default — plan decision #4). */
export const DUMPS_KEPT = 10;

/**
 * Append-only log with size-cap rotation: main.log → main.log.1 (previous .1
 * is overwritten). Sync appends — call sites are rare failure paths where
 * losing the line to an async race would defeat the purpose.
 */
export class LogFile {
  private readonly file: string;
  private readonly maxBytes: number;

  constructor(file: string, maxBytes: number = LOG_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
  }

  get path(): string {
    return this.file;
  }

  line(message: string): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      // Diagnostics must never crash the app they diagnose.
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) {
        renameSync(this.file, `${this.file}.1`); // replaces the previous .1
      }
    } catch {
      // Rotation is best-effort; appends continue on the current file.
    }
  }
}

/**
 * Keep only the newest `keep` files in the crash-dumps tree (recursive —
 * Crashpad nests reports under subdirs). Never deletes directories.
 */
export async function pruneCrashDumps(dumpsDir: string, keep: number = DUMPS_KEPT): Promise<void> {
  let files: Array<{ file: string; mtime: number }> = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir absent — nothing to prune
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && /\.dmp$/i.test(entry.name)) {
        try {
          files.push({ file: abs, mtime: (await fsp.stat(abs)).mtimeMs });
        } catch {
          // raced away — skip
        }
      }
    }
  }
  await walk(dumpsDir);
  files = files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(keep)) {
    await fsp.unlink(file).catch(() => undefined);
  }
}
