import { describe, expect, it, vi } from 'vitest';

import { ShellNavigation, parseShellNavigation, projectTabs } from './navigation-store';

describe('ShellNavigation', () => {
  it('starts on the board and enters work mode when something is opened', () => {
    const navigation = new ShellNavigation();
    expect(navigation.getSnapshot()).toEqual({ mode: 'board', projectId: null });
    navigation.showBoard('p1');
    navigation.showWork();
    expect(navigation.getSnapshot()).toEqual({ mode: 'work', projectId: 'p1' });
    navigation.showWork('p2');
    expect(navigation.getSnapshot()).toEqual({ mode: 'work', projectId: 'p2' });
  });

  it('follows the active tab to another project but keeps the project for a tab without one', () => {
    const navigation = new ShellNavigation({ mode: 'work', projectId: 'p1' });
    navigation.followPanel(undefined);
    expect(navigation.getSnapshot().projectId).toBe('p1');
    navigation.followPanel('p2');
    expect(navigation.getSnapshot()).toEqual({ mode: 'work', projectId: 'p2' });
  });

  it('persists and notifies only on a real change', () => {
    const persist = vi.fn();
    const listener = vi.fn();
    const navigation = new ShellNavigation({ mode: 'board', projectId: 'p1' }, persist);
    navigation.subscribe(listener);
    navigation.showBoard('p1');
    navigation.followPanel('p1');
    expect(persist).not.toHaveBeenCalled();
    navigation.showWork();
    expect(persist).toHaveBeenCalledWith({ mode: 'work', projectId: 'p1' });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('forgets a project that went away', () => {
    const navigation = new ShellNavigation({ mode: 'board', projectId: 'p1' });
    navigation.forgetProject('p2');
    expect(navigation.getSnapshot().projectId).toBe('p1');
    navigation.forgetProject('p1');
    expect(navigation.getSnapshot().projectId).toBeNull();
  });

  it('reads a stored state defensively', () => {
    expect(parseShellNavigation({ mode: 'work', projectId: 'p1' })).toEqual({ mode: 'work', projectId: 'p1' });
    expect(parseShellNavigation({ mode: 'x', projectId: 3 })).toEqual({ mode: 'board', projectId: null });
    expect(parseShellNavigation(null)).toEqual({ mode: 'board', projectId: null });
  });
});

describe('projectTabs', () => {
  const project = (projectId: string, pinned: boolean, lastActiveAt: string) => ({ projectId, name: projectId, pinned, lastActiveAt });

  it('puts pinned projects first, then the most recent, up to the limit', () => {
    const tabs = projectTabs([
      project('old', false, '2026-01-01'), project('pinned', true, '2025-01-01'),
      project('new', false, '2026-10-01'), project('mid', false, '2026-05-01'),
    ], null, 3);
    expect(tabs.map((tab) => tab.projectId)).toEqual(['pinned', 'new', 'mid']);
  });

  it('always keeps a tab for the selected project', () => {
    const tabs = projectTabs([
      project('a', false, '2026-10-03'), project('b', false, '2026-10-02'), project('c', false, '2026-01-01'),
    ], 'c', 2);
    expect(tabs.map((tab) => tab.projectId)).toEqual(['a', 'c']);
  });
});
