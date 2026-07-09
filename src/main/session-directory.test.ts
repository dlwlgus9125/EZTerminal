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

  it('a genuinely new add() fires onSessionAdded exactly once', async () => {
    const dir = new SessionDirectory();
    const added: SessionInfo[] = [];
    dir.onSessionAdded((session) => added.push(session));

    dir.add({ sessionId: 's1', cwd: '/home/a' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(added).toEqual([{ sessionId: 's1', cwd: '/home/a' }]);
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
});
