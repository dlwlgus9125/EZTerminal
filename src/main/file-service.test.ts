import { promises as fs, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_MAX_FILE_BYTES, FILE_CHUNK_BYTES, TEXT_VIEW_MAX_BYTES, UPLOAD_MAX_FILE_BYTES } from '../shared/files';
import { FileService, resolveCollisionName, validateEntryName, type FileServiceOptions } from './file-service';

// Probed once at collection time (sync) so `it.skipIf` has its condition
// before any test runs — Windows without symlink privilege is expected here.
const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'ezfs-symlink-probe-'));
  try {
    writeFileSync(path.join(probe, 'a'), 'x');
    symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const tempDirs: string[] = [];
const services: FileService[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezfs-'));
  tempDirs.push(dir);
  return dir;
}

function makeService(overrides: Partial<FileServiceOptions> = {}): FileService {
  const service = new FileService({ trashItem: vi.fn().mockResolvedValue(undefined), ...overrides });
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('FileService.listDirectory', () => {
  it('sorts folders first, then names ascending', async () => {
    const dir = await makeDir();
    await fs.mkdir(path.join(dir, 'zdir'));
    await fs.mkdir(path.join(dir, 'adir'));
    await fs.writeFile(path.join(dir, 'bfile.txt'), 'x');
    await fs.writeFile(path.join(dir, 'afile.txt'), 'x');

    const result = await makeService().listDirectory(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toEqual(['adir', 'zdir', 'afile.txt', 'bfile.txt']);
  });

  it('includes dotfiles in the listing', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, '.env'), 'x');

    const result = await makeService().listDirectory(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toContain('.env');
  });

  it.skipIf(!CAN_SYMLINK)('flags a symlink entry as isSymlink', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'target.txt'), 'x');
    await fs.symlink(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'));

    const result = await makeService().listDirectory(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const link = result.entries.find((e) => e.name === 'link.txt');
    expect(link?.isSymlink).toBe(true);
  });

  it('parent is null at the filesystem root', async () => {
    const root = path.parse(process.cwd()).root;
    const result = await makeService().listDirectory(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parent).toBeNull();
  });

  it("'' resolves to the injected homeDir", async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'marker.txt'), 'x');

    const result = await makeService({ homeDir: dir }).listDirectory('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.resolve(dir));
    expect(result.entries.map((e) => e.name)).toContain('marker.txt');
  });

  it('keeps the listing alive when one entry fails lstat', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'good.txt'), 'x');
    await fs.writeFile(path.join(dir, 'bad.txt'), 'x');

    const originalLstat = fs.lstat.bind(fs);
    const spy = vi
      .spyOn(fs, 'lstat')
      .mockImplementation(((target: Parameters<typeof fs.lstat>[0], ...rest: unknown[]) => {
        if (String(target).endsWith('bad.txt')) return Promise.reject(new Error('EPERM (simulated)'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalLstat as any)(target, ...rest);
      }) as typeof fs.lstat);

    try {
      const result = await makeService().listDirectory(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entries.map((e) => e.name)).toEqual(['bad.txt', 'good.txt']);
      const bad = result.entries.find((e) => e.name === 'bad.txt');
      expect(bad).toMatchObject({ size: 0, mtimeMs: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FileService.readTextFile — text detection', () => {
  it('a whitelisted extension is always text, even with NUL bytes', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'weird.txt'), Buffer.from([0x00, 0x41, 0x42]));

    const result = await makeService().readTextFile(path.join(dir, 'weird.txt'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isText).toBe(true);
  });

  it('an unknown extension without NUL bytes is treated as text', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'data.xyz'), 'hello world');

    const result = await makeService().readTextFile(path.join(dir, 'data.xyz'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isText).toBe(true);
  });

  it('an unknown extension with a NUL byte in the first 8KiB is binary', async () => {
    const dir = await makeDir();
    const buf = Buffer.alloc(100, 0x41);
    buf[50] = 0x00;
    await fs.writeFile(path.join(dir, 'data.xyz'), buf);

    const result = await makeService().readTextFile(path.join(dir, 'data.xyz'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isText).toBe(false);
  });

  it('truncates content over 1MiB and reports truncated:true', async () => {
    const dir = await makeDir();
    const big = Buffer.alloc(TEXT_VIEW_MAX_BYTES + 1000, 0x61);
    await fs.writeFile(path.join(dir, 'big.txt'), big);

    const result = await makeService().readTextFile(path.join(dir, 'big.txt'));
    expect(result.ok).toBe(true);
    if (result.ok && result.isText) {
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(TEXT_VIEW_MAX_BYTES);
      expect(result.fileSize).toBe(TEXT_VIEW_MAX_BYTES + 1000);
    }
  });
});

describe('validateEntryName', () => {
  it.each([['../x'], ['a/b'], ['a\\b'], ['con'], ['CON.txt'], ['name.'], ['name '], [''], ['x'.repeat(257)]])(
    'rejects %j',
    (name) => {
      expect(validateEntryName(name)).not.toBeNull();
    },
  );

  it.each(['report.txt', 'my-folder', '.gitignore', 'a.b.c.tar.gz'])('accepts %j', (name) => {
    expect(validateEntryName(name)).toBeNull();
  });
});

describe('resolveCollisionName', () => {
  it('chains report.txt -> report (1).txt -> report (2).txt', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'report.txt'), 'x');
    expect(await resolveCollisionName(dir, 'report.txt')).toBe('report (1).txt');

    await fs.writeFile(path.join(dir, 'report (1).txt'), 'x');
    expect(await resolveCollisionName(dir, 'report.txt')).toBe('report (2).txt');
  });

  it('handles dotfiles: .env -> .env (1)', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, '.env'), 'x');
    expect(await resolveCollisionName(dir, '.env')).toBe('.env (1)');
  });
});

