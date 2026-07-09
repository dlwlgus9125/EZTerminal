import { mkdtempSync, readFileSync, writeFileSync, existsSync, promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { JsonFile } from './json-file';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-json-file-'));
}

describe('JsonFile — writeAtomic + read round-trip', () => {
  it('writeAtomic inside enqueue writes the exact bytes, leaves no .tmp, and round-trips through read()', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();
    const payload = JSON.stringify({ a: 1 });

    await file.enqueue(() => file.writeAtomic(payload));

    expect(existsSync(`${file.path}.tmp`)).toBe(false);
    expect(readFileSync(file.path, 'utf8')).toBe(payload);
    expect(await file.read()).toEqual({ a: 1 });
  });
});

describe('JsonFile — init()', () => {
  it('creates the containing dir if missing', async () => {
    const base = makeDir();
    const nested = path.join(base, 'nested', 'sub');
    const file = new JsonFile(nested, 'data.json');
    expect(existsSync(nested)).toBe(false);

    await file.init();

    expect(existsSync(nested)).toBe(true);
  });

  it('deletes a pre-existing stale .tmp file', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'data.json.tmp'), 'half-written', 'utf8');
    const file = new JsonFile(dir, 'data.json');

    await file.init();

    expect(existsSync(path.join(dir, 'data.json.tmp'))).toBe(false);
  });
});

describe('JsonFile — read()', () => {
  it('returns undefined when the file is absent', async () => {
    const file = new JsonFile(makeDir(), 'data.json');
    await file.init();
    expect(await file.read()).toBeUndefined();
  });

  it('returns the parsed value for valid JSON', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();
    writeFileSync(file.path, JSON.stringify({ hello: 'world' }), 'utf8');

    expect(await file.read()).toEqual({ hello: 'world' });
  });

  it('quarantines unparseable text: returns undefined, preserves the original bytes in .corrupt, and removes the original', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();
    const badText = '{ not json !!!';
    writeFileSync(file.path, badText, 'utf8');

    const result = await file.read();

    expect(result).toBeUndefined();
    expect(existsSync(file.path)).toBe(false);
    expect(existsSync(`${file.path}.corrupt`)).toBe(true);
    expect(readFileSync(`${file.path}.corrupt`, 'utf8')).toBe(badText);
  });
});

describe('JsonFile — enqueue()', () => {
  it('runs enqueued ops in FIFO order', async () => {
    const file = new JsonFile(makeDir(), 'data.json');
    const order: number[] = [];

    const p1 = file.enqueue(async () => {
      order.push(1);
    });
    const p2 = file.enqueue(async () => {
      order.push(2);
    });
    const p3 = file.enqueue(async () => {
      order.push(3);
    });
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates the op return value to the caller', async () => {
    const file = new JsonFile(makeDir(), 'data.json');
    const result = await file.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it('a rejecting op does not prevent a subsequently-enqueued op from running', async () => {
    const file = new JsonFile(makeDir(), 'data.json');
    const ran: string[] = [];

    const p1 = file.enqueue(async () => {
      ran.push('a');
      throw new Error('boom');
    });
    const p2 = file.enqueue(async () => {
      ran.push('b');
    });

    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(ran).toEqual(['a', 'b']);
  });
});

describe('JsonFile — flush()', () => {
  it('resolves only after an in-flight write AND an op enqueued during the await both complete', async () => {
    const file = new JsonFile(makeDir(), 'data.json');
    const completed: string[] = [];
    let resolveAStarted: () => void;
    const aStarted = new Promise<void>((resolve) => {
      resolveAStarted = resolve;
    });

    file.enqueue(async () => {
      resolveAStarted();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Enqueued WHILE op A is still running (and thus while a flush() awaiting
      // op A's chain segment is still pending) — flush must pick this up too.
      file.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed.push('b');
      });
      completed.push('a');
    });

    await aStarted;
    await file.flush();

    expect(completed).toEqual(['a', 'b']);
  });
});

describe('JsonFile — quarantine()', () => {
  it('renames the file to .corrupt', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();
    writeFileSync(file.path, 'bad', 'utf8');

    await file.quarantine();

    expect(existsSync(file.path)).toBe(false);
    expect(existsSync(`${file.path}.corrupt`)).toBe(true);
  });

  it('does not throw when called again after the file is already gone', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();
    writeFileSync(file.path, 'bad', 'utf8');
    await file.quarantine();

    await expect(file.quarantine()).resolves.toBeUndefined();
  });
});

describe('JsonFile — writeAtomic Windows-lock retry', () => {
  it('retries once on a transient rename failure, then lands the write', async () => {
    const dir = makeDir();
    const file = new JsonFile(dir, 'data.json');
    await file.init();

    const realRename = fsPromises.rename;
    let calls = 0;
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (...args: Parameters<typeof realRename>) => {
      calls += 1;
      if (calls === 1) throw new Error('EBUSY: transient lock');
      return realRename(...args);
    });

    try {
      await file.enqueue(() => file.writeAtomic(JSON.stringify({ ok: true })));

      expect(calls).toBe(2);
      expect(existsSync(file.path)).toBe(true);
      expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });
});
