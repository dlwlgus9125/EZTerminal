import { describe, expect, it } from 'vitest';

import { SessionDirectory } from './session-directory';
import type { SessionInfo } from '../shared/ipc';

describe('SessionDirectory', () => {
  it('starts empty', () => {
    expect(new SessionDirectory().list()).toEqual([]);
  });

  it('add() makes a session appear in list()', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    expect(dir.list()).toMatchObject([{ sessionId: 's1', cwd: '/home/a' }]);
  });

  it('remove() drops a session from list()', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    dir.add({ sessionId: 's2', cwd: '/home/b' });
    dir.remove('s1');
    expect(dir.list()).toMatchObject([{ sessionId: 's2', cwd: '/home/b' }]);
  });

  it('remove() on an unknown sessionId is a no-op', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    dir.remove('does-not-exist');
    expect(dir.list()).toMatchObject([{ sessionId: 's1', cwd: '/home/a' }]);
  });

  it('announces the same birth time it keeps', async () => {
    // A client that learns about a session from the push and one that learns
    // from list() must agree on how old it is, or a pane's age would jump the
    // first time the list is re-read.
    const dir = new SessionDirectory();
    const added: SessionInfo[] = [];
    dir.onSessionAdded((session) => added.push(session));
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    await new Promise((resolve) => setImmediate(resolve));

    const listed = dir.list()[0];
    expect(typeof listed?.createdAt).toBe('number');
    expect(added[0]?.createdAt).toBe(listed?.createdAt);
  });

  it('keeps a caller-supplied birth time rather than inventing one', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a', createdAt: 1_700_000_000_000 });
    expect(dir.list()[0]?.createdAt).toBe(1_700_000_000_000);
  });

  it('list() orders sessions oldest-created-first', async () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 'first', cwd: '/a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    dir.add({ sessionId: 'second', cwd: '/b' });
    expect(dir.list().map((s) => s.sessionId)).toEqual(['first', 'second']);
  });

  it('a genuinely new add() fires onSessionAdded exactly once', async () => {
    const dir = new SessionDirectory();
    const added: SessionInfo[] = [];
    dir.onSessionAdded((session) => added.push(session));

    dir.add({ sessionId: 's1', cwd: '/home/a' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(added).toMatchObject([{ sessionId: 's1', cwd: '/home/a' }]);
    expect(added).toHaveLength(1);
  });

  it('remove() called twice for the same sessionId fires onSessionRemoved exactly once', async () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    const removed: string[] = [];
    dir.onSessionRemoved((sessionId) => removed.push(sessionId));

    dir.remove('s1');
    dir.remove('s1'); // redundant second call (e.g. two listeners both reacting to one destroy) must not double-fire
    await new Promise((resolve) => setImmediate(resolve));

    expect(removed).toEqual(['s1']);
  });

  it('updates an existing cwd without resurrecting a removed session', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's-cwd', cwd: '/initial' });
    dir.updateCwd('s-cwd', '/after-cd');
    expect(dir.list()).toMatchObject([{ sessionId: 's-cwd', cwd: '/after-cd' }]);
    dir.remove('s-cwd');
    dir.updateCwd('s-cwd', '/late-settle');
    expect(dir.list()).toEqual([]);
  });
});
