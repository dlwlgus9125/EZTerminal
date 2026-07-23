import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ResultRow } from '../shared/ipc';
import {
  DEFAULT_OUTPUT_RETENTION_LIMITS,
  OutputRetentionRuntime,
  type OutputRetentionLimits,
} from './output-retention-runtime';
import { OutputCapacityError, ResultStore } from './result-store';

const runtimes: OutputRetentionRuntime[] = [];
const tempRoots: string[] = [];
const stressIt = process.env.EZTERMINAL_STRESS_TESTS === '1' ? it : it.skip;

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanupSync();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRuntime(options: { globalHotBytes?: number; globalSpillBytes?: number } = {}): OutputRetentionRuntime {
  const baseDirectory = mkdtempSync(join(tmpdir(), 'ezterminal-result-store-test-'));
  tempRoots.push(baseDirectory);
  const runtime = new OutputRetentionRuntime({
    baseDirectory,
    globalHotBytes: options.globalHotBytes,
    globalSpillBytes: options.globalSpillBytes,
    registerExitCleanup: false,
  });
  runtimes.push(runtime);
  return runtime;
}

function makeStore(
  iterator: AsyncIterator<ResultRow>,
  options: {
    runtime?: OutputRetentionRuntime;
    limits?: Partial<OutputRetentionLimits>;
  } = {},
): ResultStore {
  return new ResultStore(iterator, {
    runtime: options.runtime ?? makeRuntime(),
    limits: options.limits,
  });
}

/** Synthetic row source whose pull count proves honest credit/backpressure. */
function countingSource(
  total: number,
  row: (index: number) => ResultRow = (n) => ({ n }),
): { iterator: AsyncIterator<ResultRow>; pulls: () => number } {
  let pulled = 0;
  let i = 0;
  const iterator: AsyncIterator<ResultRow> = {
    next(): Promise<IteratorResult<ResultRow>> {
      if (i >= total) return Promise.resolve({ done: true, value: undefined });
      pulled += 1;
      const value = row(i);
      i += 1;
      return Promise.resolve({ done: false, value });
    },
  };
  return { iterator, pulls: () => pulled };
}

