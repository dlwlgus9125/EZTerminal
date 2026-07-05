import { describe, expect, it, vi } from 'vitest';

import { createUploadQueue, type UploadItem } from './upload-queue';

/** A promise plus its own resolve/reject, for driving async steps by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function latest(snapshots: readonly (readonly UploadItem[])[]): readonly UploadItem[] {
  return snapshots[snapshots.length - 1];
}

describe('upload-queue', () => {
  it('uploads strictly sequentially: the second file does not start until the first resolves', async () => {
    const calls: string[] = [];
    const deferreds = new Map<string, ReturnType<typeof deferred<{ finalName: string }>>>();
    const uploadFile = vi.fn((_dirPath: string, name: string) => {
      calls.push(name);
      const d = deferred<{ finalName: string }>();
      deferreds.set(name, d);
      return d.promise;
    });
    const snapshots: (readonly UploadItem[])[] = [];
    const queue = createUploadQueue({ uploadFile, onChange: (items) => snapshots.push(items) });

    queue.enqueue(
      [
        { name: 'a.txt', bytes: new Uint8Array([1]) },
        { name: 'b.txt', bytes: new Uint8Array([2]) },
      ],
      'C:\\x',
    );

    expect(calls).toEqual(['a.txt']); // b.txt has NOT started yet

    deferreds.get('a.txt')!.resolve({ finalName: 'a.txt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['a.txt', 'b.txt']);

    deferreds.get('b.txt')!.resolve({ finalName: 'b.txt' });
    await Promise.resolve();
    await Promise.resolve();

    const final = latest(snapshots);
    expect(final.map((i) => i.status)).toEqual(['done', 'done']);
  });

  it('an oversized file is marked failed immediately, with no uploadFile call', () => {
    const uploadFile = vi.fn();
    const snapshots: (readonly UploadItem[])[] = [];
    const queue = createUploadQueue({
      uploadFile,
      maxFileBytes: 10,
      onChange: (items) => snapshots.push(items),
    });

    queue.enqueue([{ name: 'big.bin', bytes: new Uint8Array(11) }], 'C:\\x');

    expect(uploadFile).not.toHaveBeenCalled();
    const item = latest(snapshots)[0];
    expect(item.status).toBe('failed');
    expect(item.error).toMatch(/exceeds/);
  });

  it('a mid-queue failure continues to the next file', async () => {
    const deferreds = new Map<string, ReturnType<typeof deferred<{ finalName: string }>>>();
    const uploadFile = vi.fn((_dirPath: string, name: string) => {
      const d = deferred<{ finalName: string }>();
      deferreds.set(name, d);
      return d.promise;
    });
    const snapshots: (readonly UploadItem[])[] = [];
    const queue = createUploadQueue({ uploadFile, onChange: (items) => snapshots.push(items) });

    queue.enqueue(
      [
        { name: 'a.txt', bytes: new Uint8Array([1]) },
        { name: 'b.txt', bytes: new Uint8Array([2]) },
      ],
      'C:\\x',
    );

    deferreds.get('a.txt')!.reject(new Error('disk full'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(deferreds.has('b.txt')).toBe(true); // b.txt started despite a.txt's failure

    deferreds.get('b.txt')!.resolve({ finalName: 'b.txt' });
    await Promise.resolve();
    await Promise.resolve();

    const final = latest(snapshots);
    expect(final.find((i) => i.name === 'a.txt')).toMatchObject({ status: 'failed', error: 'disk full' });
    expect(final.find((i) => i.name === 'b.txt')).toMatchObject({ status: 'done', finalName: 'b.txt' });
  });

  it('progress updates flow through onChange as receivedBytes', async () => {
    let capturedOnProgress: ((sent: number) => void) | null = null;
    const d = deferred<{ finalName: string }>();
    const uploadFile = vi.fn(
      (_dirPath: string, _name: string, _bytes: Uint8Array, onProgress: (sent: number) => void) => {
        capturedOnProgress = onProgress;
        return d.promise;
      },
    );
    const snapshots: (readonly UploadItem[])[] = [];
    const queue = createUploadQueue({ uploadFile, onChange: (items) => snapshots.push(items) });

    queue.enqueue([{ name: 'a.txt', bytes: new Uint8Array(10) }], 'C:\\x');

    capturedOnProgress!(4);
    expect(latest(snapshots)[0].receivedBytes).toBe(4);

    capturedOnProgress!(10);
    expect(latest(snapshots)[0].receivedBytes).toBe(10);

    d.resolve({ finalName: 'a.txt' });
    await Promise.resolve();
    await Promise.resolve();
    expect(latest(snapshots)[0]).toMatchObject({ status: 'done', receivedBytes: 10 });
  });

  it('enqueueing an empty array is a no-op (onChange never fires)', () => {
    const uploadFile = vi.fn();
    const onChange = vi.fn();
    const queue = createUploadQueue({ uploadFile, onChange });

    queue.enqueue([], 'C:\\x');

    expect(onChange).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('a second batch enqueued to a DIFFERENT dir while the first is mid-flight does not affect the first batch\'s pending items', async () => {
    const calls: Array<{ dirPath: string; name: string }> = [];
    const deferreds = new Map<string, ReturnType<typeof deferred<{ finalName: string }>>>();
    const uploadFile = vi.fn((dirPath: string, name: string) => {
      calls.push({ dirPath, name });
      const d = deferred<{ finalName: string }>();
      deferreds.set(name, d);
      return d.promise;
    });
    const queue = createUploadQueue({ uploadFile, onChange: () => undefined });

    // First batch: two files targeting C:\\a — only the first starts immediately.
    queue.enqueue(
      [
        { name: 'one.txt', bytes: new Uint8Array([1]) },
        { name: 'two.txt', bytes: new Uint8Array([2]) },
      ],
      'C:\\a',
    );
    expect(calls).toEqual([{ dirPath: 'C:\\a', name: 'one.txt' }]);

    // Second batch, enqueued to a DIFFERENT dir while 'one.txt' is still uploading.
    queue.enqueue([{ name: 'three.txt', bytes: new Uint8Array([3]) }], 'C:\\b');

    deferreds.get('one.txt')!.resolve({ finalName: 'one.txt' });
    await Promise.resolve();
    await Promise.resolve();

    // 'two.txt' (queued BEFORE the C:\\b batch) must still target C:\\a, not C:\\b.
    expect(calls).toContainEqual({ dirPath: 'C:\\a', name: 'two.txt' });

    deferreds.get('two.txt')!.resolve({ finalName: 'two.txt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContainEqual({ dirPath: 'C:\\b', name: 'three.txt' });
  });
});
