import { describe, expect, it } from 'vitest';

import { initialTabsState, tabsReducer, type TabsState } from './tabs';

function open(state: TabsState, sessionId: string, cwd: string): TabsState {
  return tabsReducer(state, { type: 'open', sessionId, cwd });
}

describe('tabsReducer', () => {
  it('open adds a new tab and activates it', () => {
    const s1 = open(initialTabsState, 'a', '/home/a');
    expect(s1.tabs).toEqual([{ sessionId: 'a', cwd: '/home/a' }]);
    expect(s1.activeSessionId).toBe('a');

    const s2 = open(s1, 'b', '/home/b');
    expect(s2.tabs).toEqual([
      { sessionId: 'a', cwd: '/home/a' },
      { sessionId: 'b', cwd: '/home/b' },
    ]);
    expect(s2.activeSessionId).toBe('b');
  });

  it('open dedupes an already-open session, just re-activating it', () => {
    const s1 = open(open(initialTabsState, 'a', '/a'), 'b', '/b');
    const s2 = open(s1, 'a', '/a-changed');
    expect(s2.tabs).toEqual([
      { sessionId: 'a', cwd: '/a' }, // unchanged — no duplicate, no cwd overwrite
      { sessionId: 'b', cwd: '/b' },
    ]);
    expect(s2.activeSessionId).toBe('a');
  });

  it('activate switches the active tab without changing the tab list', () => {
    const s1 = open(open(initialTabsState, 'a', '/a'), 'b', '/b');
    const s2 = tabsReducer(s1, { type: 'activate', sessionId: 'a' });
    expect(s2.tabs).toEqual(s1.tabs);
    expect(s2.activeSessionId).toBe('a');
  });

  it('activate is a no-op for an unknown sessionId', () => {
    const s1 = open(initialTabsState, 'a', '/a');
    const s2 = tabsReducer(s1, { type: 'activate', sessionId: 'ghost' });
    expect(s2).toEqual(s1);
  });

  it('close on a middle, non-active tab leaves the active tab untouched', () => {
    let s = open(initialTabsState, 'a', '/a');
    s = open(s, 'b', '/b');
    s = open(s, 'c', '/c');
    s = tabsReducer(s, { type: 'activate', sessionId: 'a' });
    const s2 = tabsReducer(s, { type: 'close', sessionId: 'b' });
    expect(s2.tabs.map((t) => t.sessionId)).toEqual(['a', 'c']);
    expect(s2.activeSessionId).toBe('a');
  });

  it('close on the active middle tab activates its left neighbor', () => {
    let s = open(initialTabsState, 'a', '/a');
    s = open(s, 'b', '/b');
    s = open(s, 'c', '/c');
    s = tabsReducer(s, { type: 'activate', sessionId: 'b' });
    const s2 = tabsReducer(s, { type: 'close', sessionId: 'b' });
    expect(s2.tabs.map((t) => t.sessionId)).toEqual(['a', 'c']);
    expect(s2.activeSessionId).toBe('a');
  });

  it('close on the active leftmost tab falls back to the new first tab', () => {
    let s = open(initialTabsState, 'a', '/a');
    s = open(s, 'b', '/b');
    s = tabsReducer(s, { type: 'activate', sessionId: 'a' });
    const s2 = tabsReducer(s, { type: 'close', sessionId: 'a' });
    expect(s2.tabs.map((t) => t.sessionId)).toEqual(['b']);
    expect(s2.activeSessionId).toBe('b');
  });

  it('close on the last remaining tab leaves no active tab', () => {
    const s1 = open(initialTabsState, 'only', '/only');
    const s2 = tabsReducer(s1, { type: 'close', sessionId: 'only' });
    expect(s2.tabs).toEqual([]);
    expect(s2.activeSessionId).toBeNull();
  });

  it('close is a no-op for an unknown sessionId', () => {
    const s1 = open(initialTabsState, 'a', '/a');
    const s2 = tabsReducer(s1, { type: 'close', sessionId: 'ghost' });
    expect(s2).toEqual(s1);
  });

  it('sessionDied behaves like close (active tab -> left neighbor)', () => {
    let s = open(initialTabsState, 'a', '/a');
    s = open(s, 'b', '/b');
    s = open(s, 'c', '/c');
    s = tabsReducer(s, { type: 'activate', sessionId: 'c' });
    const s2 = tabsReducer(s, { type: 'sessionDied', sessionId: 'c' });
    expect(s2.tabs.map((t) => t.sessionId)).toEqual(['a', 'b']);
    expect(s2.activeSessionId).toBe('b');
  });
});
