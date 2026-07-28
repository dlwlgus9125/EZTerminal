/**
 * FileService — main's single fs authority for the file explorer (file-
 * explorer plan, M0). Electron-free (fs/path/os/crypto only): `trashItem` is
 * injected so unit tests run against real temp dirs without touching
 * Electron's `shell`, and `main.ts` wires `shell.trashItem` in later (M1).
 * The same instance is later handed to both the desktop IPC handlers (M1) and
 * the WS bridge's `RemoteFileSource` seam (M3) — this module only implements
 * the fs operations, never electron or protocol framing.
 *
 * Listing never fails wholesale because of one bad entry: `listDirectory`
 * lstats each dirent independently (`Promise.allSettled`) and substitutes
 * `size:0, mtimeMs:0` for any entry that errors (EPERM, raced-away file, ...).
 *
 * Uploads are the one stateful piece: each `beginUpload` opens a `.ezpart`
 * sibling file (`'wx'` — refuses to clobber an existing part) and tracks it
 * in `uploads` until `commitUpload`/`abortUpload` (both idempotent-safe) or a
 * 120s-idle sweep aborts it. `writeUploadChunk` enforces strictly sequential,
 * non-overrunning offsets; any violation aborts the upload rather than
 * leaving a corrupt partial file lying around.
 */
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  DOWNLOAD_MAX_FILE_BYTES,
  FILE_CHUNK_BYTES,
  TEXT_EXTENSIONS,
  TEXT_SNIFF_BYTES,
  TEXT_VIEW_MAX_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  type FileEntry,
  type FileListResult,
  type FileOpResult,
  type FileReadTextResult,
} from '../shared/files';
import {
  IMAGE_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_SNIFF_BYTES,
  looksLikePdf,
  looksLikeSupportedImage,
  parsePreviewImageInfo,
  validatePreviewImage,
  type FilePreviewResult,
  type FilePreviewStreamMetadata,
} from '../shared/file-preview';

export interface FileServiceOptions {
  /** Prod: `(p) => shell.trashItem(p)`, injected by main.ts (M1). Rejection
   * surfaces as `{ok:false}` — NEVER falls back to a permanent delete. */
  trashItem: (fullPath: string) => Promise<void>;
  homeDir?: string;
  newId?: () => string;
}

export interface FileReadStreamMeta {
  readonly fileSize: number;
  readonly sendBytes: number;
  readonly isText: boolean;
  readonly truncated: boolean;
  readonly preview?: FilePreviewStreamMetadata;
}

export interface FileReadStream {
  readonly meta: FileReadStreamMeta;
  next(): Promise<{ offset: number; data: Uint8Array; done: boolean }>;
  close(): Promise<void>;
}

const IDLE_SWEEP_INTERVAL_MS = 60_000;
const UPLOAD_IDLE_TIMEOUT_MS = 120_000;
/** Process-wide ceiling for upload part files/FileHandles. Per-connection
 * limits live in RemoteBridge; this is the final authority across reconnects
 * and every caller sharing one FileService instance. Pending opens reserve a
 * slot before their first filesystem await. */
export const MAX_OPEN_UPLOADS = 64;

const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** `null` = valid. Windows reserved chars/names apply on every platform (a
 * name created on Windows must stay valid — and this repo targets Windows). */
export function validateEntryName(name: string): string | null {
  if (name === '') return 'name cannot be empty';
  if (name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    return 'name cannot contain a path separator';
  }
  if (name === '.' || name === '..') return 'name cannot be "." or ".."';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return 'name contains invalid characters';
  if (RESERVED_DEVICE_NAMES.has(name.split('.')[0].toLowerCase())) {
    return 'name is a reserved device name';
  }
  if (name.endsWith('.') || name.endsWith(' ')) return 'name cannot end with a dot or space';
  if (name.length > 255) return 'name is too long';
  return null;
}

/** `base (1).ext`, `base (2).ext`, ... — dotfiles (`.env`) treat the whole
 * name as the base (`path.extname('.env')` is `''`), yielding `.env (1)`. */
