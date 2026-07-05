import { describe, expect, it } from 'vitest';

import { SessionDirectory } from './session-directory';

describe('SessionDirectory', () => {
  it('starts empty', () => {
    expect(new SessionDirectory().list()).toEqual([]);
  });

  it('add() makes a session appear in list()', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    expect(dir.list()).toEqual([{ sessionId: 's1', cwd: '/home/a' }]);
  });

  it('remove() drops a session from list()', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    dir.add({ sessionId: 's2', cwd: '/home/b' });
    dir.remove('s1');
    expect(dir.list()).toEqual([{ sessionId: 's2', cwd: '/home/b' }]);
  });

  it('remove() on an unknown sessionId is a no-op', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    dir.remove('does-not-exist');
    expect(dir.list()).toEqual([{ sessionId: 's1', cwd: '/home/a' }]);
  });

  it('list() orders sessions oldest-created-first', async () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 'first', cwd: '/a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    dir.add({ sessionId: 'second', cwd: '/b' });
    expect(dir.list().map((s) => s.sessionId)).toEqual(['first', 'second']);
  });

  it('add() with the same sessionId again overwrites (idempotent re-add)', () => {
    const dir = new SessionDirectory();
    dir.add({ sessionId: 's1', cwd: '/home/a' });
    dir.add({ sessionId: 's1', cwd: '/home/changed' });
    expect(dir.list()).toEqual([{ sessionId: 's1', cwd: '/home/changed' }]);
  });
});