describe('ResultStore — credit/window compatibility', () => {
  it('serves only the requested window and pulls only what it needs', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = makeStore(iterator);

    const window = await store.getWindow(0, 50);

    expect(window).toEqual({
      start: 0,
      rows: Array.from({ length: 50 }, (_, n) => ({ n })),
    });
    expect(pulls()).toBe(50);
    expect(store.count).toBe(50);
    expect(store.exhausted).toBe(false);
    await store.dispose();
  });

  it('serves an interior window, pulling only through its end', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = makeStore(iterator);

    const window = await store.getWindow(100, 50);

    expect(window.start).toBe(100);
    expect(window.rows[0]).toEqual({ n: 100 });
    expect(window.rows).toHaveLength(50);
    expect(pulls()).toBe(150);
    await store.dispose();
  });

  it('read-ahead retains extra rows but never expands the returned slice', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = makeStore(iterator);

    const window = await store.getWindow(0, 10, 40);

    expect(window.rows).toHaveLength(10);
    expect(pulls()).toBe(50);
    expect(store.count).toBe(50);
    await store.dispose();
  });

  it('accounts for decoded objects and pending Buffers, not only JSON payload bytes', async () => {
    const value = 'x'.repeat(1_000);
    const store = makeStore(countingSource(1, () => ({ value })).iterator);

    await store.ensure(1);

    const encodedBytes = Buffer.byteLength(JSON.stringify({ value }), 'utf8') + 4;
    expect(store.diagnostics().hotBytes).toBeGreaterThan(encodedBytes * 2);
    await store.dispose();
  });

  it('clamps a final window and reports natural exhaustion', async () => {
    const { iterator } = countingSource(20_000);
    const store = makeStore(iterator);

    await store.ensure(40_000);
    expect(store.count).toBe(20_000);
    expect(store.exhausted).toBe(true);

    const tail = await store.getWindow(19_980, 50);
    expect(tail.rows).toHaveLength(20);
    expect(tail.rows[19]).toEqual({ n: 19_999 });
    await store.dispose();
  });

  it('serializes concurrent ensure calls without double-advancing the iterator', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = makeStore(iterator);

    await Promise.all([store.getWindow(0, 30), store.getWindow(0, 60), store.ensure(45)]);

    expect(store.count).toBe(60);
    expect(pulls()).toBe(60);
    await store.dispose();
  });

  it('rejects malformed or frontier-skipping windows without draining the source', async () => {
    const { iterator, pulls } = countingSource(1_000_000);
    const store = makeStore(iterator);

    await expect(store.getWindow(Number.POSITIVE_INFINITY, 10)).rejects.toThrow('finite');
    await expect(store.getWindow(1_000_000, 10)).rejects.toThrow('retained frontier');
    await expect(store.getWindow(0, Number.NaN)).rejects.toThrow('finite');
    expect(pulls()).toBe(0);
    await store.dispose();
  });

  it('stopSource retains rows for post-command paging; dispose removes the run directory', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = makeStore(iterator);
    await store.getWindow(0, 10);
    const runDirectory = store.diagnostics().runDirectory;

    await store.stopSource();
    await store.ensure(1_000);
    expect(pulls()).toBe(10);
    expect(await store.getWindow(3, 3)).toEqual({
      start: 3,
      rows: [{ n: 3 }, { n: 4 }, { n: 5 }],
    });
    expect(existsSync(runDirectory)).toBe(true);

    await store.dispose();
    expect(existsSync(runDirectory)).toBe(false);
  });

  it('waits for an in-flight cold window read before releasing its quotas', async () => {
    const runtime = makeRuntime({ globalHotBytes: 96, globalSpillBytes: 16_384 });
    const store = makeStore(countingSource(30).iterator, {
      runtime,
      limits: {
        segmentBytes: 96,
        segmentRows: 3,
        perRunHotBytes: 96,
        perRunSpillBytes: 16_384,
      },
    });
    await store.ensure(30);
    const runDirectory = store.diagnostics().runDirectory;

    const read = store.getWindow(0, 3);
    await Promise.all([read, store.dispose()]);

    expect(runtime.diagnostics()).toEqual({ hotBytes: 0, spillBytes: 0, caches: 0 });
    expect(existsSync(runDirectory)).toBe(false);
  });

  it('returns one shared disposal promise to concurrent callers', async () => {
    const store = makeStore(countingSource(10).iterator);
    await store.ensure(5);

    const first = store.dispose();
    const second = store.dispose();

    expect(second).toBe(first);
    await first;
  });

  it('serializes stopSource behind an in-flight next and drops the late row', async () => {
    let resolveNext: ((result: IteratorResult<ResultRow>) => void) | null = null;
    let nextPending = false;
    let returnCalls = 0;
    const iterator: AsyncIterator<ResultRow> = {
      next(): Promise<IteratorResult<ResultRow>> {
        nextPending = true;
        return new Promise((resolve) => {
          resolveNext = (result) => {
            nextPending = false;
            resolve(result);
          };
        });
      },
      return(): Promise<IteratorResult<ResultRow>> {
        expect(nextPending).toBe(false);
        returnCalls += 1;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const store = makeStore(iterator);
    const ensure = store.ensure(1);
    await Promise.resolve();

    const stop = store.stopSource();
    (resolveNext as ((result: IteratorResult<ResultRow>) => void) | null)?.({
      done: false,
      value: { n: 1 },
    });
    await Promise.all([ensure, stop]);

    expect(store.count).toBe(0);
    expect(returnCalls).toBe(1);
    await store.dispose();
  });
});