export async function resolveCollisionName(dir: string, name: string): Promise<string> {
  if (!(await pathExists(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await pathExists(path.join(dir, candidate)))) return candidate;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Lookup key for `TEXT_EXTENSIONS`: `'report.txt'` -> `'txt'`,
 * `'.gitignore'` -> `'gitignore'` (dotfile, no further dot), `'Dockerfile'`
 * -> `'dockerfile'` (no extension at all -> the whole basename). */
function textExtKey(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  return ext === '' ? (base.startsWith('.') ? base.slice(1) : base) : ext.slice(1);
}

interface UploadRecord {
  fd: FileHandle;
  readonly partPath: string;
  readonly dir: string;
  readonly finalName: string;
  readonly declaredSize: number;
  /** False as soon as commit/abort becomes the terminal queued operation. */
  acceptingChunks: boolean;
  /** Linearizes every fd mutation for this upload. Always settles. */
  operationTail: Promise<void>;
  receivedBytes: number;
  lastActivity: number;
}

export class FileService {
  private readonly trashItemFn: (fullPath: string) => Promise<void>;
  private readonly homeDir: string;
  private readonly newId: () => string;
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly pendingUploadIds = new Set<string>();
  private readonly pendingUploadBeginSettlements = new Set<Promise<void>>();
  private pendingUploadBegins = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(options: FileServiceOptions) {
    this.trashItemFn = options.trashItem;
    this.homeDir = options.homeDir ?? os.homedir();
    this.newId = options.newId ?? randomUUID;
    this.sweepTimer = setInterval(() => this.sweepIdleUploads(), IDLE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Stops new uploads and drains every pending/active upload exactly once. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    clearInterval(this.sweepTimer);
    this.disposed = true;
    const pendingBegins = [...this.pendingUploadBeginSettlements];
    const activeUploadIds = [...this.uploads.keys()];
    this.disposePromise = (async () => {
      await Promise.all([
        ...activeUploadIds.map((uploadId) => this.abortUpload(uploadId)),
        ...pendingBegins,
      ]);
      // Pending begins observe `disposed` before publishing a record, but a
      // second identity-checked sweep keeps the postcondition explicit.
      await Promise.all([...this.uploads.keys()].map((uploadId) => this.abortUpload(uploadId)));
    })();
    return this.disposePromise;
  }

  // ── browsing ──────────────────────────────────────────────────────────────

  async listDirectory(dirPath: string): Promise<FileListResult> {
    const resolved = path.resolve(dirPath === '' ? this.homeDir : dirPath);
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    // lstat (never follow symlinks) per entry, independently — one failure
    // must not fail the whole listing.
    const stats = await Promise.allSettled(
      dirents.map((dirent) => fs.lstat(path.join(resolved, dirent.name))),
    );
    const entries: FileEntry[] = dirents.map((dirent, i) => {
      const result = stats[i];
      const stat = result.status === 'fulfilled' ? result.value : null;
      return {
        name: dirent.name,
        kind: dirent.isDirectory() ? 'dir' : 'file',
        isSymlink: dirent.isSymbolicLink(),
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
      };
    });
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const dirName = path.dirname(resolved);
    return { ok: true, path: resolved, parent: dirName === resolved ? null : dirName, entries };
  }

  async listRoots(): Promise<string[]> {
    if (process.platform !== 'win32') return ['/'];
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const settled = await Promise.allSettled(
      letters.map((letter) => this.probeRoot(`${letter}:\\`)),
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /** A dead mapped network drive hangs `stat` indefinitely — race it against
   * a timeout so one bad drive letter can't stall the whole probe. */
  private probeRoot(root: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('drive probe timed out')), 1500);
      fs.stat(root).then(
        () => {
          clearTimeout(timer);
          resolve(root);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  // ── text viewer ───────────────────────────────────────────────────────────

  async readTextFile(filePath: string): Promise<FileReadTextResult> {
    const resolved = path.resolve(filePath);
    let handle: FileHandle;
    try {
      handle = await fs.open(resolved, 'r');
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    try {
      const fileSize = (await handle.stat()).size;
      const isText = await this.detectIsText(handle, resolved, fileSize);
      if (!isText) return { ok: true, isText: false, fileSize };
      const readLen = Math.min(fileSize, TEXT_VIEW_MAX_BYTES);
      const buf = Buffer.alloc(readLen);
      if (readLen > 0) await handle.read(buf, 0, readLen, 0);
      const content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return { ok: true, isText: true, content, truncated: fileSize > TEXT_VIEW_MAX_BYTES, fileSize };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      await handle.close();
    }
  }

  /**
   * Rich, read-only preview using magic bytes as the authority. Raster images
   * are bounded before allocation; PDF data never crosses into the renderer;
   * text keeps the existing 1 MiB truncation contract. SVG intentionally
   * falls through to text detection and is never rendered as an image.
   */
  async readFilePreview(filePath: string, authorizedHandle?: FileHandle): Promise<FilePreviewResult> {
    const resolved = path.resolve(filePath);
    const name = path.basename(resolved);
    let handle: FileHandle;
    try {
      handle = authorizedHandle ?? await fs.open(resolved, 'r');
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    try {
      const fileSize = (await handle.stat()).size;
      const sniffLength = Math.min(fileSize, IMAGE_PREVIEW_SNIFF_BYTES);
      const sniff = Buffer.alloc(sniffLength);
      if (sniffLength > 0) await handle.read(sniff, 0, sniffLength, 0);

      const image = parsePreviewImageInfo(sniff);
      if (image) {
        const reason = validatePreviewImage(image, fileSize);
        if (reason) return { ok: true, kind: 'unsupported', name, fileSize, reason };
        // The size was checked before allocation. Recheck every read against
        // the stat'd length so a short/raced file never exposes uninitialized
        // bytes to the renderer.
        const bytes = Buffer.alloc(fileSize);
        let offset = 0;
        while (offset < fileSize) {
          const { bytesRead } = await handle.read(bytes, offset, fileSize - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset !== fileSize || offset > IMAGE_PREVIEW_MAX_BYTES) {
          return { ok: true, kind: 'unsupported', name, fileSize, reason: 'invalid-image' };
        }
        return {
          ok: true,
          kind: 'image',
          name,
          mime: image.mime,
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          width: image.width,
          height: image.height,
          fileSize,
        };
      }
      if (looksLikeSupportedImage(sniff)) {
        return { ok: true, kind: 'unsupported', name, fileSize, reason: 'invalid-image' };
      }
      if (looksLikePdf(sniff)) {
        return { ok: true, kind: 'pdf', name, mime: 'application/pdf', fileSize };
      }

      const isText = await this.detectIsText(handle, resolved, fileSize);
      if (!isText) return { ok: true, kind: 'unsupported', name, fileSize, reason: 'binary' };
      const readLen = Math.min(fileSize, TEXT_VIEW_MAX_BYTES);
      const buf = Buffer.alloc(readLen);
      if (readLen > 0) await handle.read(buf, 0, readLen, 0);
      const content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const extension = path.extname(resolved).toLowerCase();
      return {
        ok: true,
        kind: 'text',
        name,
        mime: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain',
        content,
        truncated: fileSize > TEXT_VIEW_MAX_BYTES,
        fileSize,
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      await handle.close();
    }
  }

  /** For the M3 bridge: streams a file in `FILE_CHUNK_BYTES` slices instead
   * of buffering it whole. `'text'` mode applies the same detection as
   * `readTextFile` (binary -> `sendBytes:0`, caller must not call `next()`);
   * `'preview'` mode adds the same magic-first classification as
   * `readFilePreview`; `'raw'` mode (downloads) skips detection but enforces
   * the download cap. */
  async openReadStream(
    filePath: string,
    mode: 'text' | 'raw' | 'preview',
    authorizedHandle?: FileHandle,
    signal?: AbortSignal,
  ): Promise<{ ok: false; error: string } | ({ ok: true } & FileReadStream)> {
    const resolved = path.resolve(filePath);
    let handle: FileHandle;
    try {
      handle = authorizedHandle ?? await fs.open(resolved, 'r');
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    let closePromise: Promise<void> | null = null;
    const closeHandle = async (): Promise<void> => {
      closePromise ??= handle.close();
      await closePromise;
    };
    const abortOpen = (): void => {
      void closeHandle().catch(() => undefined);
    };
    signal?.addEventListener('abort', abortOpen, { once: true });
    if (signal?.aborted) {
      await closeHandle().catch(() => undefined);
      signal.removeEventListener('abort', abortOpen);
      return { ok: false, error: 'file read cancelled' };
    }
    let fileSize: number;
    let isText = true;
    let sendBytes: number;
    let truncated = false;
    let preview: FilePreviewStreamMetadata | undefined;
    // A post-open failure here (file deleted/EPERM-raced between open and
    // stat) must not leak `handle` or reject this promise — same containment
    // pattern as readTextFile.
    try {
      fileSize = (await handle.stat()).size;
      sendBytes = fileSize;
      if (mode === 'preview') {
        const name = path.basename(resolved);
        const sniffLength = Math.min(fileSize, IMAGE_PREVIEW_SNIFF_BYTES);
        const sniff = Buffer.alloc(sniffLength);
        if (sniffLength > 0) await handle.read(sniff, 0, sniffLength, 0);
        const image = parsePreviewImageInfo(sniff);
        if (image) {
          const reason = validatePreviewImage(image, fileSize);
          if (reason) {
            preview = { kind: 'unsupported', name, reason };
            isText = false;
            sendBytes = 0;
          } else {
            preview = { kind: 'image', name, mime: image.mime, width: image.width, height: image.height };
            isText = false;
            sendBytes = fileSize;
          }
        } else if (looksLikeSupportedImage(sniff)) {
          preview = { kind: 'unsupported', name, reason: 'invalid-image' };
          isText = false;
          sendBytes = 0;
        } else if (looksLikePdf(sniff)) {
          preview = { kind: 'pdf', name, mime: 'application/pdf' };
          isText = false;
          sendBytes = 0;
        } else {
          isText = await this.detectIsText(handle, resolved, fileSize);
          if (isText) {
            const extension = path.extname(resolved).toLowerCase();
            preview = {
              kind: 'text',
              name,
              mime: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain',
            };
            sendBytes = Math.min(fileSize, TEXT_VIEW_MAX_BYTES);
            truncated = fileSize > TEXT_VIEW_MAX_BYTES;
          } else {
            preview = { kind: 'unsupported', name, reason: 'binary' };
            sendBytes = 0;
          }
        }
      } else if (mode === 'text') {
        isText = await this.detectIsText(handle, resolved, fileSize);
        sendBytes = isText ? Math.min(fileSize, TEXT_VIEW_MAX_BYTES) : 0;
        truncated = isText && fileSize > TEXT_VIEW_MAX_BYTES;
      } else if (fileSize > DOWNLOAD_MAX_FILE_BYTES) {
        await closeHandle();
        signal?.removeEventListener('abort', abortOpen);
        return { ok: false, error: `file exceeds the ${DOWNLOAD_MAX_FILE_BYTES}-byte download limit` };
      }
    } catch (err) {
      await closeHandle().catch(() => undefined);
      signal?.removeEventListener('abort', abortOpen);
      return { ok: false, error: errorMessage(err) };
    }

    let sent = 0;
    return {
      ok: true,
      meta: { fileSize, sendBytes, isText, truncated, ...(preview ? { preview } : {}) },
      next: async () => {
        if (signal?.aborted || closePromise) throw new Error('file read cancelled');
        const len = Math.min(FILE_CHUNK_BYTES, sendBytes - sent);
        const buf = Buffer.alloc(len);
        let bytesRead = 0;
        while (bytesRead < len) {
          if (signal?.aborted || closePromise) throw new Error('file read cancelled');
          const result = await handle.read(
            buf,
            bytesRead,
            len - bytesRead,
            sent + bytesRead,
          );
          if (result.bytesRead === 0) {
            throw new Error('file changed during read');
          }
          bytesRead += result.bytesRead;
        }
        const offset = sent;
        sent += len;
        return { offset, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), done: sent >= sendBytes };
      },
      close: async () => {
        signal?.removeEventListener('abort', abortOpen);
        await closeHandle();
      },
    };
  }

  /** Shared by `readTextFile` and `openReadStream`: whitelisted extension ->
   * always text; otherwise sniff the first `TEXT_SNIFF_BYTES` for a NUL byte. */
  private async detectIsText(handle: FileHandle, resolvedPath: string, fileSize: number): Promise<boolean> {
    if (TEXT_EXTENSIONS.has(textExtKey(resolvedPath))) return true;
    const sniffLen = Math.min(fileSize, TEXT_SNIFF_BYTES);
    if (sniffLen === 0) return true;
    const buf = Buffer.alloc(sniffLen);
    await handle.read(buf, 0, sniffLen, 0);
    return !buf.includes(0);
  }

  // ── mutating ops ──────────────────────────────────────────────────────────

  async createFolder(dirPath: string, name: string): Promise<FileOpResult> {
    const nameErr = validateEntryName(name);
    if (nameErr) return { ok: false, error: nameErr };
    try {
      await fs.mkdir(path.join(path.resolve(dirPath), name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async renameEntry(entryPath: string, newName: string): Promise<FileOpResult> {
    const nameErr = validateEntryName(newName);
    if (nameErr) return { ok: false, error: nameErr };
    const resolved = path.resolve(entryPath);
    try {
      await fs.rename(resolved, path.join(path.dirname(resolved), newName));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /** Delegates to the injected `trashItem` ONLY — never falls back to a
   * permanent delete when that rejects (security note in the plan). */
  async trashEntry(entryPath: string): Promise<FileOpResult> {
    try {
      await this.trashItemFn(path.resolve(entryPath));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  // ── upload lifecycle ──────────────────────────────────────────────────────

  async beginUpload(
    dirPath: string,
    name: string,
    size: number,
  ): Promise<{ ok: true; uploadId: string; finalName: string } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: 'file service is disposed' };
    const nameErr = validateEntryName(name);
    if (nameErr) return { ok: false, error: nameErr };
    if (!Number.isInteger(size) || size < 0 || size > UPLOAD_MAX_FILE_BYTES) {
      return { ok: false, error: `size must be an integer between 0 and ${UPLOAD_MAX_FILE_BYTES} bytes` };
    }
    if (this.uploads.size + this.pendingUploadBegins >= MAX_OPEN_UPLOADS) {
      return { ok: false, error: 'too many active uploads' };
    }

    // Reserve synchronously. Without this counter, a burst of begin calls can
    // all pass the Map-size check before any fs.stat/open promise settles.
    this.pendingUploadBegins += 1;
    let settleBegin!: () => void;
    const beginSettlement = new Promise<void>((resolve) => {
      settleBegin = resolve;
    });
    this.pendingUploadBeginSettlements.add(beginSettlement);
    try {
      const dir = path.resolve(dirPath);
      try {
        const dirStat = await fs.stat(dir);
        if (!dirStat.isDirectory()) return { ok: false, error: 'not a directory' };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }

      const finalName = await resolveCollisionName(dir, name);
      if (this.disposed) return { ok: false, error: 'file service is disposed' };
      const uploadId = this.newId();
      if (this.uploads.has(uploadId) || this.pendingUploadIds.has(uploadId)) {
        return { ok: false, error: 'upload id collision' };
      }
      // Reserve the identifier before fs.open's await. Otherwise two parallel
      // begins can both pass uploads.has(), open distinct part files, and have
      // the later Map.set overwrite the first record.
      this.pendingUploadIds.add(uploadId);
      try {
        const partPath = path.join(dir, `${finalName}.${uploadId}.ezpart`);
        let fd: FileHandle;
        try {
          fd = await fs.open(partPath, 'wx');
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }
        if (this.disposed) {
          await fd.close().catch(() => undefined);
          await fs.unlink(partPath).catch(() => undefined);
          return { ok: false, error: 'file service is disposed' };
        }
        this.uploads.set(uploadId, {
          fd,
          partPath,
          dir,
          finalName,
          declaredSize: size,
          acceptingChunks: true,
          operationTail: Promise.resolve(),
          receivedBytes: 0,
          lastActivity: Date.now(),
        });
        return { ok: true, uploadId, finalName };
      } finally {
        this.pendingUploadIds.delete(uploadId);
      }
    } finally {
      this.pendingUploadBegins -= 1;
      this.pendingUploadBeginSettlements.delete(beginSettlement);
      settleBegin();
    }
  }

  /** Rejects (and auto-aborts) an out-of-order or size-overrunning chunk —
   * offsets must arrive strictly sequential, never overrunning the declared
   * size, so a corrupt partial file never lingers past this call. */
  async writeUploadChunk(
    uploadId: string,
    offset: number,
    data: Uint8Array,
  ): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }> {
    const record = this.uploads.get(uploadId);
    if (!record || !record.acceptingChunks) return { ok: false, error: 'unknown uploadId' };

    const result = record.operationTail.then(async (): Promise<
      { ok: true; receivedBytes: number } | { ok: false; error: string }
    > => {
      if (this.uploads.get(uploadId) !== record) {
        return { ok: false, error: 'unknown uploadId' };
      }
      if (offset !== record.receivedBytes || record.receivedBytes + data.length > record.declaredSize) {
        await this.abortUploadRecord(uploadId, record);
        return { ok: false, error: 'out-of-order or size-overrunning chunk' };
      }
      try {
        let written = 0;
        while (written < data.length) {
          const write = await record.fd.write(
            data,
            written,
            data.length - written,
            offset + written,
          );
          if (write.bytesWritten === 0) throw new Error('upload write made no progress');
          written += write.bytesWritten;
        }
      } catch (err) {
        await this.abortUploadRecord(uploadId, record);
        return { ok: false, error: errorMessage(err) };
      }
      record.receivedBytes += data.length;
      record.lastActivity = Date.now();
      return { ok: true, receivedBytes: record.receivedBytes };
    });
    record.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async commitUpload(
    uploadId: string,
  ): Promise<{ ok: true; finalName: string } | { ok: false; error: string }> {
    const record = this.uploads.get(uploadId);
    if (!record || !record.acceptingChunks) return { ok: false, error: 'unknown uploadId' };
    // No chunk arriving after this call may slip ahead of the terminal commit.
    // Chunks already queued on operationTail remain part of the upload.
    record.acceptingChunks = false;
    const result = record.operationTail.then(async (): Promise<
      { ok: true; finalName: string } | { ok: false; error: string }
    > => {
      if (this.uploads.get(uploadId) !== record) {
        return { ok: false, error: 'unknown uploadId' };
      }
      if (record.receivedBytes !== record.declaredSize) {
        await this.abortUploadRecord(uploadId, record);
        return { ok: false, error: 'upload is incomplete' };
      }
      try {
        await record.fd.close().catch(() => undefined);

        // Re-probe: another upload/create may have taken `finalName` while this
        // one was in flight.
        let finalName = await resolveCollisionName(record.dir, record.finalName);
        try {
          await fs.rename(record.partPath, path.join(record.dir, finalName));
        } catch (err) {
          if (!isEexist(err)) throw err;
          finalName = await resolveCollisionName(record.dir, record.finalName);
          await fs.rename(record.partPath, path.join(record.dir, finalName));
        }
        return { ok: true, finalName };
      } catch (err) {
        await fs.unlink(record.partPath).catch(() => undefined);
        return { ok: false, error: errorMessage(err) };
      } finally {
        // The global ceiling describes real open/terminating resources, not
        // merely records still accepting chunks. Release only after close and
        // rename/unlink have fully settled.
        if (this.uploads.get(uploadId) === record) this.uploads.delete(uploadId);
      }
    });
    record.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Idempotent: safe to call more than once (close-teardown + a 2nd caller
   * racing an idle sweep both hit the "already gone" branch harmlessly). */
  async abortUpload(uploadId: string): Promise<void> {
    const record = this.uploads.get(uploadId);
    if (!record) return;
    if (!record.acceptingChunks) {
      await record.operationTail;
      return;
    }
    record.acceptingChunks = false;
    const result = record.operationTail.then(() => this.abortUploadRecord(uploadId, record));
    record.operationTail = result.then(() => undefined, () => undefined);
    await result;
  }

  private async abortUploadRecord(uploadId: string, record: UploadRecord): Promise<void> {
    record.acceptingChunks = false;
    await record.fd.close().catch(() => undefined);
    await fs.unlink(record.partPath).catch(() => undefined);
    if (this.uploads.get(uploadId) === record) this.uploads.delete(uploadId);
  }

  private sweepIdleUploads(): void {
    const now = Date.now();
    for (const [uploadId, record] of [...this.uploads.entries()]) {
      if (
        record.acceptingChunks
        && now - record.lastActivity > UPLOAD_IDLE_TIMEOUT_MS
      ) {
        void this.abortUpload(uploadId);
      }
    }
  }
}
