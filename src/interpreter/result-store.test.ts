import { describe, expect, it } from 'vitest';

import type { ResultRow } from '../shared/ipc';
import { ResultStore } from './result-store';

/**
 * A synthetic row source that counts how many times it is advanced. This is the
 * load-bearing assertion for credit/backpressure: a huge source must NOT be fully
 * pulled just to serve a small window.
 */
function countingSource(total: number): { iterator: AsyncIterator<ResultRow>; pulls: () => number } {
  let pulled = 0;
  let i = 0;
  const iterator: AsyncIterator<ResultRow> = {
    next(): Promise<IteratorResult<ResultRow>> {
      if (i >= total) return Promise.resolve({ done: true, value: undefined });
      pulled += 1;
      const value: ResultRow = { n: i };
      i += 1;
      return Promise.resolve({ done: false, value });
    },
  };
  return { iterator, pulls: () => pulled };
}

describe('ResultStore — credit/window', () => {
  it('serves only the requested window and pulls only what that window needs', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = new ResultStore(iterator);

    const window = await store.getWindow(0, 50);

    expect(window.start).toBe(0);
    expect(window.rows).toHaveLength(50);
    expect(window.rows[0]).toEqual({ n: 0 });
    expect(window.rows[49]).toEqual({ n: 49 });
    // The 100k source was advanced exactly 50 times — never drained to serve a window.
    expect(pulls()).toBe(50);
    expect(store.exhausted).toBe(false);
  });

  it('serves an interior window, pulling up to its end only', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = new ResultStore(iterator);

    const window = await store.getWindow(100, 50);

    expect(window.start).toBe(100);
    expect(window.rows[0]).toEqual({ n: 100 });
    expect(window.rows).toHaveLength(50);
    expect(pulls()).toBe(150); // 0..149
  });

  it('read-ahead buffers extra rows but never returns more than `count`', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = new ResultStore(iterator);

    const window = await store.getWindow(0, 10, 40);

    expect(window.rows).toHaveLength(10); // only the granted window is returned
    expect(pulls()).toBe(50); // 10 + 40 read-ahead were buffered
    expect(store.count).toBe(50);
  });

  it('clamps the final window and reports exhaustion', async () => {
    const { iterator } = countingSource(100_000);
    const store = new ResultStore(iterator);

    await store.ensure(200_000); // drain
    expect(store.count).toBe(100_000);
    expect(store.exhausted).toBe(true);

    const tail = await store.getWindow(99_980, 50);
    expect(tail.rows).toHaveLength(20); // only 99_980..99_999 exist
    expect(tail.rows[19]).toEqual({ n: 99_999 });
  });

  it('serializes concurrent ensure calls (single iterator, no double-advance)', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = new ResultStore(iterator);

    await Promise.all([store.getWindow(0, 30), store.getWindow(0, 60), store.ensure(45)]);

    // The deepest target (60) wins; nothing is pulled twice.
    expect(store.count).toBe(60);
    expect(pulls()).toBe(60);
  });

  it('dispose stops further consumption', async () => {
    const { iterator, pulls } = countingSource(100_000);
    const store = new ResultStore(iterator);

    await store.getWindow(0, 10);
    await store.dispose();
    await store.ensure(1000);

    expect(store.exhausted).toBe(true);
    expect(pulls()).toBe(10); // no pulls after dispose
  });
});
