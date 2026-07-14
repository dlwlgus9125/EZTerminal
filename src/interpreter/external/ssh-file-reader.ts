import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

export const SSH_PRIVATE_KEY_MAX_BYTES = 1024 * 1024;

export type BoundedFileReadFailure =
  | 'changed'
  | 'not-regular'
  | 'symlink'
  | 'too-large'
  | 'unverifiable';

export class BoundedFileReadError extends Error {
  override readonly name = 'BoundedFileReadError';

  constructor(
    readonly reason: BoundedFileReadFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface BoundedRegularFile {
  readonly canonicalPath: string;
  readonly bytes: Buffer;
}

function fail(reason: BoundedFileReadFailure, label: string, filePath: string, detail: string): never {
  throw new BoundedFileReadError(reason, `${label} ${detail}: ${filePath}`);
}

function validatePathStat(stats: BigIntStats, label: string, filePath: string, maxBytes: number): void {
  if (stats.isSymbolicLink()) {
    fail('symlink', label, filePath, 'must not be a symbolic link or reparse point');
  }
  if (!stats.isFile()) fail('not-regular', label, filePath, 'is not a regular file');
  if (stats.size > BigInt(maxBytes)) fail('too-large', label, filePath, `exceeds ${maxBytes} bytes`);
  // A zero inode means this filesystem cannot provide the stable identity
  // needed to close the lstat/open race. Reject instead of guessing.
  if (stats.ino === 0n) fail('unverifiable', label, filePath, 'identity could not be verified');
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/**
 * Read one regular file without following a final symlink and without ever
 * allocating more than maxBytes. The path and opened fd are checked before and
 * after the bounded positional read so a swap is rejected rather than followed.
 */
export async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<BoundedRegularFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const before = await lstat(filePath, { bigint: true });
  validatePathStat(before, label, filePath, maxBytes);
  const canonicalPath = await realpath(filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);

  try {
    const opened = await handle.stat({ bigint: true });
    validatePathStat(opened, label, filePath, maxBytes);
    if (!sameSnapshot(before, opened)) {
      fail('changed', label, filePath, 'changed before it could be opened');
    }

    const expectedSize = Number(opened.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const result = await handle.read(bytes, offset, expectedSize - offset, offset);
      if (result.bytesRead === 0) {
        fail('changed', label, filePath, 'changed while it was being read');
      }
      offset += result.bytesRead;
    }

    // A file may grow after fstat. Probe exactly one byte beyond the bounded
    // allocation and reject any growth instead of switching to readFile().
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, expectedSize)).bytesRead !== 0) {
      const reason = expectedSize >= maxBytes ? 'too-large' : 'changed';
      const detail = reason === 'too-large'
        ? `exceeds ${maxBytes} bytes`
        : 'changed while it was being read';
      fail(reason, label, filePath, detail);
    }

    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    validatePathStat(afterHandle, label, filePath, maxBytes);
    validatePathStat(afterPath, label, filePath, maxBytes);
    const canonicalAfter = await realpath(filePath);
    if (
      canonicalAfter !== canonicalPath
      || !sameSnapshot(opened, afterHandle)
      || !sameSnapshot(afterHandle, afterPath)
    ) {
      fail('changed', label, filePath, 'changed while it was being read');
    }

    return { canonicalPath, bytes };
  } finally {
    await handle.close();
  }
}

export async function readSshPrivateKeyFile(filePath: string): Promise<Buffer> {
  const result = await readBoundedRegularFile(
    filePath,
    SSH_PRIVATE_KEY_MAX_BYTES,
    'SSH private key',
  );
  return result.bytes;
}
