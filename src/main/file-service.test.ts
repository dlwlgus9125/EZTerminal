import { promises as fs, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_MAX_FILE_BYTES, FILE_CHUNK_BYTES, TEXT_VIEW_MAX_BYTES, UPLOAD_MAX_FILE_BYTES } from '../shared/files';
import {
  FileService,
  MAX_OPEN_UPLOADS,
  resolveCollisionName,
  validateEntryName,
  type FileServiceOptions,
} from './file-service';

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
  await Promise.all(services.splice(0).map((service) => service.dispose()));
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
  it('serializes concurrent chunks before validating their offsets', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'concurrent.txt', 6);
    if (!begin.ok) throw new Error('begin failed');

    const first = service.writeUploadChunk(begin.uploadId, 0, Buffer.from('abc'));
    const second = service.writeUploadChunk(begin.uploadId, 3, Buffer.from('def'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ ok: true, receivedBytes: 3 });
    expect(secondResult).toEqual({ ok: true, receivedBytes: 6 });
    const commit = await service.commitUpload(begin.uploadId);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    await expect(fs.readFile(path.join(dir, commit.finalName), 'utf8')).resolves.toBe('abcdef');
  });

  it('refuses and cleans up a commit before every declared byte arrived', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'short.txt', 5);
    if (!begin.ok) throw new Error('begin failed');

    await service.writeUploadChunk(begin.uploadId, 0, Buffer.from('abc'));
    const commit = await service.commitUpload(begin.uploadId);

    expect(commit).toEqual({ ok: false, error: 'upload is incomplete' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('bounds concurrent upload reservations and their open file handles globally', async () => {
    const dir = await makeDir();
    const service = makeService();
    const expectedGlobalLimit = MAX_OPEN_UPLOADS;

    const results = await Promise.all(
      Array.from({ length: expectedGlobalLimit + 1 }, (_, index) => (
        service.beginUpload(dir, `bounded-${index}.bin`, 0)
      )),
    );
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);

    expect(accepted).toHaveLength(expectedGlobalLimit);
    expect(rejected).toEqual([
      { ok: false, error: 'too many active uploads' },
    ]);
    await Promise.all(accepted.map((result) => (
      result.ok ? service.abortUpload(result.uploadId) : Promise.resolve()
    )));
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('reserves an upload id before a concurrent begin can reuse it', async () => {
    const dir = await makeDir();
    const service = makeService({ newId: () => 'shared-upload-id' });
    const realOpen = fs.open.bind(fs);
    let releaseFirstOpen!: () => void;
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    let openCalls = 0;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      openCalls += 1;
      if (openCalls === 1) await firstOpenGate;
      return realOpen(file, flags, mode);
    });

    let firstResult: Awaited<ReturnType<FileService['beginUpload']>>;
    let secondResult: Awaited<ReturnType<FileService['beginUpload']>>;
    try {
      const firstBegin = service.beginUpload(dir, 'first.bin', 0);
      await vi.waitFor(() => {
        expect(openSpy).toHaveBeenCalledTimes(1);
      });
      secondResult = await service.beginUpload(dir, 'second.bin', 0);
      releaseFirstOpen();
      firstResult = await firstBegin;
    } finally {
      releaseFirstOpen();
      openSpy.mockRestore();
    }

    const results = [firstResult, secondResult];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'upload id collision' },
    ]);

    const accepted = results.find((result) => result.ok);
    if (accepted?.ok) await service.abortUpload(accepted.uploadId);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('keeps aborting uploads inside the global cap through close and unlink', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begins = await Promise.all(
      Array.from({ length: MAX_OPEN_UPLOADS }, (_, index) => (
        service.beginUpload(dir, `abort-cap-${index}.bin`, 0)
      )),
    );
    const accepted = begins.filter((result) => result.ok);
    expect(accepted).toHaveLength(MAX_OPEN_UPLOADS);

    const records = [
      ...(service as unknown as {
        uploads: Map<string, { fd: { close(): Promise<void> } }>;
      }).uploads.values(),
    ];
    let releaseCloses!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseCloses = resolve;
    });
    const closeSpies = records.map((record) => {
      const realClose = record.fd.close.bind(record.fd);
      return vi.spyOn(record.fd, 'close').mockImplementation(async () => {
        await closeGate;
        await realClose();
      });
    });
    const realUnlink = fs.unlink.bind(fs);
    let releaseUnlinks!: () => void;
    const unlinkGate = new Promise<void>((resolve) => {
      releaseUnlinks = resolve;
    });
    let unlinkCalls = 0;
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file).endsWith('.ezpart')) {
        unlinkCalls += 1;
        await unlinkGate;
      }
      await realUnlink(file);
    });
    const aborts = accepted.map((result) => (
      result.ok ? service.abortUpload(result.uploadId) : Promise.resolve()
    ));
    const unexpectedBegins: Awaited<ReturnType<FileService['beginUpload']>>[] = [];
    try {
      await vi.waitFor(() => {
        expect(closeSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
      });
      const duringClose = await service.beginUpload(dir, 'must-wait-for-close.bin', 0);
      unexpectedBegins.push(duringClose);
      expect(duringClose).toEqual({ ok: false, error: 'too many active uploads' });

      releaseCloses();
      await vi.waitFor(() => {
        expect(unlinkCalls).toBe(MAX_OPEN_UPLOADS);
      });
      const duringUnlink = await service.beginUpload(dir, 'must-wait-for-unlink.bin', 0);
      unexpectedBegins.push(duringUnlink);
      expect(duringUnlink).toEqual({ ok: false, error: 'too many active uploads' });
    } finally {
      releaseCloses();
      releaseUnlinks();
      await Promise.all(aborts);
      closeSpies.forEach((spy) => spy.mockRestore());
      unlinkSpy.mockRestore();
      await Promise.all(unexpectedBegins.map((result) => (
        result.ok ? service.abortUpload(result.uploadId) : Promise.resolve()
      )));
    }

    const afterSettlement = await service.beginUpload(dir, 'after-aborts.bin', 0);
    expect(afterSettlement.ok).toBe(true);
    if (afterSettlement.ok) await service.abortUpload(afterSettlement.uploadId);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('keeps committing uploads inside the global cap through close and rename', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begins = await Promise.all(
      Array.from({ length: MAX_OPEN_UPLOADS }, (_, index) => (
        service.beginUpload(dir, `commit-cap-${index}.bin`, 0)
      )),
    );
    const accepted = begins.filter((result) => result.ok);
    expect(accepted).toHaveLength(MAX_OPEN_UPLOADS);

    const records = [
      ...(service as unknown as {
        uploads: Map<string, { fd: { close(): Promise<void> } }>;
      }).uploads.values(),
    ];
    let releaseCloses!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseCloses = resolve;
    });
    const closeSpies = records.map((record) => {
      const realClose = record.fd.close.bind(record.fd);
      return vi.spyOn(record.fd, 'close').mockImplementation(async () => {
        await closeGate;
        await realClose();
      });
    });
    const realRename = fs.rename.bind(fs);
    let releaseRenames!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRenames = resolve;
    });
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).endsWith('.ezpart')) {
        renameCalls += 1;
        await renameGate;
      }
      await realRename(oldPath, newPath);
    });
    const commits = accepted.map((result) => (
      result.ok
        ? service.commitUpload(result.uploadId)
        : Promise.resolve({ ok: false as const, error: 'begin failed' })
    ));
    const unexpectedBegins: Awaited<ReturnType<FileService['beginUpload']>>[] = [];
    let commitResults: Awaited<(typeof commits)[number]>[] = [];
    try {
      await vi.waitFor(() => {
        expect(closeSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
      });
      const duringClose = await service.beginUpload(dir, 'must-wait-for-close.bin', 0);
      unexpectedBegins.push(duringClose);
      expect(duringClose).toEqual({ ok: false, error: 'too many active uploads' });

      releaseCloses();
      await vi.waitFor(() => {
        expect(renameCalls).toBe(MAX_OPEN_UPLOADS);
      });
      const duringRename = await service.beginUpload(dir, 'must-wait-for-rename.bin', 0);
      unexpectedBegins.push(duringRename);
      expect(duringRename).toEqual({ ok: false, error: 'too many active uploads' });
    } finally {
      releaseCloses();
      releaseRenames();
      commitResults = await Promise.all(commits);
      closeSpies.forEach((spy) => spy.mockRestore());
      renameSpy.mockRestore();
      await Promise.all(unexpectedBegins.map((result) => (
        result.ok ? service.abortUpload(result.uploadId) : Promise.resolve()
      )));
    }

    expect(commitResults.every((result) => result.ok)).toBe(true);
    const afterSettlement = await service.beginUpload(dir, 'after-commits.bin', 0);
    expect(afterSettlement.ok).toBe(true);
    if (afterSettlement.ok) await service.abortUpload(afterSettlement.uploadId);
    expect((await fs.readdir(dir)).some((name) => name.endsWith('.ezpart'))).toBe(false);
  });

  it('dispose is idempotent, rejects new begins, and waits for close plus unlink', async () => {
    const dir = await makeDir();
    const service = makeService();
    const begin = await service.beginUpload(dir, 'dispose-active.bin', 0);
    if (!begin.ok) throw new Error('begin failed');
    const record = (service as unknown as {
      uploads: Map<string, { fd: { close(): Promise<void> } }>;
    }).uploads.get(begin.uploadId);
    if (!record) throw new Error('missing upload record');

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const realClose = record.fd.close.bind(record.fd);
    const closeSpy = vi.spyOn(record.fd, 'close').mockImplementation(async () => {
      await closeGate;
      await realClose();
    });
    let releaseUnlink!: () => void;
    const unlinkGate = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const realUnlink = fs.unlink.bind(fs);
    let unlinkStarted = false;
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file).endsWith('.ezpart')) {
        unlinkStarted = true;
        await unlinkGate;
      }
      await realUnlink(file);
    });

    const firstDisposal = service.dispose();
    const duplicateDisposal = service.dispose();
    expect(duplicateDisposal).toBe(firstDisposal);
    let disposalSettled = false;
    const disposal = Promise.resolve(firstDisposal).then(() => {
      disposalSettled = true;
    });
    let rejectedBegin: Awaited<ReturnType<FileService['beginUpload']>> | undefined;
    try {
      rejectedBegin = await service.beginUpload(dir, 'after-dispose.bin', 0);
      expect(rejectedBegin).toEqual({ ok: false, error: 'file service is disposed' });
      expect(disposalSettled).toBe(false);

      releaseClose();
      await vi.waitFor(() => {
        expect(unlinkStarted).toBe(true);
      });
      expect(disposalSettled).toBe(false);

      releaseUnlink();
      await disposal;
      expect(disposalSettled).toBe(true);
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      releaseClose();
      releaseUnlink();
      await service.abortUpload(begin.uploadId);
      if (rejectedBegin?.ok) await service.abortUpload(rejectedBegin.uploadId);
      await disposal;
      closeSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('dispose drains a begin already waiting in fs.open and removes its late part file', async () => {
    const dir = await makeDir();
    const service = makeService();
    const realOpen = fs.open.bind(fs);
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      await openGate;
      return realOpen(file, flags, mode);
    });
    const pendingBegin = service.beginUpload(dir, 'dispose-pending.bin', 0);
    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    const disposal = Promise.resolve(service.dispose());
    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
    });
    let beginResult: Awaited<typeof pendingBegin> | undefined;
    try {
      await Promise.resolve();
      expect(disposalSettled).toBe(false);
      releaseOpen();
      beginResult = await pendingBegin;
      await disposal;
      expect(beginResult).toEqual({ ok: false, error: 'file service is disposed' });
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      releaseOpen();
      beginResult ??= await pendingBegin;
      if (beginResult.ok) await service.abortUpload(beginResult.uploadId);
      await disposal;
      openSpy.mockRestore();
    }
  });

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
  it('preview mode classifies an image by signature and streams only validated bytes', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'actually-an-image.bin');
    const png = Buffer.alloc(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 0, 20, 0, 0, 0, 10], 16);
    await fs.writeFile(file, png);

    const stream = await makeService().openReadStream(file, 'preview');
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    expect(stream.meta).toMatchObject({
      fileSize: png.length,
      sendBytes: png.length,
      isText: false,
      preview: { kind: 'image', name: 'actually-an-image.bin', mime: 'image/png', width: 20, height: 10 },
    });
    const chunk = await stream.next();
    expect(Buffer.from(chunk.data)).toEqual(png);
    await stream.close();
  });

  it('preview mode sends PDF metadata without streaming PDF bytes', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'report.data');
    await fs.writeFile(file, '%PDF-1.7\nbody');

    const stream = await makeService().openReadStream(file, 'preview');
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    expect(stream.meta).toMatchObject({
      sendBytes: 0,
      preview: { kind: 'pdf', name: 'report.data', mime: 'application/pdf' },
    });
    await stream.close();
  });

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

  it('rejects a short read when the file shrinks after stream metadata is captured', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'shrinking.bin');
    await fs.writeFile(file, 'abcdef');

    const stream = await makeService().openReadStream(file, 'raw');
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    expect(stream.meta).toMatchObject({ fileSize: 6, sendBytes: 6 });

    await fs.truncate(file, 2);
    await expect(stream.next()).rejects.toThrow(/changed during read/);
    await stream.close();
  });

  it('fails a pre-aborted open and aborts an established stream idempotently', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'abort.txt');
    await fs.writeFile(file, 'content');
    const service = makeService();

    const beforeOpen = new AbortController();
    beforeOpen.abort();
    await expect(service.openReadStream(file, 'raw', undefined, beforeOpen.signal)).resolves.toMatchObject({
      ok: false,
      error: 'file read cancelled',
    });

    const afterOpen = new AbortController();
    const stream = await service.openReadStream(file, 'raw', undefined, afterOpen.signal);
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    afterOpen.abort();
    await expect(stream.next()).rejects.toThrow(/cancelled/);
    await expect(stream.close()).resolves.toBeUndefined();
    await expect(stream.close()).resolves.toBeUndefined();
  });

  it('raw mode rejects a file over the 50MiB download cap', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'huge.bin');
    await fs.writeFile(file, '');
    await fs.truncate(file, DOWNLOAD_MAX_FILE_BYTES + 1); // sparse — no need to write real bytes

    const result = await makeService().openReadStream(file, 'raw');
    expect(result.ok).toBe(false);
  });

  // Regression pin for a fix where a post-open failure (fs.open succeeds, then
  // a stat/detectIsText race — e.g. the file is deleted or EPERM'd between
  // open and stat) leaked the FileHandle and REJECTED instead of returning
  // {ok:false}. A deterministic repro of that exact race isn't reachable
  // without faking fs internals (out of this file's test style), so these pin
  // the public contract directly: openReadStream must never reject, for any
  // invalid target — if it did, the `await` below would throw and fail the test.
  it('never rejects — a nonexistent path returns {ok:false}', async () => {
    const dir = await makeDir();
    const result = await makeService().openReadStream(path.join(dir, 'does-not-exist.txt'), 'raw');
    expect(result.ok).toBe(false);
  });

  it('never rejects — a path with a non-directory path component (ENOTDIR) returns {ok:false}', async () => {
    // A directory path itself turns out NOT to fail here (fs.open on a dir
    // succeeds on this platform, and a directory's reported size is 0, which
    // short-circuits detectIsText's sniff-read before it ever touches
    // handle.read) — so a plain directory isn't actually an "invalid target".
    // A path segment that isn't a directory (ENOTDIR) IS a reliable OS-level
    // failure on both Windows and POSIX.
    const dir = await makeDir();
    const notADir = path.join(dir, 'plain-file.txt');
    await fs.writeFile(notADir, 'x');
    const result = await makeService().openReadStream(path.join(notADir, 'child.txt'), 'raw');
    expect(result.ok).toBe(false);
  });
});