describe('ResultStore — segmented spill and quotas', () => {
  const tinyLimits: Partial<OutputRetentionLimits> = {
    segmentBytes: 96,
    segmentRows: 3,
    perRunHotBytes: 96,
    perRunSpillBytes: 16_384,
  };

  it('pages cold interior and tail rows across many bounded segments', async () => {
    const runtime = makeRuntime({ globalHotBytes: 96, globalSpillBytes: 16_384 });
    const { iterator } = countingSource(40, (n) => ({ n, value: `row-${n}` }));
    const store = makeStore(iterator, { runtime, limits: tinyLimits });

    await store.ensure(100);
    const diagnostics = store.diagnostics();
    expect(diagnostics.segments).toBeGreaterThan(10);
    expect(diagnostics.hotBytes).toBeLessThanOrEqual(96);
    expect(runtime.diagnostics().hotBytes).toBeLessThanOrEqual(96);
    expect(await store.getWindow(17, 8)).toEqual({
      start: 17,
      rows: Array.from({ length: 8 }, (_, offset) => ({
        n: 17 + offset,
        value: `row-${17 + offset}`,
      })),
    });
    expect((await store.getWindow(37, 20)).rows).toEqual([
      { n: 37, value: 'row-37' },
      { n: 38, value: 'row-38' },
      { n: 39, value: 'row-39' },
    ]);
    await store.dispose();
  });

  it('visits a requested range as ordered byte-bounded chunks', async () => {
    const runtime = makeRuntime({ globalHotBytes: 512, globalSpillBytes: 16_384 });
    const store = makeStore(
      countingSource(12, (n) => ({ n, value: 'x'.repeat(36) })).iterator,
      {
        runtime,
        limits: {
          segmentBytes: 96,
          segmentRows: 100,
          perRunHotBytes: 512,
          perRunSpillBytes: 16_384,
        },
      },
    );
    const windows: Array<{ start: number; rows: ResultRow[] }> = [];

    await store.forEachWindowChunk(2, 7, 0, (window) => {
      windows.push(window);
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.flatMap((window) => window.rows.map((row) => row.n))).toEqual([
      2, 3, 4, 5, 6, 7, 8,
    ]);
    let expectedStart = 2;
    for (const window of windows) {
      expect(window.start).toBe(expectedStart);
      expectedStart += window.rows.length;
      const encodedBytes = window.rows.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8') + 4,
        0,
      );
      expect(encodedBytes).toBeLessThanOrEqual(96);
    }
    await store.dispose();
  });

  it('single-flights concurrent cold reads of the same segment', async () => {
    const runtime = makeRuntime({ globalHotBytes: 512, globalSpillBytes: 16_384 });
    const { iterator } = countingSource(20, (n) => ({ n, value: `row-${n}` }));
    const store = makeStore(iterator, {
      runtime,
      limits: {
        ...tinyLimits,
        perRunHotBytes: 512,
      },
    });
    await store.ensure(20);

    const windows = await Promise.all(
      Array.from({ length: 20 }, () => store.getWindow(0, 3)),
    );

    for (const window of windows) {
      expect(window.rows).toEqual([
        { n: 0, value: 'row-0' },
        { n: 1, value: 'row-1' },
        { n: 2, value: 'row-2' },
      ]);
    }
    await store.dispose();
  });

  stressIt('keeps million-row middle and tail paging bounded', async () => {
    const runtime = makeRuntime();
    const store = makeStore(countingSource(1_000_000).iterator, { runtime });

    await store.ensure(1_000_001);

    expect(store.exhausted).toBe(true);
    expect(store.count).toBe(1_000_000);
    expect(store.diagnostics().hotBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(runtime.diagnostics().hotBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect((await store.getWindow(499_995, 10)).rows).toEqual(
      Array.from({ length: 10 }, (_, offset) => ({ n: 499_995 + offset })),
    );
    expect((await store.getWindow(999_995, 20)).rows).toEqual(
      Array.from({ length: 5 }, (_, offset) => ({ n: 999_995 + offset })),
    );
    await store.dispose();
  }, 20_000);

  it('enforces the global hot limit across independent runs via LRU eviction', async () => {
    const runtime = makeRuntime({ globalHotBytes: 128, globalSpillBytes: 32_768 });
    const limits = {
      ...tinyLimits,
      perRunHotBytes: 96,
      perRunSpillBytes: 16_384,
    };
    const first = makeStore(countingSource(20).iterator, { runtime, limits });
    const second = makeStore(countingSource(20).iterator, { runtime, limits });

    await Promise.all([first.ensure(20), second.ensure(20)]);

    expect(runtime.diagnostics().hotBytes).toBeLessThanOrEqual(128);
    expect((await first.getWindow(0, 2)).rows).toEqual([{ n: 0 }, { n: 1 }]);
    expect((await second.getWindow(18, 2)).rows).toEqual([{ n: 18 }, { n: 19 }]);
    expect(runtime.diagnostics().hotBytes).toBeLessThanOrEqual(128);
    await Promise.all([first.dispose(), second.dispose()]);
    expect(runtime.diagnostics()).toEqual({ hotBytes: 0, spillBytes: 0, caches: 0 });
  });

  it('fails explicitly at the per-run spill boundary and preserves accepted rows', async () => {
    const runtime = makeRuntime({ globalHotBytes: 256, globalSpillBytes: 4_096 });
    const { iterator } = countingSource(100, (n) => ({ n, value: 'xxxxxxxxxxxx' }));
    const store = makeStore(iterator, {
      runtime,
      limits: {
        segmentBytes: 128,
        segmentRows: 4,
        perRunHotBytes: 256,
        perRunSpillBytes: 180,
      },
    });

    await expect(store.ensure(100)).rejects.toMatchObject({
      name: 'OutputCapacityError',
      code: 'capacity',
    });
    expect(store.exhausted).toBe(true);
    expect(store.count).toBeGreaterThan(0);
    expect(store.count).toBeLessThan(100);
    const retained = await store.getWindow(0, 100);
    expect(retained.rows).toHaveLength(store.count);
    expect(retained.rows[0]).toEqual({ n: 0, value: 'xxxxxxxxxxxx' });
    await store.dispose();
  });

  it('fails one run explicitly when the shared runtime spill budget is exhausted', async () => {
    const runtime = makeRuntime({ globalHotBytes: 512, globalSpillBytes: 220 });
    const limits = {
      segmentBytes: 128,
      segmentRows: 4,
      perRunHotBytes: 256,
      perRunSpillBytes: 200,
    };
    const first = makeStore(countingSource(3, (n) => ({ n, value: 'xxxxxxxxxxxxxxxxxxxx' })).iterator, {
      runtime,
      limits,
    });
    const second = makeStore(countingSource(10, (n) => ({ n, value: 'xxxxxxxxxxxxxxxxxxxx' })).iterator, {
      runtime,
      limits,
    });

    await first.ensure(3);
    await expect(second.ensure(10)).rejects.toBeInstanceOf(OutputCapacityError);
    expect(runtime.diagnostics().spillBytes).toBeLessThanOrEqual(220);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('rejects a single oversized row without silently accepting or truncating it', async () => {
    const runtime = makeRuntime({ globalHotBytes: 128, globalSpillBytes: 1_024 });
    const store = makeStore(countingSource(1, () => ({ value: 'x'.repeat(200) })).iterator, {
      runtime,
      limits: {
        segmentBytes: 64,
        segmentRows: 4,
        perRunHotBytes: 128,
        perRunSpillBytes: 1_024,
      },
    });

    await expect(store.ensure(1)).rejects.toThrow('[capacity]');
    expect(store.count).toBe(0);
    expect(store.diagnostics().spillBytes).toBe(0);
    await store.dispose();
  });

  it('never emits a single row larger than the production 4 MiB segment cap', async () => {
    const runtime = makeRuntime({
      globalHotBytes: DEFAULT_OUTPUT_RETENTION_LIMITS.globalHotBytes,
      globalSpillBytes: DEFAULT_OUTPUT_RETENTION_LIMITS.globalSpillBytes,
    });
    const store = makeStore(
      countingSource(1, () => ({
        value: 'x'.repeat(DEFAULT_OUTPUT_RETENTION_LIMITS.segmentBytes),
      })).iterator,
      { runtime },
    );
    const visited: ResultRow[][] = [];

    await expect(
      store.forEachWindowChunk(0, 1, 0, (window) => visited.push(window.rows)),
    ).rejects.toBeInstanceOf(OutputCapacityError);

    expect(visited).toEqual([]);
    expect(store.count).toBe(0);
    expect(store.diagnostics().spillBytes).toBe(0);
    await store.dispose();
  });

  it('rolls back spill quota when a segment write fails', async () => {
    const runtime = makeRuntime({ globalHotBytes: 1_024, globalSpillBytes: 4_096 });
    const store = makeStore(countingSource(3).iterator, {
      runtime,
      limits: {
        segmentBytes: 256,
        segmentRows: 1,
        perRunHotBytes: 1_024,
        perRunSpillBytes: 4_096,
      },
    });
    await store.ensure(1);
    rmSync(store.diagnostics().runDirectory, { recursive: true, force: true });

    await expect(store.ensure(2)).rejects.toThrow();

    expect(store.diagnostics().spillBytes).toBe(0);
    expect(runtime.diagnostics().spillBytes).toBe(0);
    expect(store.count).toBe(1);
    await store.dispose();
  });

  it('uses random segment names and owner-only POSIX modes beneath the runtime directory', async () => {
    const runtime = makeRuntime();
    const store = makeStore(countingSource(2).iterator, {
      runtime,
      limits: { segmentRows: 1 },
    });
    await store.ensure(2);

    const { runDirectory } = store.diagnostics();
    expect(runDirectory.startsWith(runtime.directory)).toBe(true);
    expect(readdirSync(runDirectory)).toEqual([
      expect.stringMatching(/^segment-[a-f0-9]{32}\.bin$/),
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(runDirectory).mode & 0o077).toBe(0);
      const segment = join(runDirectory, readdirSync(runDirectory)[0]);
      expect(statSync(segment).mode & 0o077).toBe(0);
    }
    await store.dispose();
  });

  it('ships the approved commercial retention defaults', () => {
    expect(DEFAULT_OUTPUT_RETENTION_LIMITS).toMatchObject({
      segmentBytes: 4 * 1024 * 1024,
      segmentRows: 4_096,
      perRunHotBytes: 8 * 1024 * 1024,
      globalHotBytes: 128 * 1024 * 1024,
      perRunSpillBytes: 512 * 1024 * 1024,
      globalSpillBytes: 2 * 1024 * 1024 * 1024,
    });
  });
});
