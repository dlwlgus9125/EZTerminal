import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TURN_WRAP_UP_TOLD_THREADS_FILE, TurnWrapUpToldThreads } from './turn-wrap-up-told-threads';

const makeDir = (): string => mkdtempSync(path.join(tmpdir(), 'ezterm-told-threads-'));

describe('TurnWrapUpToldThreads', () => {
  it('remembers a thread across restarts', async () => {
    const dir = makeDir();
    const first = new TurnWrapUpToldThreads(dir);
    await first.init();
    expect(first.has('thread-1')).toBe(false);
    first.add('thread-1');
    first.add('thread-1');
    first.add('thread-2');
    expect(first.has('thread-1')).toBe(true);
    await first.flush();

    const second = new TurnWrapUpToldThreads(dir);
    await second.init();
    expect(second.has('thread-1')).toBe(true);
    expect(second.has('thread-2')).toBe(true);
    expect(second.has('thread-3')).toBe(false);
  });

  it('counts every thread as told until it has loaded, so a slow start cannot tell a thread twice', async () => {
    const dir = makeDir();
    const earlier = new TurnWrapUpToldThreads(dir);
    await earlier.init();
    earlier.add('thread-old');
    await earlier.flush();

    const store = new TurnWrapUpToldThreads(dir);
    expect(store.has('thread-old')).toBe(true);
    expect(store.has('thread-never-told')).toBe(true);
    store.add('thread-started-early');
    await store.init();
    expect(store.has('thread-never-told')).toBe(false);
    expect(store.has('thread-old')).toBe(true);
    expect(store.has('thread-started-early')).toBe(true);
    await store.flush();

    const reloaded = new TurnWrapUpToldThreads(dir);
    await reloaded.init();
    expect(reloaded.has('thread-started-early')).toBe(true);
  });

  it('starts empty from a missing or unreadable file: a thread told again only gains one more instruction', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, TURN_WRAP_UP_TOLD_THREADS_FILE), '{"version":9}');
    const store = new TurnWrapUpToldThreads(dir);
    await store.init();
    expect(store.has('thread-1')).toBe(false);
    store.add('thread-1');
    await store.flush();
    expect(store.has('thread-1')).toBe(true);
  });

  it('keeps the latest threads when the file would grow past its bound', async () => {
    const dir = makeDir();
    const store = new TurnWrapUpToldThreads(dir, { maxThreads: 3 });
    await store.init();
    for (const id of ['a', 'b', 'c', 'd']) store.add(id);
    await store.flush();
    const reloaded = new TurnWrapUpToldThreads(dir, { maxThreads: 3 });
    await reloaded.init();
    expect(['a', 'b', 'c', 'd'].map((id) => reloaded.has(id))).toEqual([false, true, true, true]);
  });
});