describe('FileService.readFilePreview', () => {
  it('reads an authorized pre-opened handle instead of reopening a swapped path', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'terminal.txt');
    await fs.writeFile(file, 'authorized');
    const handle = await fs.open(file, 'r');
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, 'replacement');

    const result = await makeService().readFilePreview(file, handle);

    expect(result).toMatchObject({ ok: true, kind: 'text', content: 'authorized' });
  });

  it('returns Markdown text with the existing truncation contract', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'README.md');
    await fs.writeFile(file, '# Hello\n');

    const result = await makeService().readFilePreview(file);
    expect(result).toMatchObject({
      ok: true,
      kind: 'text',
      name: 'README.md',
      mime: 'text/markdown',
      content: '# Hello\n',
      truncated: false,
    });
  });

  it('returns bounded supported image bytes and dimensions', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'not-trusted-by-extension.bin');
    const png = Buffer.alloc(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 0, 20, 0, 0, 0, 10], 16);
    await fs.writeFile(file, png);

    const result = await makeService().readFilePreview(file);
    expect(result).toMatchObject({ ok: true, kind: 'image', mime: 'image/png', width: 20, height: 10 });
    if (result.ok && result.kind === 'image') expect(Buffer.from(result.bytes)).toEqual(png);
  });

  it('returns only PDF metadata and rejects arbitrary binary content', async () => {
    const dir = await makeDir();
    const pdf = path.join(dir, 'report.data');
    await fs.writeFile(pdf, '%PDF-1.7\nbody');
    expect(await makeService().readFilePreview(pdf)).toMatchObject({
      ok: true,
      kind: 'pdf',
      mime: 'application/pdf',
    });

    const binary = path.join(dir, 'blob.data');
    await fs.writeFile(binary, new Uint8Array([1, 0, 2, 3]));
    expect(await makeService().readFilePreview(binary)).toMatchObject({
      ok: true,
      kind: 'unsupported',
      reason: 'binary',
    });
  });
});