describe('FileService upload lifecycle', () => {
  it('uploads a file across 3 chunks and commits with identical bytes', async () => {
    const dir = await makeDir();
    const service = makeService();
    const chunks = [Buffer.from('hello '), Buffer.from('brave '), Buffer.from('world!')];
    const size = chunks.reduce((n, c) => n + c.length, 0);

    const begin = await service.beginUpload(dir, 'greeting.txt', size);
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;

    let offset = 0;
    for (const chunk of chunks) {
      const res = await service.writeUploadChunk(begin.uploadId, offset, chunk);
      expect(res.ok).toBe(true);
      offset += chunk.length;
    }

    const commit = await service.commitUpload(begin.uploadId);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const written = await fs.readFile(path.join(dir, commit.finalName));
    expect(written).toEqual(Buffer.concat(chunks));
  });

  it('rejects an out-of-order chunk offset and auto-aborts the upload', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'x.txt', 10);
    if (!begin.ok) throw new Error('begin failed');

    const res = await service.writeUploadChunk(begin.uploadId, 5, Buffer.from('abcde'));
    expect(res.ok).toBe(false);

    const entries = await fs.readdir(dir);
    expect(entries.some((n) => n.includes('.ezpart'))).toBe(false);

    const again = await service.writeUploadChunk(begin.uploadId, 0, Buffer.from('a'));
    expect(again.ok).toBe(false);
  });

  it('rejects a chunk that would exceed the declared size', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'x.txt', 5);
    if (!begin.ok) throw new Error('begin failed');

    const res = await service.writeUploadChunk(begin.uploadId, 0, Buffer.from('too long'));
    expect(res.ok).toBe(false);
  });

  it('rejects beginUpload with size over the 50MiB cap', async () => {
    const dir = await makeDir();
    const begin = await makeService().beginUpload(dir, 'x.bin', UPLOAD_MAX_FILE_BYTES + 1);
    expect(begin.ok).toBe(false);
  });

  it('abortUpload unlinks the .ezpart file', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'x.txt', 5);
    if (!begin.ok) throw new Error('begin failed');

    const before = await fs.readdir(dir);
    expect(before.some((n) => n.includes('.ezpart'))).toBe(true);

    await service.abortUpload(begin.uploadId);
    const after = await fs.readdir(dir);
    expect(after.some((n) => n.includes('.ezpart'))).toBe(false);
  });

  it('abortUpload is idempotent', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'x.txt', 5);
    if (!begin.ok) throw new Error('begin failed');

    await service.abortUpload(begin.uploadId);
    await expect(service.abortUpload(begin.uploadId)).resolves.toBeUndefined();
  });

  it('re-probes for a collision that appears between begin and commit', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'race.txt', 3);
    if (!begin.ok) throw new Error('begin failed');
    expect(begin.finalName).toBe('race.txt');

    await fs.writeFile(path.join(dir, 'race.txt'), 'preexisting'); // appears mid-flight
    await service.writeUploadChunk(begin.uploadId, 0, Buffer.from('abc'));

    const commit = await service.commitUpload(begin.uploadId);
    expect(commit.ok).toBe(true);
    if (commit.ok) expect(commit.finalName).toBe('race (1).txt');
  });
});

describe('FileService.trashEntry', () => {
  it('calls the injected trashItem with the resolved path', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'gone.txt');
    await fs.writeFile(file, 'x');
    const trashItem = vi.fn().mockResolvedValue(undefined);

    const result = await makeService({ trashItem }).trashEntry(file);
    expect(result.ok).toBe(true);
    expect(trashItem).toHaveBeenCalledWith(path.resolve(file));
  });

  it('surfaces a trashItem rejection without deleting the file', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'stays.txt');
    await fs.writeFile(file, 'x');
    const trashItem = vi.fn().mockRejectedValue(new Error('denied'));

    const result = await makeService({ trashItem }).trashEntry(file);
    expect(result.ok).toBe(false);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });
});

describe('FileService.openReadStream', () => {
  it("text mode on a binary file returns isText:false, sendBytes:0", async () => {
    const dir = await makeDir();
    const buf = Buffer.alloc(100, 0x41);
    buf[10] = 0x00;
    await fs.writeFile(path.join(dir, 'bin.xyz'), buf);

    const stream = await makeService().openReadStream(path.join(dir, 'bin.xyz'), 'text');
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    expect(stream.meta.isText).toBe(false);
    expect(stream.meta.sendBytes).toBe(0);
    await stream.close();
  });

  it('raw mode reassembles exactly across chunks', async () => {
    const dir = await makeDir();
    const data = crypto.randomBytes(FILE_CHUNK_BYTES * 2 + 100);
    await fs.writeFile(path.join(dir, 'blob.bin'), data);

    const stream = await makeService().openReadStream(path.join(dir, 'blob.bin'), 'raw');
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;

    const parts: Buffer[] = [];
    let done = false;
    while (!done) {
      const chunk = await stream.next();
      parts.push(Buffer.from(chunk.data));
      done = chunk.done;
    }
    await stream.close();
    expect(Buffer.concat(parts)).toEqual(data);
  });

  it('raw mode rejects a file over the 50MiB download cap', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'huge.bin');
    await fs.writeFile(file, '');
    await fs.truncate(file, DOWNLOAD_MAX_FILE_BYTES + 1); // sparse — no need to write real bytes

    const result = await makeService().openReadStream(file, 'raw');
    expect(result.ok).toBe(false);
  });
});
